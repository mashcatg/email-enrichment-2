import { NextResponse } from "next/server";
import { getAuthorizedUser } from "@/lib/supabase/server";

export const runtime = "nodejs";

interface ApifyRunResponse {
  data?: {
    id?: string;
    status?: string;
    statusMessage?: string;
    defaultDatasetId?: string;
  };
  error?: { message?: string };
}

export async function GET(_request: Request, context: { params: Promise<{ runId: string }> }) {
  if (!await getAuthorizedUser()) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const token = process.env.APIFY_API_TOKEN?.trim();
  if (!token) {
    return NextResponse.json({ error: "APIFY_API_TOKEN is not configured on the server." }, { status: 503 });
  }
  const { runId } = await context.params;
  if (!/^[\w-]{1,100}$/.test(runId)) {
    return NextResponse.json({ error: "Apify run ID is invalid." }, { status: 400 });
  }

  let response: Response;
  try {
    response = await fetch(`https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    console.error("Could not check Apify prospect search:", error);
    return NextResponse.json({ error: "Could not connect to Apify to check the prospect search." }, { status: 502 });
  }

  let result: ApifyRunResponse;
  try {
    result = await response.json() as ApifyRunResponse;
  } catch {
    return NextResponse.json({ error: `Apify returned an unreadable response (${response.status}).` }, { status: 502 });
  }
  if (!response.ok || !result.data?.status) {
    console.error("Apify could not read the prospect run:", response.status, result.error?.message);
    return NextResponse.json({
      error: result.error?.message ?? `Apify could not read this run (${response.status}).`,
    }, { status: 502 });
  }

  const status = result.data.status;
  if (status !== "SUCCEEDED") {
    if (["FAILED", "ABORTED", "TIMED-OUT"].includes(status)) {
      return NextResponse.json({
        id: result.data.id ?? runId,
        status,
        statusMessage: result.data.statusMessage ?? `Apify run ${status.toLowerCase()}.`,
      });
    }
    return NextResponse.json({
      id: result.data.id ?? runId,
      status,
      statusMessage: result.data.statusMessage ?? null,
    });
  }
  if (!result.data.defaultDatasetId) {
    return NextResponse.json({ error: "Apify finished without a results dataset." }, { status: 502 });
  }

  let datasetResponse: Response;
  try {
    const url = new URL(`https://api.apify.com/v2/datasets/${encodeURIComponent(result.data.defaultDatasetId)}/items`);
    url.searchParams.set("format", "json");
    url.searchParams.set("clean", "1");
    url.searchParams.set("limit", "1000");
    url.searchParams.set("offset", "0");
    url.searchParams.set("fields", "title,categoryName,website,phone,street,city,state,postalCode,address,totalScore,reviewsCount,url,placeId");
    datasetResponse = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    console.error("Could not download Apify prospect results:", error);
    return NextResponse.json({ error: "Could not connect to Apify to download prospect results." }, { status: 502 });
  }

  if (!datasetResponse.ok) {
    console.error("Apify dataset request failed:", datasetResponse.status);
    return NextResponse.json({ error: `Could not download Apify results (${datasetResponse.status}).` }, { status: 502 });
  }

  let firstPage: unknown;
  try {
    firstPage = await datasetResponse.json();
  } catch {
    return NextResponse.json({ error: "Apify returned invalid prospect data." }, { status: 502 });
  }
  if (!Array.isArray(firstPage)) {
    return NextResponse.json({ error: "Apify returned an unexpected results format." }, { status: 502 });
  }

  const items: unknown[] = [...firstPage];
  for (let offset = firstPage.length; firstPage.length === 1000; offset += 1000) {
    let pageResponse: Response;
    try {
      const url = new URL(`https://api.apify.com/v2/datasets/${encodeURIComponent(result.data.defaultDatasetId)}/items`);
      url.searchParams.set("format", "json");
      url.searchParams.set("clean", "1");
      url.searchParams.set("limit", "1000");
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("fields", "title,categoryName,website,phone,street,city,state,postalCode,address,totalScore,reviewsCount,url,placeId");
      pageResponse = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      console.error("Could not download the next Apify results page:", error);
      return NextResponse.json({ error: "Could not connect to Apify to download all prospect results." }, { status: 502 });
    }

    if (!pageResponse.ok) {
      console.error("Apify dataset pagination failed:", pageResponse.status);
      return NextResponse.json({ error: `Could not download all Apify results (${pageResponse.status}).` }, { status: 502 });
    }

    let page: unknown;
    try {
      page = await pageResponse.json();
    } catch {
      return NextResponse.json({ error: "Apify returned invalid prospect data." }, { status: 502 });
    }
    if (!Array.isArray(page)) {
      return NextResponse.json({ error: "Apify returned an unexpected results format." }, { status: 502 });
    }
    items.push(...page);
    if (page.length < 1000) break;
  }

  return NextResponse.json({
    id: result.data.id ?? runId,
    status,
    statusMessage: result.data.statusMessage ?? null,
    items,
  });
}
