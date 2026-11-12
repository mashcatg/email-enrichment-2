import { NextResponse } from "next/server";
import { createSupabaseAdminClient, getAuthorizedUser } from "@/lib/supabase/server";

export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  const user = await getAuthorizedUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { jobId } = await context.params;
  const supabase = createSupabaseAdminClient();
  const [{ data: job, error }, { data: chunks, error: chunkError }] = await Promise.all([
    supabase.from("enrichment_jobs").select(
      "id,file_name,total_count,completed_count,found_count,not_found_count,failed_count,status,created_at,updated_at",
    ).eq("id", jobId).eq("owner_id", user.id).maybeSingle(),
    supabase.from("enrichment_chunks").select("chunk_index,state,assigned_key_index")
      .eq("job_id", jobId),
  ]);
  if (error || chunkError) {
    console.error("Could not read enrichment job:", error ?? chunkError);
    return NextResponse.json({ error: "Could not load job status." }, { status: 500 });
  }
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  return NextResponse.json({ ...job, chunks });
}

export async function PATCH(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const user = await getAuthorizedUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  let body: { action?: unknown };
  try {
    body = await request.json() as { action?: unknown };
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  if (body?.action !== "pause" && body?.action !== "resume") {
    return NextResponse.json({ error: 'Action must be "pause" or "resume".' }, { status: 400 });
  }

  const { jobId } = await context.params;
  const supabase = createSupabaseAdminClient();
  const targetStatus = body.action === "pause" ? "paused" : "queued";
  const allowedStatuses = body.action === "pause"
    ? ["queued", "running"]
    : ["paused"];
  const { data: job, error } = await supabase.from("enrichment_jobs")
    .update({ status: targetStatus, updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("owner_id", user.id)
    .in("status", allowedStatuses)
    .select("id,status,completed_count,total_count")
    .maybeSingle();

  if (error) {
    console.error(`Could not ${body.action} enrichment job:`, error);
    if (error.code === "23514") {
      return NextResponse.json({
        error: "Campaign pause is not enabled in the database yet. Apply supabase/migrations/20261112140000_pause_enrichment_jobs.sql in the Supabase SQL Editor, then retry.",
      }, { status: 503 });
    }
    return NextResponse.json({ error: `Could not ${body.action} this campaign.` }, { status: 500 });
  }
  if (job) return NextResponse.json(job);

  const { data: currentJob, error: readError } = await supabase.from("enrichment_jobs")
    .select("id,status,completed_count,total_count")
    .eq("id", jobId)
    .eq("owner_id", user.id)
    .maybeSingle();
  if (readError) {
    console.error("Could not verify enrichment job state:", readError);
    return NextResponse.json({ error: "Could not verify campaign state." }, { status: 500 });
  }
  if (!currentJob) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  if ((body.action === "pause" && currentJob.status === "paused")
    || (body.action === "resume" && currentJob.status === "queued")) {
    return NextResponse.json(currentJob);
  }
  return NextResponse.json({ error: `Cannot ${body.action} a ${currentJob.status} campaign.` }, { status: 409 });
}
