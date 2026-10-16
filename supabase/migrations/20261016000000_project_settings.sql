-- Per-project agent settings, e.g. { "subagentModel": "z-ai/glm-5.3-flash" }.
alter table public.projects add column settings jsonb not null default '{}'::jsonb;
