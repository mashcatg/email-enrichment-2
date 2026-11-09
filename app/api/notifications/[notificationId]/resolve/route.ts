import { NextResponse } from "next/server";
import { createSupabaseAdminClient, getAuthorizedUser } from "@/lib/supabase/server";

export async function POST(_request: Request, context: { params: Promise<{ notificationId: string }> }) {
  const user = await getAuthorizedUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { notificationId } = await context.params;
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase.rpc("resolve_firecrawl_notification", { p_notification_id: notificationId });
  if (error) {
    console.error("Could not resolve Firecrawl notification:", error);
    return NextResponse.json({ error: "Could not resolve this key alert." }, { status: 409 });
  }
  return NextResponse.json({ resolved: true });
}
