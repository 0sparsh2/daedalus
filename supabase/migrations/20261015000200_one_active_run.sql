-- At most one active run per project, enforced by the database (two Sends at the same instant
-- can't both start a build).
create unique index runs_one_active_per_project on public.runs (project_id) where status in ('queued', 'running');
