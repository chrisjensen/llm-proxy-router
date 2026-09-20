// Verifies the synthetic route hoists in-array system-role messages into the
// top-level `system` field (Qwen backend rejects system not at messages[0]).
// Run: node test/synthetic-hoist-system.test.mjs
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "router-test-"));

// Echo upstream captures the body the router forwards.
let received;
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    received = { url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) };
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const upstreamPort = upstream.address().port;

const routesFile = path.join(tmp, "routes.mjs");
fs.writeFileSync(
  routesFile,
  `export const routes = [
    { name: "synthetic", match: /^hf:/i, url: "http://127.0.0.1:${upstreamPort}", auth: "strip" },
    { name: "anthropic", match: /./, url: "http://127.0.0.1:${upstreamPort}", auth: "strip" },
  ];`,
);

const routerPort = 8798;
const proc = spawn("node", [path.join(dir, "..", "router.mjs")], {
  env: { ...process.env, ROUTES_FILE: routesFile, ROUTER_PORT: String(routerPort) },
  stdio: "inherit",
});
await new Promise((r) => setTimeout(r, 400));

async function post(bodyObj) {
  received = undefined;
  await new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: routerPort, method: "POST", path: "/v1/messages",
        headers: { "content-type": "application/json" } },
      (res) => { res.on("data", () => {}); res.on("end", resolve); },
    );
    req.on("error", reject);
    req.end(JSON.stringify(bodyObj));
  });
}

try {
  // Reproduces the SessionStart-hook shape: top-level system + a trailing
  // system-role message in `messages`.
  await post({
    model: "hf:Qwen/Qwen3.6-27B",
    system: "base system prompt",
    messages: [
      { role: "user", content: "hello" },
      { role: "system", content: "CAVEMAN MODE ACTIVE" },
    ],
  });

  const roles = received.body.messages.map((m) => m.role);
  assert.deepEqual(roles, ["user"], "system message must be removed from messages");
  assert.ok(Array.isArray(received.body.system), "system should be normalized to blocks");
  assert.deepEqual(
    received.body.system,
    [
      { type: "text", text: "base system prompt" },
      { type: "text", text: "CAVEMAN MODE ACTIVE" },
    ],
    "hook system message should be appended to top-level system",
  );

  // Non-synthetic route must be left untouched.
  await post({
    model: "claude-sonnet-4-6",
    messages: [
      { role: "user", content: "hi" },
      { role: "system", content: "leave me" },
    ],
  });
  assert.deepEqual(
    received.body.messages.map((m) => m.role),
    ["user", "system"],
    "non-synthetic route must not hoist",
  );

  console.log("PASS: synthetic hoist system");
} finally {
  proc.kill();
  upstream.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
