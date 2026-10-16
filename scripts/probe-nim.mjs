// Probes NVIDIA NIM models for what the harness needs: plain chat, tool calls (non-streaming and
// streaming), and latency. Reads TEST_NVIDIA_API_KEY from the environment; never prints it.
// Usage: node scripts/probe-nim.mjs [model ...]
const KEY = process.env.TEST_NVIDIA_API_KEY;
if (!KEY) throw new Error("TEST_NVIDIA_API_KEY is not set");
const BASE = "https://integrate.api.nvidia.com/v1";
const MODELS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "moonshotai/kimi-k3",
      "moonshotai/kimi-k2.6",
      "z-ai/glm-5.3",
      "z-ai/glm-5.3-flash",
      "deepseek-ai/deepseek-v4.1-flash",
      "nvidia/nemotron-3-ultra-550b-a55b",
      "nvidia/nemotron-3-super-120b-a12b",
      "nvidia/nemotron-3.5-lightning-30b-a3b",
      "openai/gpt-oss-20b",
      "poolside/laguna-xs-2.1",
      "mistralai/mistral-large-2-instruct",
      "google/gemma-4-31b-it",
    ];
const tools = [
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or replace a file in the project.",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    },
  },
];
const ask = [{ role: "user", content: 'Create the file src/hello.txt containing exactly the text "hi". Use the write_file tool.' }];
const post = (body, signal) =>
  fetch(`${BASE}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify(body), signal });

async function probe(model) {
  const row = { model };
  // 1. plain
  let t = Date.now();
  try {
    const r = await post({ model, messages: [{ role: "user", content: "Reply with the single word: ready" }], max_tokens: 16 }, AbortSignal.timeout(60_000));
    row.plain = r.ok ? `ok ${Date.now() - t}ms` : `HTTP ${r.status}`;
    if (!r.ok) row.plainErr = (await r.text()).slice(0, 160);
  } catch (e) {
    row.plain = `err ${e.name}`;
  }
  // 2. tools, non-streaming
  t = Date.now();
  try {
    const r = await post({ model, messages: ask, tools, tool_choice: "auto", max_tokens: 1024 }, AbortSignal.timeout(90_000));
    if (!r.ok) row.tool = `HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`;
    else {
      const j = await r.json();
      const m = j.choices?.[0]?.message ?? {};
      const tc = m.tool_calls?.[0];
      let args = null;
      try {
        args = tc ? JSON.parse(tc.function.arguments) : null;
      } catch {}
      row.tool = tc ? (args?.path ? `ok ${Date.now() - t}ms` : `bad-args`) : /write_file|<tool_call>|"path"/.test(m.content ?? "") ? "text-only (unparsed)" : "no-call";
      row.reasoning = Boolean(m.reasoning_content || m.reasoning);
    }
  } catch (e) {
    row.tool = `err ${e.name}`;
  }
  // 3. tools, streaming
  t = Date.now();
  try {
    const r = await post({ model, messages: ask, tools, tool_choice: "auto", max_tokens: 1024, stream: true, stream_options: { include_usage: true } }, AbortSignal.timeout(90_000));
    if (!r.ok) row.stream = `HTTP ${r.status}`;
    else {
      let buf = "", name = "", argText = "", first = 0, usage = null;
      const dec = new TextDecoder();
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
          const evt = JSON.parse(line.slice(5));
          if (!first) first = Date.now() - t;
          if (evt.usage) usage = evt.usage;
          for (const tc of evt.choices?.[0]?.delta?.tool_calls ?? []) {
            if (tc.function?.name) name += tc.function.name;
            if (tc.function?.arguments) argText += tc.function.arguments;
          }
        }
      }
      let ok = false;
      try {
        ok = name === "write_file" && Boolean(JSON.parse(argText).path);
      } catch {}
      row.stream = ok ? `ok ttft ${first}ms total ${Date.now() - t}ms` : name ? `bad-args (${name})` : "no-call";
      row.usage = usage ? "yes" : "no";
    }
  } catch (e) {
    row.stream = `err ${e.name}`;
  }
  return row;
}

for (const m of MODELS) {
  const r = await probe(m);
  console.log(JSON.stringify(r));
}
