-- Instructions that apply to all of a user's projects.
alter table public.profiles add column instructions text check (char_length(instructions) <= 8000);

-- Memory: facts the agent proposes and the user keeps or discards. Only kept memories are loaded
-- into the agent's prompt. project_id null means the memory belongs to the user, across projects.
create table public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  project_id uuid references public.projects (id) on delete cascade,
  text text not null check (char_length(text) between 1 and 500),
  source text not null check (source in ('agent', 'user')),
  status text not null default 'proposed' check (status in ('proposed', 'kept', 'dismissed')),
  run_id uuid references public.runs (id) on delete set null,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index memories_user_idx on public.memories (user_id, status);
create index memories_project_idx on public.memories (project_id, status);
alter table public.memories enable row level security;
create policy "own memories" on public.memories for select using (auth.uid() = user_id);
