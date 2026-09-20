// Verifies the X-LLM-Force header rewrites claude-* models to a profile's provider
// models and routes them to the right upstream, and that the header is stripped
// before forwarding. Run: node test/force-remap.test.mjs
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "router-test-"));

// Echo upstream stands in for every provider: captures the body + headers it gets.
let received;
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    received = {
      url: req.url,
      headers: req.headers,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const upstreamPort = upstream.address().port;

// One echo upstream backs every route; forceProfiles exercises both providers.
const routesFile = path.join(tmp, "routes.mjs");
fs.writeFileSync(
  routesFile,
  `const url = "http://127.0.0.1:${upstreamPort}";
  export const forceProfiles = {
    zai:  { fable: "glm-4.6", opus: "glm-4.6", sonnet: "glm-4.6", haiku: "glm-4.5-air", default: "glm-4.6" },
    kimi: { fable: "k3-256k", opus: "k3-256k", sonnet: "kimi-for-coding", haiku: "kimi-for-coding-highspeed", default: "k3-256k" },
  };
  export const routes = [
    { name: "kimi", match: /^(kimi|moonshot|k3)/i, url, auth: "strip" },
    { name: "zai",  match: /^glm/i, url, auth: "strip" },
    { name: "anthropic", match: /./, url, auth: "strip" },
  ];`,
);

const routerPort = 8799;
const proc = spawn("node", [path.join(dir, "..", "router.mjs")], {
  env: { ...process.env, ROUTES_FILE: routesFile, ROUTER_PORT: String(routerPort) },
  stdio: "inherit",
});
await new Promise((r) => setTimeout(r, 400));

async function post(model, headers) {
  received = undefined;
  await new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: routerPort, method: "POST", path: "/v1/messages",
        headers: { "content-type": "application/json", ...headers } },
      (res) => { res.on("data", () => {}); res.on("end", resolve); },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ model, messages: [] }));
  });
}

try {
  // zai profile: sonnet/opus -> glm-4.6, haiku -> glm-4.5-air
  await post("claude-sonnet-4-6", { "x-llm-force": "zai" });
  assert.equal(received.body.model, "glm-4.6", "zai sonnet -> glm-4.6");
  await post("claude-haiku-4-5", { "x-llm-force": "zai" });
  assert.equal(received.body.model, "glm-4.5-air", "zai haiku -> glm-4.5-air");

  // kimi profile: opus -> k3-256k, sonnet -> kimi-for-coding, haiku -> highspeed
  await post("claude-opus-4-8", { "x-llm-force": "kimi" });
  assert.equal(received.body.model, "k3-256k", "kimi opus -> k3-256k");
  await post("claude-sonnet-5", { "x-llm-force": "kimi" });
  assert.equal(received.body.model, "kimi-for-coding", "kimi sonnet -> kimi-for-coding");
  await post("claude-haiku-4-5", { "x-llm-force": "kimi" });
  assert.equal(received.body.model, "kimi-for-coding-highspeed", "kimi haiku -> highspeed");

  // unclassified claude-* falls to the profile default
  await post("claude-experimental-x", { "x-llm-force": "kimi" });
  assert.equal(received.body.model, "k3-256k", "unclassified claude-* -> kimi default");

  // non-claude model passes through unchanged even with the header
  await post("glm-5-turbo", { "x-llm-force": "zai" });
  assert.equal(received.body.model, "glm-5-turbo", "non-claude must pass through");

  // unknown profile: leave the model unchanged (safe fall-through)
  await post("claude-sonnet-5", { "x-llm-force": "nope" });
  assert.equal(received.body.model, "claude-sonnet-5", "unknown profile must not remap");

  // no header: claude-* untouched (normal Anthropic session)
  await post("claude-sonnet-4-6", {});
  assert.equal(received.body.model, "claude-sonnet-4-6", "no header must not remap");

  // the force header must be stripped before forwarding upstream
  await post("claude-sonnet-5", { "x-llm-force": "kimi" });
  assert.equal(received.headers["x-llm-force"], undefined, "force header must be stripped");

  console.log("PASS: force-remap");
} finally {
  proc.kill();
  upstream.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
