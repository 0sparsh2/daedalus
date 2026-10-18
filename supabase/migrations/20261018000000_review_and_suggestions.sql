-- Review turns: the agent reads the project's recent runs and suggests how it should work here.
alter table public.runs drop constraint if exists runs_route_check;
alter table public.runs add constraint runs_route_check check (route in ('chat', 'ask', 'plan', 'build', 'review'));

-- Suggestions: skills and rules the agent proposes from what a conversation or review showed.
-- Like memories, nothing is applied until the user keeps it: a kept skill is written to the
-- repo, a kept rule is added to the project's rules.
create table public.suggestions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  run_id uuid references public.runs (id) on delete set null,
  kind text not null check (kind in ('skill', 'rule')),
  name text not null check (char_length(name) between 1 and 80),
  payload jsonb not null,
  evidence text not null default '' check (char_length(evidence) <= 2000),
  status text not null default 'proposed' check (status in ('proposed', 'kept', 'dismissed')),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index suggestions_project_idx on public.suggestions (project_id, status);
alter table public.suggestions enable row level security;
create policy "own suggestions" on public.suggestions for select using (auth.uid() = user_id);
