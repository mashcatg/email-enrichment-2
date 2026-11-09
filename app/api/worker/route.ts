import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { extractBestEmail } from "@/lib/email";
import { isWebsiteLoadError } from "@/lib/firecrawl-errors";
import { downloadPrivateJson, uploadPrivateJson, type JobInputEntry, type JobResultEntry } from "@/lib/hosted-jobs";
import { createSupabaseAdminClient, getAuthorizedUser } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 300;

interface ClaimedChunk {
  job_id: string;
  chunk_index: number;
  start_index: number;
  end_index: number;
  next_index: number;
  assigned_key_index: number;
  input_blob: string;
}

interface FirecrawlResponse {
  success?: boolean;
  data?: { markdown?: string; html?: string };
  error?: string;
}

class InvalidWebsiteError extends Error {}

class WebsiteUnavailableError extends Error {}

class FirecrawlRequestError extends Error {
  constructor(
    message: string,
    readonly shouldPauseKey: boolean,
  ) {
    super(message);
    this.name = "FirecrawlRequestError";
  }
}

let activeWorkerRun: Promise<NextResponse> | null = null;

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  const authorization = request.headers.get("authorization") ?? "";
  if (!secret || !authorization.startsWith("Bearer ")) return false;
  const provided = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(secret);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function configuredKeys() {
  return Array.from({ length: 10 }, (_, index) => ({
    index: index + 1,
    key: process.env[`FIRECRAWL_API_KEY_${index + 1}`]?.trim(),
  })).filter((item): item is { index: number; key: string } => Boolean(item.key));
}

function normalizeWebsite(input: string) {
  try {
    const value = /^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`;
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
      throw new InvalidWebsiteError("Website URLs must use a valid HTTP or HTTPS address.");
    }
    return `${url.protocol}//${url.hostname.replace(/^www\./i, "").toLowerCase()}${url.port ? `:${url.port}` : ""}/`;
  } catch (error) {
    if (error instanceof InvalidWebsiteError) throw error;
    throw new InvalidWebsiteError("This row has an invalid website URL.");
  }
}

async function wait(milliseconds: number) {
  if (milliseconds > 0) await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function scrape(website: string, apiKey: string): Promise<string | null> {
  const url = normalizeWebsite(website);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    let response: Response;
    try {
      response = await fetch("https://api.firecrawl.dev/v2/scrape", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ url, formats: ["markdown", "html"], onlyMainContent: false }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new FirecrawlRequestError(
        error instanceof Error ? `Could not connect to Firecrawl: ${error.message}` : "Could not connect to Firecrawl.",
        true,
      );
    }

    let payload: FirecrawlResponse;
    try {
      payload = await response.json() as FirecrawlResponse;
    } catch {
      throw new FirecrawlRequestError(
        `Firecrawl returned an unreadable response (${response.status}).`,
        response.status >= 500 || response.status === 429,
      );
    }
    if (!response.ok || payload.success === false) {
      const errorMessage = payload.error ?? response.statusText;
      const websiteLoadError = isWebsiteLoadError(errorMessage);
      if (websiteLoadError) throw new WebsiteUnavailableError();
      const keyWideStatus = [401, 402, 403, 429].includes(response.status)
        || [500, 502, 503, 504].includes(response.status);
      throw new FirecrawlRequestError(
        `Firecrawl request failed (${response.status}): ${errorMessage}`,
        keyWideStatus,
      );
    }
    return extractBestEmail([payload.data?.markdown, payload.data?.html].filter(Boolean).join("\n"), url);
  } finally {
    clearTimeout(timeout);
  }
}

async function processClaim(supabase: ReturnType<typeof createSupabaseAdminClient>, claim: ClaimedChunk) {
  const keyIndex = claim.assigned_key_index;
  const apiKey = process.env[`FIRECRAWL_API_KEY_${keyIndex}`]?.trim();
  if (!apiKey) {
    await supabase.rpc("pause_firecrawl_key", {
      p_key_index: keyIndex,
      p_job_id: claim.job_id,
      p_chunk_index: claim.chunk_index,
      p_message: `FIRECRAWL_API_KEY_${keyIndex} is not configured on the server.`,
    });
    return;
  }

  let entries: JobInputEntry[];
  try {
    const input = await downloadPrivateJson<{ entries: JobInputEntry[] }>(claim.input_blob);
    entries = input.entries;
  } catch (error) {
    await supabase.from("enrichment_chunks").update({ state: "queued", lease_until: null })
      .eq("job_id", claim.job_id).eq("chunk_index", claim.chunk_index);
    throw error;
  }

  const entry = entries[claim.next_index];
  if (!entry || !Number.isInteger(entry.rowIndex)) {
    throw new Error(`Input row ${claim.next_index} is missing from job ${claim.job_id}.`);
  }

  const { data: currentKey, error: keyError } = await supabase.from("firecrawl_key_health")
    .select("state").eq("key_index", keyIndex).maybeSingle();
  if (keyError) throw keyError;
  if (currentKey?.state !== "active") {
    const { error: releaseError } = await supabase.from("enrichment_chunks").update({
      state: "queued",
      assigned_key_index: null,
      lease_until: null,
    }).eq("job_id", claim.job_id).eq("chunk_index", claim.chunk_index);
    if (releaseError) throw releaseError;
    return;
  }

  let result: JobResultEntry;
  try {
    const email = await scrape(entry.website, apiKey);
    result = { rowIndex: entry.rowIndex, email: email ?? "", status: email ? "complete" : "not_found" };
  } catch (error) {
    if (error instanceof InvalidWebsiteError) {
      result = {
        rowIndex: entry.rowIndex,
        email: "",
        status: "failed",
        error: error.message,
      };
    } else if (error instanceof WebsiteUnavailableError) {
      result = { rowIndex: entry.rowIndex, email: "", status: "not_found" };
    } else if (error instanceof FirecrawlRequestError && error.shouldPauseKey) {
      await supabase.rpc("pause_firecrawl_key", {
        p_key_index: keyIndex,
        p_job_id: claim.job_id,
        p_chunk_index: claim.chunk_index,
        p_message: error instanceof Error ? error.message : "Unknown Firecrawl error.",
      });
      return;
    } else {
      result = {
        rowIndex: entry.rowIndex,
        email: "",
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown website scrape error.",
      };
    }
  }

  const resultPath = claim.input_blob.replace(/input\.json$/, `results/${String(entry.rowIndex).padStart(8, "0")}.json`);
  await uploadPrivateJson(resultPath, result);
  const { error } = await supabase.rpc("complete_enrichment_row", {
    p_job_id: claim.job_id,
    p_chunk_index: claim.chunk_index,
    p_row_index: claim.next_index,
    p_result: result.status,
  });
  if (error) throw error;
}

export async function GET(request: Request) {
  if (!await canRunWorker(request)) return NextResponse.json({ error: "Unauthorized worker request." }, { status: 401 });
  return runWorker();
}

export async function POST(request: Request) {
  if (!await canRunWorker(request)) return NextResponse.json({ error: "Unauthorized worker request." }, { status: 401 });
  return runWorker();
}

async function canRunWorker(request: Request): Promise<boolean> {
  if (isAuthorized(request)) return true;
  return Boolean(await getAuthorizedUser());
}

function runWorker() {
  if (activeWorkerRun) {
    return Promise.resolve(NextResponse.json({ processed: 0, message: "Worker is already running." }));
  }
  activeWorkerRun = runWorkerBatch();
  return activeWorkerRun.finally(() => {
    activeWorkerRun = null;
  });
}

async function runWorkerBatch() {
  const configured = configuredKeys();
  const supabase = createSupabaseAdminClient();
  const { data: keyRows, error: keyError } = await supabase.from("firecrawl_key_health")
    .select("key_index,state").in("key_index", configured.map(({ index }) => index));
  if (keyError) {
    console.error("Worker could not load Firecrawl key state:", keyError);
    return NextResponse.json({ error: "Could not load Firecrawl key state." }, { status: 500 });
  }
  const activeKeyIndices = (keyRows ?? []).filter((row) => row.state === "active").map((row) => row.key_index);
  if (activeKeyIndices.length === 0) {
    await supabase.from("enrichment_jobs").update({ status: "waiting_for_keys", updated_at: new Date().toISOString() })
      .in("status", ["queued", "running"]);
    return NextResponse.json({ processed: 0, message: "No active Firecrawl API keys are configured." });
  }

  const maxConcurrency = Math.min(10, Math.max(1, Number(process.env.FIRECRAWL_CONCURRENCY) || 2));
  const maxRpm = Math.min(600, Math.max(1, Number(process.env.FIRECRAWL_MAX_RPM) || 10));
  const requestInterval = Math.ceil(60_000 / maxRpm);
  const startedAt = Date.now();
  const deadline = startedAt + 165_000;
  let processed = 0;
  let workerError: string | null = null;

  const worker = async () => {
    while (Date.now() < deadline) {
      const { data, error } = await supabase.rpc("claim_enrichment_chunk", {
        p_active_key_indices: activeKeyIndices,
        p_lease_seconds: 180,
      });
      if (error) throw error;
      const claim = (data as ClaimedChunk[] | null)?.[0];
      if (!claim) return;
      try {
        const { data: waitMs, error: slotError } = await supabase.rpc("reserve_firecrawl_slot", {
          p_interval_ms: requestInterval,
        });
        if (slotError) throw slotError;
        await wait(Number(waitMs) || 0);
        if (Date.now() >= deadline) {
          const { error: releaseError } = await supabase.from("enrichment_chunks").update({
            state: "queued",
            assigned_key_index: null,
            lease_until: null,
          }).eq("job_id", claim.job_id).eq("chunk_index", claim.chunk_index);
          if (releaseError) throw releaseError;
          return;
        }
        await processClaim(supabase, claim);
        processed += 1;
      } catch (error) {
        workerError = error instanceof Error ? error.message : "Unexpected worker error.";
        console.error("Enrichment worker failed:", error);
        await supabase.from("enrichment_chunks").update({ state: "queued", lease_until: null })
          .eq("job_id", claim.job_id).eq("chunk_index", claim.chunk_index);
        return;
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: maxConcurrency }, () => worker()));
  } catch (error) {
    console.error("Could not claim enrichment work:", error);
    return NextResponse.json({ error: "Could not claim enrichment work." }, { status: 500 });
  }
  return NextResponse.json({ processed, workerError, activeKeys: activeKeyIndices.length });
}
