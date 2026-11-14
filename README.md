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
   [`supabase/migrations/20261109180000_worker_cron_extensions.sql`](./supabase/migrations/20261109180000_worker_cron_extensions.sql),
   [`supabase/migrations/20261110160000_firecrawl_rate_limit_backoff.sql`](./supabase/migrations/20261110160000_firecrawl_rate_limit_backoff.sql),
   [`supabase/migrations/20261110170000_recover_paused_firecrawl_keys.sql`](./supabase/migrations/20261110170000_recover_paused_firecrawl_keys.sql),
   [`supabase/migrations/20261112140000_pause_enrichment_jobs.sql`](./supabase/migrations/20261112140000_pause_enrichment_jobs.sql),
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
4. Vercel Hobby allows a 300-second function duration, but its Cron Jobs run
   only once per day. The worker is scheduled by Supabase Cron instead, so no
   Vercel Pro upgrade is needed.

## Configure the hosted worker schedule

After deploying the app to Vercel:

1. In Supabase, open **Integrations → Vault** and add these secrets:
   - `enrichment_worker_url`: the deployed app URL followed by `/api/worker`
     (for example, `https://your-app.vercel.app/api/worker`).
   - `enrichment_worker_cron_secret`: the same value as the Vercel
     `CRON_SECRET` environment variable.
2. In the Supabase SQL Editor, schedule the worker every five minutes:

   ```sql
   select cron.schedule(
     'email-enrichment-worker',
     '*/5 * * * *',
     $job$
     select net.http_post(
       url := (
         select decrypted_secret
         from vault.decrypted_secrets
         where name = 'enrichment_worker_url'
       ),
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'Authorization', 'Bearer ' || (
           select decrypted_secret
           from vault.decrypted_secrets
           where name = 'enrichment_worker_cron_secret'
         )
       ),
       body := '{}'::jsonb,
       timeout_milliseconds := 280000
     );
     $job$
   );
   ```

   Running the same `cron.schedule` command again updates the existing job.
   The worker processes in bounded batches and the next scheduled run continues
   queued rows. It does not depend on the browser, tab, or Mac remaining open.
3. Check that the job is scheduled:

   ```sql
   select jobname, schedule
   from cron.job
   where jobname = 'email-enrichment-worker';
   ```

For local development, use Node.js 20+, copy `.env.example` to `.env.local`,
fill in the Supabase and Firecrawl values, then run:

```bash
npm install
npm run dev
```

## Find prospects with Apify

Set `APIFY_API_TOKEN` in the server environment (for local work, `.env.local`;
for deployment, the hosting provider's environment settings). Keep it
server-only: do not prefix it with `NEXT_PUBLIC_`. Optionally set
`APIFY_MAX_TOTAL_CHARGE_USD` to cap each actor run's spend.

When no project is loaded, use **Find prospects with Apify** to enter up to ten
search terms, one location, and a per-term place limit. The app starts the
`compass/crawler-google-places` Actor and retrieves its results after it
finishes. Runs are resumable after a page reload. Apify only collects place
prospect data in this flow; email/contact enrichment is not requested. Results
are deduplicated by place ID when available, saved to the browser's local
project, and have a blank email column. Firecrawl enrichment remains a separate,
explicit action.

Apify charges for actor runs and scraped places. The app displays an estimate
using the Actor's current published base event prices; actual charges can vary
by account plan, successful places, and any enabled add-ons. Review the
[Actor's pricing](https://apify.com/compass/crawler-google-places/pricing)
before starting a run.

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
`FIRECRAWL_MAX_RPM` defaults to 8 and `FIRECRAWL_CONCURRENCY` defaults to 1.
When Firecrawl returns HTTP 429, the worker honors its retry/reset guidance,
defers the shared request queue, and retries the row without pausing the key.
Website-specific DNS and unsupported-site errors are recorded as website
failures, not key failures. The recovery migration re-enables keys paused by
these errors and queues jobs waiting for a key; authentication and billing
alerts remain unresolved for manual review.
Ten keys for the same Firecrawl team do **not** necessarily provide ten times
the request or concurrency limit; configure these values within the limits of
the actual Firecrawl plan. On an API error the affected key is paused, an
in-app alert is recorded, and its chunk is made available to another active
key. Select **Resolved · re-enable key** only after fixing the key/account
issue.

Scrape requests bypass TLS certificate verification for target websites to
allow sites with invalid or misconfigured certificates to be processed. This
weakens protection against impersonated websites; use only when that tradeoff
is acceptable.

The analytics page reports job totals, chunk progress, key health, and alerts.
It refreshes automatically; the enrichment worker does not depend on the page
remaining open. Hosted scheduling depends on the Supabase Cron job and the
deployed Vercel function being healthy.

The CSV export includes all rows matching the current status filter and search,
not just the current page. With no active filter or search, it exports the full
CSV.
