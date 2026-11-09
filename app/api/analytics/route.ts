import { NextResponse } from "next/server";
import { isWebsiteLoadError } from "@/lib/firecrawl-errors";
import { createSupabaseAdminClient, getAuthorizedUser } from "@/lib/supabase/server";

export async function GET() {
  const user = await getAuthorizedUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const supabase = createSupabaseAdminClient();
  const [jobs, keys, notifications] = await Promise.all([
    supabase.from("enrichment_jobs")
      .select("id,file_name,total_count,completed_count,found_count,not_found_count,failed_count,status,created_at,updated_at")
      .eq("owner_id", user.id).order("created_at", { ascending: false }).limit(100),
    supabase.from("firecrawl_key_health").select("key_index,state,error,updated_at,request_count").order("key_index"),
    supabase.from("enrichment_notifications")
      .select("id,key_index,job_id,message,created_at,resolved_at")
      .order("created_at", { ascending: false }).limit(100),
  ]);
  const error = jobs.error ?? keys.error ?? notifications.error;
  if (error) {
    console.error("Could not load analytics:", error);
    return NextResponse.json({ error: "Could not load analytics." }, { status: 500 });
  }
  const keyHealth = (keys.data ?? []).map((key) => ({
    ...key,
    configured: Boolean(process.env[`FIRECRAWL_API_KEY_${key.key_index}`]?.trim()),
  }));
  const keyNotifications = (notifications.data ?? []).filter((item) => !isWebsiteLoadError(item.message));
  const visibleKeyHealth = keyHealth.map((key) => ({
    ...key,
    error: key.error && isWebsiteLoadError(key.error) ? null : key.error,
  }));
  return NextResponse.json({ jobs: jobs.data, keys: visibleKeyHealth, notifications: keyNotifications });
}
