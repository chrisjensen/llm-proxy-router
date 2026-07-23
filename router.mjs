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

// Load routing table. Fail loud — a router with no routes is useless.
let routes;
try {
  ({ routes } = await import(pathToFileURL(ROUTES_FILE).href));
} catch (err) {
  console.error(`router: failed to load ROUTES_FILE ${ROUTES_FILE}: ${err}`);
  process.exit(1);
}
if (!Array.isArray(routes) || routes.length === 0) {
  console.error(`router: ROUTES_FILE ${ROUTES_FILE} has no non-empty 'routes' array`);
  process.exit(1);
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

// z.ai-session remap. Claude Code (skills, internal haiku calls) emits claude-*
// models; a z.ai-authed session can't use them against Anthropic. When the
// session sends ZAI_SESSION_HEADER, rewrite claude-* to a z.ai model so the
// request routes to the zai upstream. Non-claude models pass through unchanged.
const ZAI_SESSION_HEADER = "x-zai-session";
const ZAI_MODEL_DEFAULT = process.env.ZAI_MODEL_DEFAULT ?? "glm-4.6";
const ZAI_MODEL_LIGHT = process.env.ZAI_MODEL_LIGHT ?? "glm-4.5-air";

function remapZaiModel(model) {
  if (typeof model !== "string" || !/^claude/i.test(model)) return null;
  return /haiku/i.test(model) ? ZAI_MODEL_LIGHT : ZAI_MODEL_DEFAULT;
}

// z.ai's Anthropic-compatible endpoint rejects `tool_reference` content blocks
// (emitted by Claude Code's advanced-tool-use / ToolSearch deferred-tool flow)
// with `[1210] Invalid API parameter`. Replace them with equivalent text so the
// tool_use/tool_result pairing stays intact. Returns count replaced.
function sanitizeZaiBody(parsed) {
  let n = 0;
  if (!Array.isArray(parsed?.messages)) return n;
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
  return n;
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

    // z.ai session: rewrite claude-* model in body so it routes to zai upstream.
    if (parsed && req.headers[ZAI_SESSION_HEADER] !== undefined) {
      const remapped = remapZaiModel(model);
      if (remapped) {
        parsed.model = remapped;
        model = remapped;
        body = Buffer.from(JSON.stringify(parsed), "utf8");
      }
    }

    const route = pickRoute(model);

    // z.ai rejects tool_reference blocks; rewrite them before forwarding.
    if (route.name === "zai" && parsed) {
      const n = sanitizeZaiBody(parsed);
      if (n) {
        body = Buffer.from(JSON.stringify(parsed), "utf8");
        console.error(`router: sanitized ${n} tool_reference block(s) for zai`);
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
    delete headers[ZAI_SESSION_HEADER];
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
