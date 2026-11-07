import { extractBestEmail } from "@/lib/email";

interface FirecrawlScrapeResponse {
  success?: boolean;
  data?: {
    markdown?: string;
    html?: string;
    metadata?: Record<string, unknown> & { title?: string; sourceURL?: string; sourceUrl?: string };
  };
  error?: string;
}

const API_URL = "https://api.firecrawl.dev/v2/scrape";
const MIN_REQUEST_INTERVAL_MS = 6_100;
const MAX_RETRIES = 4;
const MAX_AUTOMATIC_RETRY_WAIT_MS = 120_000;
let lastRequestStartedAt = 0;
const RATE_LIMIT_STORAGE_KEY = "email-enrichment:last-firecrawl-request";

export async function findWebsiteEmail(
  website: string,
  apiKey: string,
  onProgress: (message: string) => void,
): Promise<string | null> {
  const url = normalizeWebsite(website);
  const payload = await scrapeWithRetry(url, apiKey, onProgress);

  const content = [
    payload.data?.markdown,
    payload.data?.html,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n");
  return extractBestEmail(content, url);
}

function normalizeWebsite(input: string): string {
  let value = input.trim();
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("This row has an invalid website URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Website URLs must use HTTP or HTTPS.");
  }
  const hostname = url.hostname.replace(/^www\./i, "").toLowerCase();
  const port = url.port ? `:${url.port}` : "";
  return `${url.protocol}//${hostname}${port}/`;
}

async function scrapeWithRetry(
  url: string,
  apiKey: string,
  onProgress: (message: string) => void,
): Promise<FirecrawlScrapeResponse> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    await waitForRequestSlot();
    onProgress("Scraping website");

    let response: Response;
    try {
      response = await fetch(API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url, formats: ["markdown", "html"], onlyMainContent: false }),
      });
    } catch (error) {
      if (attempt === MAX_RETRIES) {
        throw new Error(`Could not connect to Firecrawl: ${error instanceof Error ? error.message : "network error"}`);
      }
      await waitBeforeRetry(attempt, null, onProgress);
      continue;
    }

    let payload: FirecrawlScrapeResponse;
    try {
      payload = (await response.json()) as FirecrawlScrapeResponse;
    } catch {
      if (isRetryableStatus(response.status) && attempt < MAX_RETRIES) {
        await waitBeforeRetry(attempt, response.headers.get("Retry-After"), onProgress);
        continue;
      }
      throw new Error(`Firecrawl returned an unreadable response (${response.status}).`);
    }

    if (response.ok && payload.success !== false) return payload;
    if (isRetryableStatus(response.status) && attempt < MAX_RETRIES) {
      await waitBeforeRetry(attempt, response.headers.get("Retry-After"), onProgress);
      continue;
    }
    throw new Error(payload.error || `Firecrawl request failed (${response.status}).`);
  }

  throw new Error("Firecrawl request could not be completed after several retries.");
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function waitForRequestSlot(): Promise<void> {
  const now = Date.now();
  let nextRequestAt = Math.max(now, lastRequestStartedAt + MIN_REQUEST_INTERVAL_MS);
  try {
    const storedRequestAt = Number(localStorage.getItem(RATE_LIMIT_STORAGE_KEY));
    if (Number.isFinite(storedRequestAt)) {
      nextRequestAt = Math.max(nextRequestAt, storedRequestAt + MIN_REQUEST_INTERVAL_MS);
    }
    localStorage.setItem(RATE_LIMIT_STORAGE_KEY, String(nextRequestAt));
  } catch {
    // Keep the in-memory limiter working when browser storage is unavailable.
  }
  const wait = Math.max(0, nextRequestAt - now);
  if (wait > 0) await delay(wait);
  lastRequestStartedAt = nextRequestAt;
}

async function waitBeforeRetry(
  attempt: number,
  retryAfterHeader: string | null,
  onProgress: (message: string) => void,
): Promise<void> {
  const retryAfter = parseRetryAfter(retryAfterHeader);
  if (retryAfter !== null && retryAfter > MAX_AUTOMATIC_RETRY_WAIT_MS) {
    throw new Error(`Firecrawl asked to wait ${formatWait(retryAfter)} before retrying. This row is saved; retry it later.`);
  }
  const backoff = Math.min(1_000 * (2 ** (attempt + 1)), 30_000);
  const wait = Math.max(backoff, retryAfter ?? 0);
  onProgress(`Firecrawl rate limit or temporary error · retrying in ${formatWait(wait)}`);
  await delay(wait);
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function formatWait(milliseconds: number): string {
  const seconds = Math.ceil(milliseconds / 1000);
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
