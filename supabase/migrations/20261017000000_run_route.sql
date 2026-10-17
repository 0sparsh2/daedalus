-- The turn router's decision for each run: chat (no sandbox, no tools), ask (read-only
-- answers about the app), plan (read-only; a plan is optional) or build. `mode` stays the
-- user's Plan/Build toggle, which caps what a turn may do.
alter table public.runs add column route text check (route in ('chat', 'ask', 'plan', 'build'));
