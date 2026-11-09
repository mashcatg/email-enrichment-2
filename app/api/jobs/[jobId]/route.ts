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
