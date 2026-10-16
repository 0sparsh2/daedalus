-- Preview reports carry the id of the agent check that asked for a fresh load, so the check
-- reads exactly the errors from its own page load: request arrival order doesn't match the
-- order things happened in the browser, so timestamps can't tell them apart.
alter table public.preview_errors add column check_id text;
create index preview_errors_check_idx on public.preview_errors (project_id, check_id) where check_id is not null;
