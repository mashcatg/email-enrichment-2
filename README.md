# Enrich

A browser-only CSV email enrichment tool built with Next.js and Firecrawl.

## Run locally

Use Node.js 20 or later:

```bash
npm install
npm run dev
```

Open the local URL printed by Next.js, enter a Firecrawl API key, then upload or
drop a CSV with a `website` column. The app makes one Firecrawl scrape request
for each cleaned website domain; it does not crawl the site's links. URL paths,
query parameters, fragments, and a leading `www.` are removed before scraping
the domain root. The full page is included, including headers and footers, so
contact details outside the main article content are not discarded. If a public
contact email is found on that page, it is added to the CSV. If no email is
found, the email cell stays empty and the row is marked "Not found." Existing
values in an `email` column are preserved. Search, filter by status, and export
the full enriched CSV at any time.
Email detection supports plain text, `mailto:` links, HTML entities, common
`[at]`/`[dot]` and Spanish `[arroba]`/`[punto]` obfuscation, and Cloudflare's
email-protection markup and email fields in JSON-LD structured data. It
validates the full address, rejects browser-generated `mhtml.blink` frame
addresses, and ignores addresses found only in arbitrary HTML attributes,
scripts, or URLs. Older saved rows with invalid email values are cleared and
made available for retry on reload.

Firecrawl's current Free plan allows 10 scrape requests per minute. Requests
are therefore paced at no more than one every 6.1 seconds, with retries and
exponential backoff for rate limits and temporary server errors. Firecrawl's
`Retry-After` header is honored; if it requests a wait longer than two minutes,
the row remains saved as failed and can be retried later.

## Data and privacy

The CSV and enrichment results are stored in this browser's IndexedDB so they
survive reloads and closing the tab. They remain there after export until you
select **Start over** or clear this browser's site data. There is no application
backend or database. The Firecrawl API key stays in page memory for the current
session; cleaned website domains are sent directly from the browser to Firecrawl.
The app also requests persistent browser storage where supported; browser
storage clearing or private-browsing policies can still remove local data.
