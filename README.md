# Enrich

A single-page CSV email-enrichment app. The original CSV and working table stay
in the browser's IndexedDB. Website-only jobs are processed by a scheduled
server worker, so enrichment continues when the browser is closed or the Mac is
off. Firecrawl credentials are server-only.

## What is stored

- **Browser IndexedDB:** the original CSV columns, locally merged email results,
  filters, and the active job ID. This is what is exported; clearing browser
  data removes this local copy.
- **Private Supabase Storage bucket (`enrichment-jobs`):** job input containing
  only row numbers and websites, plus individual email-result files. The bucket
  is private and accessed only by the server's service-role client.
- **Supabase:** job/chunk counters, account ownership, API-key health, and
  notifications. Full CSV rows and website/email values are not stored in
  Supabase.

Private Storage files and aggregate analytics remain until manually deleted.
Set up a retention/cleanup policy if you do not want them retained.

## Required services

1. **Supabase:** create a project, apply
   [`supabase/migrations/20250201000000_hosted_enrichment.sql`](./supabase/migrations/20250201000000_hosted_enrichment.sql),
   and create the `mashcatg@gmail.com` user in Supabase Auth with a password.
   Disable public sign-ups; the application only authorizes this account.
2. **Supabase Storage:** apply
   [`supabase/migrations/20261109000000_private_storage_bucket.sql`](./supabase/migrations/20261109000000_private_storage_bucket.sql)
   to create the private `enrichment-jobs` bucket. No Vercel Blob account or
   token is needed.
3. **Vercel:** deploy this Next.js repository and configure all variables from
   [`.env.example`](./.env.example). Set `FIRECRAWL_API_KEY_1` through
   `FIRECRAWL_API_KEY_10` to server environment variables only; never use
   `NEXT_PUBLIC_` for Firecrawl keys.
4. Configure a Vercel plan that supports a one-minute Cron schedule and the
   worker's 300-second function duration. [`vercel.json`](./vercel.json)
   schedules `/api/worker` once a minute. Vercel sends the `CRON_SECRET` bearer
   token to that endpoint.

For local development, use Node.js 20+, copy `.env.example` to `.env.local`,
fill in the Supabase and Firecrawl values, then run:

```bash
npm install
npm run dev
```

If another copy of this project is already running on port `3000`, use
`npm run dev:3118` instead. It uses a separate Next.js build directory so the
two development servers do not corrupt each other's caches.

The local worker can be triggered manually:

```bash
curl -X POST http://localhost:3000/api/worker \
  -H "Authorization: Bearer $CRON_SECRET"
```

## Queue and rate limits

Uploading a CSV requires a `website` header. The app preserves the original
columns locally, sends only eligible row numbers and website values to the
server, and divides each job into at most ten queue chunks. Each scrape requests
the normalized domain root once; it does not crawl links. Results are written
in a private Supabase Storage bucket and merged back into IndexedDB when the job finishes.
The CSV can then be filtered, paginated, and exported.

The worker coordinates all configured keys with one shared rate limiter.
`FIRECRAWL_MAX_RPM` defaults to 10 and `FIRECRAWL_CONCURRENCY` defaults to 2.
Ten keys for the same Firecrawl team do **not** necessarily provide ten times
the request or concurrency limit; configure these values within the limits of
the actual Firecrawl plan. On an API error the affected key is paused, an
in-app alert is recorded, and its chunk is made available to another active
key. Select **Resolved · re-enable key** only after fixing the key/account
issue.

The analytics page reports job totals, chunk progress, key health, and alerts.
It refreshes automatically; the enrichment worker does not depend on the page
remaining open. Cron execution still depends on Vercel's plan/configuration and
the deployed function being healthy.
