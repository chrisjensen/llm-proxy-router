// Config-driven model-based LLM router. Dispatches on body.model using an
// external routing table (routes.mjs). First matching route wins.
//
//   claude -> headroom :8787 -> this router :8789 -> upstream (per route)
//
// Routes + auth live in ROUTES_FILE (default ~/.config/headroom-router/routes.mjs).
// Adding a provider = append a route entry there + restart; no code change.

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PORT = Number(process.env.ROUTER_PORT ?? 8789);
const HOST = process.env.ROUTER_HOST ?? "127.0.0.1";

const expandHome = (p) =>
  p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;

const ROUTES_FILE = expandHome(
  process.env.ROUTES_FILE ??
    path.join(os.homedir(), ".config/headroom-router/routes.mjs"),
);

// Load routing table + force-remap profiles. Fail loud on routes — a router with
// no routes is useless. forceProfiles is optional (warn, don't crash): its absence
// just disables the X-LLM-Force header.
let routes;
let forceProfiles;
try {
  ({ routes, forceProfiles } = await import(pathToFileURL(ROUTES_FILE).href));
} catch (err) {
  console.error(`router: failed to load ROUTES_FILE ${ROUTES_FILE}: ${err}`);
  process.exit(1);
}
if (!Array.isArray(routes) || routes.length === 0) {
  console.error(`router: ROUTES_FILE ${ROUTES_FILE} has no non-empty 'routes' array`);
  process.exit(1);
}
if (!forceProfiles || typeof forceProfiles !== "object") {
  console.warn(`router: ROUTES_FILE ${ROUTES_FILE} has no 'forceProfiles' — X-LLM-Force disabled`);
  forceProfiles = {};
}

// Normalize match to a RegExp.
for (const r of routes) {
  if (typeof r.match === "string") r.match = new RegExp(r.match);
  if (!(r.match instanceof RegExp)) {
    console.error(`router: route '${r.name}' has invalid match (need RegExp or string)`);
    process.exit(1);
  }
}

// Resolve a keyed route's secret: env var first, else parse keyFile.
function resolveKey(route) {
  const varName = route.keyVar ?? route.keyEnv;
  if (route.keyEnv && process.env[route.keyEnv]) return process.env[route.keyEnv];
  if (route.keyFile && varName) {
    const file = expandHome(route.keyFile);
    try {
      const re = new RegExp(`^\\s*(?:export\\s+)?${varName}\\s*=\\s*(.+?)\\s*$`);
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        const m = line.match(re);
        if (m) return m[1].replace(/^['"]|['"]$/g, "");
      }
    } catch {}
  }
  return null;
}

// Resolve keys once at boot; cache on the route. Warn (don't crash) on miss.
for (const r of routes) {
  if (r.auth === "apikey" || r.auth === "bearer") {
    r._key = resolveKey(r);
    if (!r._key) console.warn(`router: route '${r.name}' (${r.auth}) has NO key resolved`);
  }
}

function pickRoute(model) {
  const m = typeof model === "string" ? model : "";
  return routes.find((r) => r.match.test(m)) ?? routes[routes.length - 1];
}

// Force-remap. Claude Code (skills, subagents, internal calls) emits literal
// claude-* model names; a session authed against a non-Anthropic upstream can't
// route those to Anthropic. When the session sends FORCE_HEADER: <profile>, rewrite
// each claude-* model to that profile's provider model (see forceProfiles in
// routes.mjs) so it routes to the right upstream. Non-claude models pass through.
const FORCE_HEADER = "x-llm-force";

// Classify a claude-* model name into a profile key. Non-claude -> null.
function classifyClaude(model) {
  if (typeof model !== "string" || !/^claude/i.test(model)) return null;
  if (/haiku/i.test(model)) return "haiku";
  if (/sonnet/i.test(model)) return "sonnet";
  if (/opus/i.test(model)) return "opus";
  if (/fable/i.test(model)) return "fable";
  return "default";
}

// Resolve the forced target model for a claude-* model under a named profile.
// Returns null when the model isn't claude-* or the profile is unknown.
function remapForcedModel(model, profileName) {
  const cls = classifyClaude(model);
  if (cls === null) return null;
  const profile = forceProfiles[profileName];
  if (!profile) return null;
  return profile[cls] ?? profile.default ?? null;
}

// z.ai's Anthropic-compatible endpoint rejects two things Claude Code emits, each
// with `[1210] Invalid API parameter`:
//   1. `tool_reference` content blocks (advanced-tool-use / ToolSearch deferred-tool
//      flow) — replaced with equivalent text so tool_use/tool_result pairing stays intact.
//   2. tool `input_schema` regex `pattern`s using PCRE features (negative lookahead,
//      `\p{…}`, etc.) that z.ai's Go/RE2 validator can't compile — e.g. the Artifact tool.
//      `pattern` is advisory client-side arg validation z.ai doesn't honor, so we drop it.
// Returns count of changes made.
function sanitizeZaiBody(parsed) {
  let n = 0;
  if (Array.isArray(parsed?.messages)) {
    for (const m of parsed.messages) {
      if (!Array.isArray(m.content)) continue;
      for (const blk of m.content) {
        if (blk?.type !== "tool_result" || !Array.isArray(blk.content)) continue;
        blk.content = blk.content.map((x) => {
          if (x?.type === "tool_reference") {
            n++;
            return { type: "text", text: `[tool loaded: ${x.tool_name ?? "?"}]` };
          }
          return x;
        });
      }
    }
  }
  if (Array.isArray(parsed?.tools)) {
    for (const tool of parsed.tools) n += stripSchemaPatterns(tool?.input_schema);
  }
  return n;
}

// Kimi's Anthropic-compatible endpoint rejects `tool_addition` / `tool_removal`
// content blocks (Claude Code's mid-conversation-tool-changes flow) with a bare
// 400 "Invalid request Error". Remove them from messages: inline tool
// definitions in tool_addition are hoisted into top-level `tools` (if not
// already there); tool_reference additions are dropped (their target is already
// defined in `tools`); tool_removal drops the named tool from `tools`.
// Returns count of blocks removed.
function stripToolChanges(parsed) {
  if (!Array.isArray(parsed?.messages)) return 0;
  const tools = parsed.tools ?? (parsed.tools = []);
  let n = 0;
  for (const m of parsed.messages) {
    if (!Array.isArray(m.content)) continue;
    const kept = [];
    for (const blk of m.content) {
      if (blk?.type === "tool_addition") {
        n++;
        const tool = blk.tool;
        if (
          tool && typeof tool === "object" && tool.type !== "tool_reference" &&
          tool.name && !tools.some((t) => t.name === tool.name)
        ) {
          tools.push(tool);
        }
      } else if (blk?.type === "tool_removal" && blk.tool?.name) {
        n++;
        const idx = tools.findIndex((t) => t.name === blk.tool.name);
        if (idx !== -1) tools.splice(idx, 1);
      } else {
        kept.push(blk);
      }
    }
    m.content = kept;
  }
  return n;
}

// Recursively delete every `pattern` key from a JSON-Schema object. Returns count removed.
function stripSchemaPatterns(node) {
  let n = 0;
  if (Array.isArray(node)) {
    for (const item of node) n += stripSchemaPatterns(item);
  } else if (node && typeof node === "object") {
    if ("pattern" in node) {
      delete node.pattern;
      n++;
    }
    for (const value of Object.values(node)) n += stripSchemaPatterns(value);
  }
  return n;
}

// synthetic.new dispatches each hf: model to its own inference backend. The
// Qwen backend enforces OpenAI ordering and rejects any system-role message
// that is not messages[0] with `400 System message must be at the beginning`.
// Claude Code's SessionStart hooks inject their output as system-role messages
// appended to `messages`, tripping this. Hoist every in-array system message
// into the Anthropic top-level `system` field (where it belongs) and drop it
// from `messages`. Returns count hoisted.
function hoistSystemMessages(parsed) {
  if (!Array.isArray(parsed?.messages)) return 0;

  // Normalize a message's content to an array of Anthropic content blocks.
  const toBlocks = (content) => {
    if (typeof content === "string") return [{ type: "text", text: content }];
    if (Array.isArray(content)) return content;
    return [];
  };

  const hoisted = [];
  parsed.messages = parsed.messages.filter((m) => {
    if (m?.role !== "system") return true;
    hoisted.push(...toBlocks(m.content));
    return false;
  });
  if (hoisted.length === 0) return 0;

  // Merge into top-level system, normalizing it to a block array first.
  const existing =
    parsed.system == null ? [] : toBlocks(parsed.system);
  parsed.system = [...existing, ...hoisted];
  return hoisted.length;
}

// Hop-by-hop headers must not be forwarded.
const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok\n");
    return;
  }

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let body = Buffer.concat(chunks);

    let model, parsed;
    try {
      parsed = JSON.parse(body.toString("utf8"));
      model = parsed.model;
    } catch {
      // non-JSON / no body -> falls through to catch-all route
    }

    // Force-remap: rewrite a leaked claude-* model in the body to the header
    // profile's provider model so it routes to the right upstream.
    if (parsed && req.headers[FORCE_HEADER] !== undefined) {
      const profileName = String(req.headers[FORCE_HEADER]);
      if (!forceProfiles[profileName]) {
        console.warn(`router: X-LLM-Force '${profileName}' is not a known profile — model unchanged`);
      }
      const remapped = remapForcedModel(model, profileName);
      if (remapped) {
        parsed.model = remapped;
        model = remapped;
        body = Buffer.from(JSON.stringify(parsed), "utf8");
      }
    }

    const route = pickRoute(model);

    // z.ai rejects tool_reference blocks and unsupported schema patterns; fix before forwarding.
    if (route.name === "zai" && parsed) {
      const n = sanitizeZaiBody(parsed);
      if (n) {
        body = Buffer.from(JSON.stringify(parsed), "utf8");
        console.error(`router: sanitized ${n} block(s)/pattern(s) for zai`);
      }
    }

    // kimi rejects tool_addition/tool_removal blocks; fix before forwarding.
    if (route.name === "kimi" && parsed) {
      const n = stripToolChanges(parsed);
      if (n) {
        body = Buffer.from(JSON.stringify(parsed), "utf8");
        console.error(`router: stripped ${n} tool_addition/tool_removal block(s) for kimi`);
      }
    }

    // synthetic's Qwen backend rejects system-role messages not at the start;
    // hoist any into the top-level `system` field before forwarding.
    if (route.name === "synthetic" && parsed) {
      const n = hoistSystemMessages(parsed);
      if (n) {
        body = Buffer.from(JSON.stringify(parsed), "utf8");
        console.error(`router: hoisted ${n} in-array system message(s) for synthetic`);
      }
    }

    const target = new URL(route.url);
    const isHttps = target.protocol === "https:";

    // Build upstream headers.
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP.has(k.toLowerCase())) continue;
      headers[k] = v;
    }
    headers["host"] = target.host;
    delete headers[FORCE_HEADER];
    if (body.length) headers["content-length"] = String(body.length);

    switch (route.auth) {
      case "apikey":
      case "bearer":
        if (!route._key) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ error: `router: route '${route.name}' key not configured` }),
          );
          return;
        }
        delete headers["authorization"];
        delete headers["x-api-key"];
        if (route.auth === "apikey") headers["x-api-key"] = route._key;
        else headers["authorization"] = `Bearer ${route._key}`;
        break;
      case "strip":
        delete headers["authorization"];
        delete headers["x-api-key"];
        break;
      case "verbatim":
      default:
        // forward authorization / x-api-key / anthropic-beta as-is
        break;
    }

    const basePath = target.pathname === "/" ? "" : target.pathname.replace(/\/$/, "");
    const upstreamPath = basePath + req.url;
    const client = isHttps ? https : http;
    const port = target.port || (isHttps ? 443 : 80);

    const proxyReq = client.request(
      { host: target.hostname, port, method: req.method, path: upstreamPath, headers },
      (proxyRes) => {
        const status = proxyRes.statusCode ?? 502;
        res.writeHead(status, proxyRes.headers);
        // Capture failing upstream responses for diagnosis (req body + resp body).
        if (status >= 400) {
          const respChunks = [];
          proxyRes.on("data", (c) => {
            respChunks.push(c);
            res.write(c);
          });
          proxyRes.on("end", () => {
            res.end();
            try {
              const safeHeaders = { ...headers };
              delete safeHeaders["authorization"];
              delete safeHeaders["x-api-key"];
              const dump = {
                ts: new Date().toISOString(),
                route: route.name,
                url: route.url,
                model,
                status,
                requestHeaders: safeHeaders,
                requestBody: body.toString("utf8"),
                responseBody: Buffer.concat(respChunks).toString("utf8"),
              };
              const dir = expandHome("~/.headroom/logs");
              const file = path.join(dir, `router-fail-${Date.now()}.json`);
              fs.writeFileSync(file, JSON.stringify(dump, null, 2));
              console.error(`router: captured ${status} from ${route.name} -> ${file}`);
            } catch (e) {
              console.error(`router: failed to write fail dump: ${e}`);
            }
          });
        } else {
          proxyRes.pipe(res);
        }
      },
    );

    proxyReq.on("error", (err) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "router upstream error", detail: String(err) }));
    });

    if (body.length) proxyReq.write(body);
    proxyReq.end();
  });

  req.on("error", () => {
    if (!res.headersSent) res.writeHead(400);
    res.end();
  });
});

server.listen(PORT, HOST, () => {
  const summary = routes
    .map((r) => {
      const key = r.auth === "apikey" || r.auth === "bearer" ? (r._key ? "" : " [NO KEY]") : "";
      return `${r.name}(${r.match.source}->${r.url},${r.auth}${key})`;
    })
    .join("; ");
  console.log(`model-router on http://${HOST}:${PORT} — routes: ${summary}`);
});
