// Verifies the kimi route strips tool_addition/tool_removal content blocks
// (api.kimi.ai rejects them with a bare 400 "Invalid request Error") and
// hoists inline tool definitions into top-level `tools`.
// Run: node test/kimi-strip-tool-addition.test.mjs
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
    { name: "kimi", match: /^(kimi|moonshot|k3)/i, url: "http://127.0.0.1:${upstreamPort}", auth: "strip" },
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
  // Reproduces the real kclaude failure: Claude Code's mid-conversation tool
  // changes append tool_addition blocks (tool_reference form) to messages, and
  // the referenced tools already exist in top-level `tools`.
  const batchTool = { name: "mcp__claude_ai_Claude_Docs__batch",
    input_schema: { type: "object", properties: {} } };
  await post({
    model: "k3-256k",
    system: "You are Claude Code.",
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [
        { type: "tool_addition", tool: { type: "tool_reference", name: batchTool.name } },
        { type: "text", text: "ok" },
        // Inline definition not present in top-level tools -> must be hoisted.
        { type: "tool_addition", tool: { name: "NewTool",
          input_schema: { type: "object", properties: { a: { type: "string" } } } } },
        { type: "tool_removal", tool: { type: "tool_reference", name: "GoneTool" } },
      ] },
    ],
    tools: [batchTool, { name: "GoneTool", input_schema: { type: "object", properties: {} } }],
  });

  const blocks = received.body.messages[1].content;
  assert.ok(
    blocks.every((b) => b.type !== "tool_addition" && b.type !== "tool_removal"),
    "all tool_addition/tool_removal blocks must be stripped from kimi messages",
  );
  assert.deepEqual(blocks.map((b) => b.type), ["text"], "other blocks must survive");
  const toolNames = received.body.tools.map((t) => t.name);
  assert.ok(toolNames.includes("NewTool"), "inline tool_addition definition must be hoisted into tools");
  assert.ok(!toolNames.includes("GoneTool"), "tool_removal target must be dropped from tools");
  assert.ok(toolNames.includes(batchTool.name), "existing tools must survive");

  // Sanity: kimi-alias models route here too.
  await post({ model: "kimi-for-coding", messages: [{ role: "user", content: "hi" }] });
  assert.equal(received.body.model, "kimi-for-coding");

  console.log("kimi-strip-tool-addition: all assertions passed");
} finally {
  proc.kill();
  upstream.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
