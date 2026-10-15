-- Atomic usage counters for a run, called by the LLM gateway and tool steps (service role only).
create function public.add_run_usage(p_run_id uuid, p_input bigint, p_output bigint, p_llm_calls int, p_tool_calls int)
returns void language sql security definer set search_path = '' as $$
  update public.runs
     set input_tokens = input_tokens + coalesce(p_input, 0),
         output_tokens = output_tokens + coalesce(p_output, 0),
         llm_calls = llm_calls + coalesce(p_llm_calls, 0),
         tool_calls = tool_calls + coalesce(p_tool_calls, 0)
   where id = p_run_id;
$$;
revoke all on function public.add_run_usage(uuid, bigint, bigint, int, int) from public, anon, authenticated;
