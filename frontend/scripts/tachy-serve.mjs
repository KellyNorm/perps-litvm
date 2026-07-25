#!/usr/bin/env node
// Minimal local host for the /api/tachy function, so the smoke test can run without the
// Vercel CLI. It exists because `vercel dev` needs a linked project and a login, which
// is a lot of ceremony for "run one handler against a real key".
//
//   cd frontend
//   TACHY_PROVIDER=groq node scripts/tachy-serve.mjs
//   node scripts/tachy-smoke.mjs
//
// THIS IS A TEST HARNESS, NOT A DEPLOY TARGET. It reproduces only the parts of the
// platform contract the handler actually uses: JSON body parsing, res.status/json/
// setHeader, and x-forwarded-for. Production still runs on Vercel's runtime.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";

// Load .env by hand — this harness is deliberately dependency-free, and the keys must
// be in process.env before the handler module is imported (config.js reads lazily, but
// the provider defaults are resolved per request from env).
try {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    // Never clobber a var set on the command line — that is how the provider gets
    // switched per run.
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
} catch {
  console.warn("no .env found; relying on the ambient environment");
}

const { default: handler } = await import("../api/tachy.js");

const PORT = Number(process.env.PORT || 3000);

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks).toString("utf8");

    // Vercel parses a JSON body when the content-type says so, and hands the handler
    // the parsed object. normalizeBody also accepts the raw string, but passing the
    // parsed form keeps this faithful to production.
    let body = raw;
    if ((req.headers["content-type"] || "").includes("application/json")) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }

    // The limiter keys on x-forwarded-for; the platform always sets it at the edge.
    req.headers["x-forwarded-for"] ||= req.socket.remoteAddress || "127.0.0.1";
    req.body = body;

    res.status = (code) => {
      res.statusCode = code;
      return res;
    };
    res.json = (payload) => {
      res.end(JSON.stringify(payload));
      return res;
    };

    try {
      await handler(req, res);
    } catch (err) {
      // The handler is not supposed to throw. If it does, that is the bug the smoke
      // test should surface, so make it loud rather than hanging the socket.
      console.error("[tachy-serve] handler threw:", err);
      if (!res.headersSent) res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: "handler_threw" }));
    }
  });
});

server.listen(PORT, () => {
  const provider = process.env.TACHY_PROVIDER || "gemini";
  console.log(`tachy dev endpoint → http://localhost:${PORT}/api/tachy`);
  console.log(`provider: ${provider}${process.env.TACHY_MODEL ? ` model: ${process.env.TACHY_MODEL}` : ""}`);
});
