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

export async function POST(request: Request) {
  const user = await getAuthorizedUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)
    || (body as { action?: unknown }).action !== "enable_all_keys") {
    return NextResponse.json({ error: "Unsupported analytics action." }, { status: 400 });
  }

  const configuredKeyIndices = Array.from({ length: 10 }, (_, index) => index + 1)
    .filter((index) => Boolean(process.env[`FIRECRAWL_API_KEY_${index}`]?.trim()));
  if (configuredKeyIndices.length === 0) {
    return NextResponse.json({ error: "No Firecrawl API keys are configured." }, { status: 409 });
  }

  const supabase = createSupabaseAdminClient();
  const now = new Date().toISOString();
  const { error: keysError } = await supabase.from("firecrawl_key_health")
    .update({ state: "active", error: null, updated_at: now })
    .in("key_index", configuredKeyIndices);
  if (keysError) {
    console.error("Could not re-enable configured Firecrawl keys:", keysError);
    return NextResponse.json({ error: "Could not re-enable configured Firecrawl keys." }, { status: 500 });
  }

  const { error: notificationsError } = await supabase.from("enrichment_notifications")
    .update({ resolved_at: now })
    .in("key_index", configuredKeyIndices)
    .is("resolved_at", null);
  if (notificationsError) {
    console.error("Could not resolve Firecrawl key notifications:", notificationsError);
    return NextResponse.json({ error: "Keys were enabled, but their notifications could not be resolved." }, { status: 500 });
  }

  const { error: jobsError } = await supabase.from("enrichment_jobs")
    .update({ status: "queued", updated_at: now })
    .eq("status", "waiting_for_keys");
  if (jobsError) {
    console.error("Could not queue jobs waiting for Firecrawl keys:", jobsError);
    return NextResponse.json({ error: "Keys were enabled, but waiting jobs could not be queued." }, { status: 500 });
  }

  return NextResponse.json({ enabled: configuredKeyIndices.length });
}
