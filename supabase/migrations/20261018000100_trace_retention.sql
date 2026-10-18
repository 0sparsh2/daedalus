-- Trace retention: after N days a span keeps its row (name, timing, status, tokens, error) but
-- loses its input and output, which are most of the data. Chat messages and versions are the
-- user's work and are never touched here.
alter table public.spans add column pruned_at timestamptz;
create index spans_unpruned_idx on public.spans (started_at) where pruned_at is null;

-- Clears one batch of old spans' details, skipping projects with a run in progress. Returns how
-- many spans it cleared, so the caller can loop until a batch comes back short.
create function public.prune_span_details(p_cutoff timestamptz, p_limit int)
returns int
language sql
security definer
set search_path = public
as $$
  with victims as (
    select s.id
    from public.spans s
    where s.started_at < p_cutoff
      and s.pruned_at is null
      and not exists (
        select 1 from public.runs r
        where r.project_id = s.project_id and r.status in ('queued', 'running')
      )
    order by s.started_at
    limit p_limit
  ), cleared as (
    update public.spans s
    set input = null, output = null, pruned_at = now()
    from victims v
    where s.id = v.id
    returning 1
  )
  select count(*)::int from cleared;
$$;
revoke all on function public.prune_span_details(timestamptz, int) from public, anon, authenticated;
