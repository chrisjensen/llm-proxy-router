// Verifies the zai route strips regex `pattern` keys from tool input_schemas
// (z.ai's RE2 validator rejects PCRE patterns like the Artifact tool's, with
// `[1210] Invalid API parameter`). Run: node test/zai-strip-tool-pattern.test.mjs
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
    { name: "zai", match: /^glm/i, url: "http://127.0.0.1:${upstreamPort}", auth: "strip" },
    { name: "anthropic", match: /./, url: "http://127.0.0.1:${upstreamPort}", auth: "strip" },
  ];`,
);

const routerPort = 8799;
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

// True if any nested object still carries a `pattern` key.
function hasPattern(node) {
  if (Array.isArray(node)) return node.some(hasPattern);
  if (node && typeof node === "object") {
    return "pattern" in node || Object.values(node).some(hasPattern);
  }
  return false;
}

try {
  // Reproduces the Artifact tool shape: nested PCRE pattern (negative lookahead).
  const artifactSchema = {
    type: "object",
    properties: {
      collection: { type: "string", minLength: 1, pattern: "^(?!\\.\\.?(?:\\/|$))[A-Za-z0-9_\\-.~:@+]{1,200}$" },
      writes: {
        type: "array",
        items: { type: "object", properties: { doc_id: { type: "string", pattern: "^[a-z]+$" } } },
      },
    },
  };

  await post({
    model: "glm-5.3",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "Artifact", input_schema: artifactSchema }],
  });

  const schema = received.body.tools[0].input_schema;
  assert.ok(!hasPattern(schema), "all pattern keys must be stripped from the zai tool schema");
  assert.equal(schema.properties.collection.minLength, 1, "sibling constraints must survive");
  assert.equal(schema.properties.collection.type, "string", "sibling constraints must survive");

  // Non-zai route must be left untouched.
  await post({
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "Artifact", input_schema: { type: "object", properties: { id: { type: "string", pattern: "^x$" } } } }],
  });
  assert.ok(
    hasPattern(received.body.tools[0].input_schema),
    "non-zai route must not strip patterns",
  );

  console.log("PASS: zai strip tool pattern");
} finally {
  proc.kill();
  upstream.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
