import { NextResponse } from "next/server";
import { downloadPrivateJson, listPrivateJson, type JobResultEntry } from "@/lib/hosted-jobs";
import { createSupabaseAdminClient, getAuthorizedUser } from "@/lib/supabase/server";

export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  const user = await getAuthorizedUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { jobId } = await context.params;
  const supabase = createSupabaseAdminClient();
  const { data: job, error } = await supabase.from("enrichment_jobs")
    .select("id,status").eq("id", jobId).eq("owner_id", user.id).maybeSingle();
  if (error) {
    console.error("Could not authorize enrichment result access:", error);
    return NextResponse.json({ error: "Could not load enrichment results." }, { status: 500 });
  }
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });

  try {
    const prefix = `jobs/${user.id}/${jobId}/results/`;
    const paths = await listPrivateJson(prefix);
    const results: JobResultEntry[] = await Promise.all(paths.map((path) => downloadPrivateJson<JobResultEntry>(path)));
    return NextResponse.json({ status: job.status, results });
  } catch (resultError) {
    console.error("Could not read private enrichment results:", resultError);
    return NextResponse.json({ error: "Could not load enrichment results." }, { status: 500 });
  }
}
