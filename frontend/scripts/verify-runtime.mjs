// Tests the rendered route and its actual referenced chunks as well as the API contract.
const origin = process.env.E2E_BASE_URL || "http://127.0.0.1:3211";
async function checked(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  return response;
}
const html = await (await checked(`${origin}/investigation`)).text();
const chunks = [
  ...new Set(
    [...html.matchAll(/src="([^" ]*\/_next\/static\/[^" ]+\.js[^" ]*)"/g)].map((match) =>
      match[1].replaceAll("&amp;", "&"),
    ),
  ),
];
if (chunks.length === 0) throw new Error("No application chunks in rendered route");
for (const chunk of chunks) {
  const response = await checked(new URL(chunk, origin));
  if (!/javascript/.test(response.headers.get("content-type") || ""))
    throw new Error(`Invalid script MIME type: ${chunk}`);
}
const health = await (await checked(`${origin}/api/health`)).json();
if (health.status !== "ready") throw new Error("Backend is not ready");
const fusion = await (
  await checked(`${origin}/api/canvas/fusion/PID2Graph%20OPEN100%2F0.graphml`)
).json();
if (fusion.validation.status !== "verified" || fusion.records.length !== 12)
  throw new Error("Fusion contract failed");
process.stdout.write(
  `${JSON.stringify({ status: "ready", route: "/investigation", chunks: chunks.length, mappings: fusion.records.length })}\n`,
);
