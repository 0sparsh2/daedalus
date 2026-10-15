-- Where a project came from: the starter template, or an imported GitHub repository.
alter table public.projects add column source jsonb not null default '{"type":"template"}'::jsonb;
