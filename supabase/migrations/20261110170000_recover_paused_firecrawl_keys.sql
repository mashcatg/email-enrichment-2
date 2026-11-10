update enrichment_notifications
set resolved_at = now()
where resolved_at is null
  and (
    message ilike '%dns resolution failed%'
    or message ilike '%could not resolve%'
    or message ilike '%no such host%'
    or message ilike '%name or service not known%'
    or message ilike '%do not support this site%'
    or message ilike '%do not support this website%'
    or message ilike '%unsupported site%'
    or message ilike '%unsupported website%'
    or message ilike 'Firecrawl request failed (429):%'
  );

update firecrawl_key_health h
set state = 'active', error = null, updated_at = now()
where h.state = 'paused'
  and not exists (
    select 1
    from enrichment_notifications n
    where n.key_index = h.key_index
      and n.resolved_at is null
      and (
        n.message ilike '%invalid token%'
        or n.message ilike '%unauthorized%'
        or n.message ilike '%billing%'
        or n.message ilike '%payment%'
        or n.message ilike '%insufficient credit%'
      )
  );

update enrichment_jobs
set status = 'queued', updated_at = now()
where status = 'waiting_for_keys'
  and exists (select 1 from firecrawl_key_health where state = 'active');
