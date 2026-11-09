create extension if not exists pgcrypto;

create table if not exists public.enrichment_jobs (
  id uuid primary key,
  owner_id uuid not null,
  file_name text not null,
  input_blob text not null,
  total_count integer not null check (total_count >= 0),
  completed_count integer not null default 0,
  found_count integer not null default 0,
  not_found_count integer not null default 0,
  failed_count integer not null default 0,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'waiting_for_keys', 'completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.enrichment_chunks (
  job_id uuid not null references public.enrichment_jobs(id) on delete cascade,
  chunk_index integer not null,
  start_index integer not null,
  end_index integer not null,
  next_index integer not null,
  state text not null default 'queued' check (state in ('queued', 'running', 'completed')),
  assigned_key_index integer,
  lease_until timestamptz,
  primary key (job_id, chunk_index)
);

create table if not exists public.firecrawl_key_health (
  key_index integer primary key check (key_index between 1 and 10),
  state text not null default 'active' check (state in ('active', 'paused')),
  error text,
  updated_at timestamptz not null default now(),
  request_count bigint not null default 0
);

insert into public.firecrawl_key_health (key_index)
select generate_series(1, 10)
on conflict (key_index) do nothing;

create table if not exists public.enrichment_notifications (
  id uuid primary key default gen_random_uuid(),
  key_index integer not null references public.firecrawl_key_health(key_index),
  job_id uuid references public.enrichment_jobs(id) on delete cascade,
  message text not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists public.firecrawl_rate_limit (
  id integer primary key check (id = 1),
  next_request_at timestamptz not null default now()
);
insert into public.firecrawl_rate_limit (id) values (1) on conflict (id) do nothing;

create index if not exists enrichment_jobs_owner_created_idx
  on public.enrichment_jobs(owner_id, created_at desc);
create index if not exists enrichment_chunks_claim_idx
  on public.enrichment_chunks(state, lease_until);
create index if not exists enrichment_notifications_open_idx
  on public.enrichment_notifications(resolved_at, created_at desc);

alter table public.enrichment_jobs enable row level security;
alter table public.enrichment_chunks enable row level security;
alter table public.firecrawl_key_health enable row level security;
alter table public.enrichment_notifications enable row level security;
alter table public.firecrawl_rate_limit enable row level security;

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
    and j.status != 'completed'
    and c.next_index < c.end_index
  order by j.created_at, c.chunk_index
  limit 1
  for update of c skip locked;

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
  where j.id = selected_job and j.status in ('queued', 'waiting_for_keys');

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

create or replace function public.reserve_firecrawl_slot(p_interval_ms integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  wait_ms integer;
begin
  update firecrawl_rate_limit
  set next_request_at = greatest(next_request_at, now()) +
    make_interval(secs => greatest(p_interval_ms, 1000)::double precision / 1000)
  where id = 1
  returning greatest(0, ceil(extract(epoch from (next_request_at - now())) * 1000)::integer
    - greatest(p_interval_ms, 1000)) into wait_ms;
  return coalesce(wait_ms, 0);
end;
$$;

create or replace function public.complete_enrichment_row(
  p_job_id uuid,
  p_chunk_index integer,
  p_row_index integer,
  p_result text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  next_value integer;
  end_value integer;
begin
  update enrichment_chunks
  set next_index = p_row_index + 1,
      lease_until = null,
      state = case when p_row_index + 1 >= end_index then 'completed' else 'queued' end
  where job_id = p_job_id and chunk_index = p_chunk_index and next_index = p_row_index
  returning next_index, end_index into next_value, end_value;

  if next_value is null then
    raise exception 'Enrichment chunk cursor changed unexpectedly';
  end if;

  update enrichment_jobs
  set completed_count = completed_count + 1,
      found_count = found_count + case when p_result = 'complete' then 1 else 0 end,
      not_found_count = not_found_count + case when p_result = 'not_found' then 1 else 0 end,
      failed_count = failed_count + case when p_result = 'failed' then 1 else 0 end,
      updated_at = now()
  where id = p_job_id;

  update enrichment_jobs j
  set status = 'completed', updated_at = now()
  where j.id = p_job_id and j.completed_count >= j.total_count;
end;
$$;

create or replace function public.pause_firecrawl_key(
  p_key_index integer,
  p_job_id uuid,
  p_chunk_index integer,
  p_message text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update firecrawl_key_health
  set state = 'paused', error = left(p_message, 1000), updated_at = now()
  where key_index = p_key_index;

  insert into enrichment_notifications (key_index, job_id, message)
  values (p_key_index, p_job_id, left(p_message, 1000));

  update enrichment_chunks
  set state = 'queued', assigned_key_index = null, lease_until = null
  where job_id = p_job_id and chunk_index = p_chunk_index and assigned_key_index = p_key_index
    and state != 'completed';

  if not exists (select 1 from firecrawl_key_health where state = 'active') then
    update enrichment_jobs set status = 'waiting_for_keys', updated_at = now()
    where status != 'completed';
  end if;
end;
$$;

create or replace function public.resolve_firecrawl_notification(p_notification_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  resolved_key integer;
begin
  update enrichment_notifications
  set resolved_at = now()
  where id = p_notification_id and resolved_at is null
  returning key_index into resolved_key;

  if resolved_key is null then raise exception 'Notification is already resolved or missing'; end if;

  update firecrawl_key_health
  set state = 'active', error = null, updated_at = now()
  where key_index = resolved_key;

  update enrichment_jobs set status = 'queued', updated_at = now()
  where status = 'waiting_for_keys';
end;
$$;

revoke all on function public.claim_enrichment_chunk(integer[], integer) from public, anon, authenticated;
revoke all on function public.reserve_firecrawl_slot(integer) from public, anon, authenticated;
revoke all on function public.complete_enrichment_row(uuid, integer, integer, text) from public, anon, authenticated;
revoke all on function public.pause_firecrawl_key(integer, uuid, integer, text) from public, anon, authenticated;
revoke all on function public.resolve_firecrawl_notification(uuid) from public, anon, authenticated;
grant execute on function public.claim_enrichment_chunk(integer[], integer) to service_role;
grant execute on function public.reserve_firecrawl_slot(integer) to service_role;
grant execute on function public.complete_enrichment_row(uuid, integer, integer, text) to service_role;
grant execute on function public.pause_firecrawl_key(integer, uuid, integer, text) to service_role;
grant execute on function public.resolve_firecrawl_notification(uuid) to service_role;
