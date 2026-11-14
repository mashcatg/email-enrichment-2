import { NextResponse } from "next/server";
import { getAuthorizedUser } from "@/lib/supabase/server";

export const runtime = "nodejs";

const ACTOR_ID = "compass~crawler-google-places";
const MAX_SEARCH_TERMS = 10;
const MAX_PLACES_PER_SEARCH = 2000;

interface ProspectRunRequest {
  searchTerms?: unknown;
  location?: unknown;
  maxPlacesPerSearch?: unknown;
}

interface ApifyRunResponse {
  data?: {
    id?: string;
    status?: string;
    statusMessage?: string;
    defaultDatasetId?: string;
  };
  error?: { message?: string };
}

export async function POST(request: Request) {
  if (!await getAuthorizedUser()) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const token = process.env.APIFY_API_TOKEN?.trim();
  if (!token) {
    return NextResponse.json({ error: "APIFY_API_TOKEN is not configured on the server." }, { status: 503 });
  }

  let body: ProspectRunRequest;
  try {
    body = await request.json() as ProspectRunRequest;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const searchTerms = Array.isArray(body.searchTerms)
    ? body.searchTerms.filter((term): term is string => typeof term === "string").map((term) => term.trim()).filter(Boolean)
    : [];
  const location = typeof body.location === "string" ? body.location.trim() : "";
  const maxPlacesPerSearch = Number(body.maxPlacesPerSearch);
  if (
    searchTerms.length === 0 || searchTerms.length > MAX_SEARCH_TERMS ||
    searchTerms.some((term) => term.length > 200) ||
    !location || location.length > 300 ||
    !Number.isInteger(maxPlacesPerSearch) ||
    maxPlacesPerSearch < 1 || maxPlacesPerSearch > MAX_PLACES_PER_SEARCH
  ) {
    return NextResponse.json({
      error: `Enter 1–${MAX_SEARCH_TERMS} search terms, one location, and a per-term limit between 1 and ${MAX_PLACES_PER_SEARCH}.`,
    }, { status: 400 });
  }

  const query = new URLSearchParams();
  query.set("waitForFinish", "0");
  if (process.env.APIFY_MAX_TOTAL_CHARGE_USD) {
    const maxTotalChargeUsd = Number(process.env.APIFY_MAX_TOTAL_CHARGE_USD);
    if (!Number.isFinite(maxTotalChargeUsd) || maxTotalChargeUsd <= 0) {
      return NextResponse.json({ error: "APIFY_MAX_TOTAL_CHARGE_USD must be a positive number." }, { status: 500 });
    }
    query.set("maxTotalChargeUsd", String(maxTotalChargeUsd));
  }

  let response: Response;
  try {
    response = await fetch(`https://api.apify.com/v2/acts/${ACTOR_ID}/runs?${query}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        searchStringsArray: searchTerms,
        locationQuery: location,
        maxCrawledPlacesPerSearch: maxPlacesPerSearch,
        proxyConfig: { useApifyProxy: true },
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    console.error("Could not start Apify prospect search:", error);
    return NextResponse.json({ error: "Could not connect to Apify to start the prospect search." }, { status: 502 });
  }

  let result: ApifyRunResponse;
  try {
    result = await response.json() as ApifyRunResponse;
  } catch {
    return NextResponse.json({ error: `Apify returned an unreadable response (${response.status}).` }, { status: 502 });
  }
  if (!response.ok || !result.data?.id) {
    console.error("Apify rejected the prospect search:", response.status, result.error?.message);
    return NextResponse.json({
      error: result.error?.message ?? `Apify could not start the prospect search (${response.status}).`,
    }, { status: 502 });
  }

  return NextResponse.json({
    id: result.data.id,
    status: result.data.status ?? "READY",
    statusMessage: result.data.statusMessage ?? null,
  });
}
