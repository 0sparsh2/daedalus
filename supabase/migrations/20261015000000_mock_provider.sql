-- Allow the scripted mock provider (development and end-to-end tests only; the app refuses it
-- unless mock mode is enabled on the server).
alter table public.credentials drop constraint credentials_provider_check;
alter table public.credentials add constraint credentials_provider_check
  check (provider in ('nvidia', 'anthropic', 'openai', 'deepseek', 'mock'));
