alter table public.enrichment_jobs
  drop constraint if exists enrichment_jobs_status_check;

alter table public.enrichment_jobs
  add constraint enrichment_jobs_status_check
  check (status in ('queued', 'running', 'waiting_for_keys', 'paused', 'completed'));

create or replace function public.claim_enrichment_chunk(
  p_active_key_indices integer[],
  p_lease_seconds integer default 180
)
returns table (
  job_id uuid,
  chunk_index integer,
  start_index integer,
  end_index integer,
  next_index integer,
  assigned_key_index integer,
  input_blob text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_job uuid;
  selected_chunk integer;
  selected_key integer;
begin
  select c.job_id, c.chunk_index into selected_job, selected_chunk
  from enrichment_chunks c
  join enrichment_jobs j on j.id = c.job_id
  where c.state != 'completed'
    and (c.lease_until is null or c.lease_until < now())
    and j.status in ('queued', 'running')
    and c.next_index < c.end_index
  order by j.created_at, c.chunk_index
  limit 1
  for update of c, j skip locked;

  if selected_job is null then return; end if;

  select h.key_index into selected_key
  from firecrawl_key_health h
  where h.key_index = any(p_active_key_indices) and h.state = 'active'
  order by h.request_count, h.key_index
  limit 1;

  if selected_key is null then return; end if;

  update enrichment_chunks c
  set state = 'running',
      assigned_key_index = selected_key,
      lease_until = now() + make_interval(secs => greatest(p_lease_seconds, 30))
  where c.job_id = selected_job and c.chunk_index = selected_chunk;

  update enrichment_jobs j set status = 'running', updated_at = now()
  where j.id = selected_job and j.status = 'queued';

  update firecrawl_key_health h
  set request_count = request_count + 1, updated_at = now()
  where h.key_index = selected_key;

  return query
  select c.job_id, c.chunk_index, c.start_index, c.end_index, c.next_index,
         c.assigned_key_index, j.input_blob
  from enrichment_chunks c
  join enrichment_jobs j on j.id = c.job_id
  where c.job_id = selected_job and c.chunk_index = selected_chunk;
end;
$$;
