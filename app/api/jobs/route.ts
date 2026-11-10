import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { deletePrivateJson, listPrivateJson, uploadPrivateJson } from "@/lib/hosted-jobs";
import { createSupabaseAdminClient, getAuthorizedUser } from "@/lib/supabase/server";

export const runtime = "nodejs";

interface CreateJobBody {
  fileName: string;
  entries: Array<{ rowIndex: number; website: string }>;
}

export async function DELETE(request: Request) {
  const user = await getAuthorizedUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  let body: { fileName?: unknown };
  try {
    body = await request.json() as { fileName?: unknown };
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  if (!body || typeof body.fileName !== "string" || !body.fileName.trim() || body.fileName.length > 255) {
    return NextResponse.json({ error: "A valid CSV file name is required." }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();
  const { data: jobs, error: loadError } = await supabase.from("enrichment_jobs")
    .select("id,input_blob").eq("owner_id", user.id).eq("file_name", body.fileName);
  if (loadError) {
    console.error("Could not load jobs for cleanup:", loadError);
    return NextResponse.json({ error: "Could not load this CSV's server jobs." }, { status: 500 });
  }

  const storagePaths: string[] = [];
  try {
    for (const job of jobs ?? []) {
      const expectedPrefix = `jobs/${user.id}/${job.id}/`;
      if (!job.input_blob.startsWith(expectedPrefix) || !job.input_blob.endsWith("/input.json")) {
        throw new Error(`Job ${job.id} has an unexpected private storage path.`);
      }
      storagePaths.push(job.input_blob);
      storagePaths.push(...await listPrivateJson(`${expectedPrefix}results`));
    }
  } catch (error) {
    console.error("Could not enumerate private job files for cleanup:", error);
    return NextResponse.json({ error: "Could not safely enumerate this CSV's private job files." }, { status: 500 });
  }

  const jobIds = (jobs ?? []).map((job) => job.id);
  if (jobIds.length > 0) {
    const { data: deletedJobs, error: deleteError } = await supabase.from("enrichment_jobs")
      .delete().eq("owner_id", user.id).in("id", jobIds).select("id");
    if (deleteError || deletedJobs?.length !== jobIds.length) {
      console.error("Could not delete all matching enrichment jobs:", deleteError);
      return NextResponse.json({ error: "Could not delete all server jobs for this CSV." }, { status: 500 });
    }
  }

  try {
    await deletePrivateJson(storagePaths);
  } catch (error) {
    console.error("Jobs were deleted, but private files could not all be removed:", error);
    return NextResponse.json({
      error: "Server jobs were deleted, but some private storage files could not be removed.",
    }, { status: 500 });
  }

  return NextResponse.json({ deletedJobs: jobIds.length, deletedFiles: storagePaths.length });
}

export async function POST(request: Request) {
  const user = await getAuthorizedUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  let body: CreateJobBody;
  try {
    body = await request.json() as CreateJobBody;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  const bodyLength = Buffer.byteLength(JSON.stringify(body));
  if (contentLength > 4_000_000 || bodyLength > 4_000_000) {
    return NextResponse.json({ error: "Job input is too large; split this CSV into smaller batches." }, { status: 413 });
  }
  if (
    !body || typeof body.fileName !== "string" || !Array.isArray(body.entries) ||
    body.entries.length === 0 || body.entries.length > 20_000 ||
    body.entries.some((entry) => !entry || typeof entry !== "object" ||
      !Number.isInteger(entry.rowIndex) || entry.rowIndex < 0 ||
      typeof entry.website !== "string" || !entry.website.trim() || entry.website.length > 2048)
  ) {
    return NextResponse.json({ error: "Job input is invalid or exceeds 20,000 websites." }, { status: 400 });
  }
  if (new Set(body.entries.map((entry) => entry.rowIndex)).size !== body.entries.length) {
    return NextResponse.json({ error: "Job input contains duplicate row numbers." }, { status: 400 });
  }

  const id = randomUUID();
  const inputBlob = `jobs/${user.id}/${id}/input.json`;
  const chunkCount = Math.min(10, body.entries.length);
  const supabase = createSupabaseAdminClient();
  let uploaded = false;
  try {
    await uploadPrivateJson(inputBlob, { entries: body.entries });
    uploaded = true;
    const { error: jobError } = await supabase.from("enrichment_jobs").insert({
      id,
      owner_id: user.id,
      file_name: body.fileName.slice(0, 255),
      input_blob: inputBlob,
      total_count: body.entries.length,
      status: "queued",
    });
    if (jobError) throw jobError;

    const chunks = Array.from({ length: chunkCount }, (_, chunkIndex) => ({
      job_id: id,
      chunk_index: chunkIndex,
      start_index: Math.floor(chunkIndex * body.entries.length / chunkCount),
      end_index: Math.floor((chunkIndex + 1) * body.entries.length / chunkCount),
      next_index: Math.floor(chunkIndex * body.entries.length / chunkCount),
    }));
    const { error: chunksError } = await supabase.from("enrichment_chunks").insert(chunks);
    if (chunksError) {
      await supabase.from("enrichment_jobs").delete().eq("id", id).eq("owner_id", user.id);
      throw chunksError;
    }
    return NextResponse.json({ id, totalCount: body.entries.length, chunkCount });
  } catch (error) {
    if (uploaded) {
      try {
        await deletePrivateJson(inputBlob);
      } catch (cleanupError) {
        console.error("Could not remove incomplete enrichment job input:", cleanupError);
      }
    }
    console.error("Could not create enrichment job:", error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Could not save this enrichment job.",
    }, { status: 500 });
  }
}
