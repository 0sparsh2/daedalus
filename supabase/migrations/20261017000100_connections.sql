-- Connections: MCP servers a project's agent can use. Tokens are encrypted (AES-256-GCM, user id
-- as authenticated data) and only the server reads them; the browser goes through the API.
create table public.connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  name text not null check (name ~ '^[a-z0-9][a-z0-9-]{0,30}$'),
  url text not null,
  secret_ciphertext text,
  -- The user vouches that this server only reads data, so its tools may run in read-only turns.
  read_only boolean not null default false,
  enabled boolean not null default true,
  -- Cached tool list: [{ name, description, inputSchema, readOnly }]
  tools jsonb not null default '[]'::jsonb,
  status text not null default 'ok' check (status in ('ok', 'error')),
  error text,
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (project_id, name)
);
create index connections_project_idx on public.connections (project_id);
alter table public.connections enable row level security;
-- No client policies on purpose: every read and write goes through the server.
