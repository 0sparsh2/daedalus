-- Per-tool permissions for connections: { "<tool name>": "allow" | "ask" | "block" }. A tool
-- without an entry uses its default (lib/mcp/policy.ts).
alter table public.connections add column tool_policies jsonb not null default '{}'::jsonb;

-- Approvals: one per "ask" tool call. The run waits on a workflow hook (token) until the user
-- decides, the run is stopped, or the wait times out.
create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.runs (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  tool_call_id text not null,
  token text not null unique,
  connection_id uuid references public.connections (id) on delete set null,
  connection text not null,
  tool text not null,
  args jsonb,
  status text not null default 'waiting' check (status in ('waiting', 'approved', 'always', 'denied', 'stopped', 'expired')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (run_id, tool_call_id)
);
create index approvals_run_idx on public.approvals (run_id, status);
alter table public.approvals enable row level security;
create policy "own approvals" on public.approvals for select using (auth.uid() = user_id);
