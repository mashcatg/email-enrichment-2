create or replace function public.defer_firecrawl_slot(p_delay_ms integer)
returns void
language sql
security definer
set search_path = public
as $$
  update firecrawl_rate_limit
  set next_request_at = greatest(
    next_request_at,
    now() + make_interval(secs => least(greatest(p_delay_ms, 1000), 900000)::double precision / 1000)
  )
  where id = 1;
$$;

revoke all on function public.defer_firecrawl_slot(integer) from public, anon, authenticated;
grant execute on function public.defer_firecrawl_slot(integer) to service_role;

update firecrawl_key_health
set state = 'active', error = null, updated_at = now()
where error ilike 'Firecrawl request failed (429):%rate limit%';

update enrichment_notifications
set resolved_at = now()
where resolved_at is null
  and message ilike 'Firecrawl request failed (429):%rate limit%';

update enrichment_jobs
set status = 'queued', updated_at = now()
where status = 'waiting_for_keys'
  and exists (select 1 from firecrawl_key_health where state = 'active');
