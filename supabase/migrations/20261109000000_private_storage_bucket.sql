insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'enrichment-jobs',
  'enrichment-jobs',
  false,
  4194304,
  array['application/json']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
