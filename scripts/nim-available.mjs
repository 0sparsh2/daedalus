// Quick availability check: which NIM chat models can this key call right now (25 s each, in
// parallel batches). Reads TEST_NVIDIA_API_KEY; never prints it.
const KEY = process.env.TEST_NVIDIA_API_KEY;
const MODELS = process.argv.slice(2);
const check = async (model) => {
  const t = Date.now();
  try {
    const r = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with the word ready" }], max_tokens: 16 }),
      signal: AbortSignal.timeout(25_000),
    });
    const body = await r.text();
    return `${model.padEnd(42)} ${r.ok ? "OK " : "NO "} ${String(r.status).padEnd(4)} ${String(Date.now() - t).padStart(6)}ms ${r.ok ? "" : body.slice(0, 90)}`;
  } catch (e) {
    return `${model.padEnd(42)} NO  ${e.name} ${Date.now() - t}ms`;
  }
};
for (let i = 0; i < MODELS.length; i += 4) {
  const rows = await Promise.all(MODELS.slice(i, i + 4).map(check));
  for (const r of rows) console.log(r);
}
