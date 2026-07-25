// POST /api/tachy — Tachy's only server endpoint.
//
// WHY THIS EXISTS: the model provider needs an API key, and a key in a Vite bundle is a
// public key. The browser talks to this function; only this function talks to the
// provider. Everything else here — caps, rate limiting, validation, fallbacks — exists
// to make that key survivable in a public app.
//
// V1 IS EDUCATION ONLY. No money path, no trade execution, no contract interaction. See
// _lib/schema.js for the structural reason a response cannot carry an action.
//
// PROVIDER-AGNOSTIC BY CONSTRUCTION: this handler names no vendor. The driver is chosen
// by TACHY_PROVIDER and everything below the selection is identical for all of them —
// same system prompt, same caps, same validation, same fallbacks. That is what makes
// "do the rails hold on a different model?" an answerable question rather than a
// rewrite: swapping the provider changes one env var and nothing else in this file.
//
// ISOLATION: this file and _lib/ import nothing from src/. The perps and prediction
// trees are untouched by this feature.
//
// Handler order is deliberate — cheapest and most abusable checks first, so an abusive
// caller is rejected before costing us a provider call:
//   method -> body size -> input caps -> rate limit -> prompt -> provider -> validate.

import { limits, modelId, providerTimeoutMs } from "./_lib/config.js";
import { CLIENT_MESSAGES, REASON, clientReply, fallbackReply } from "./_lib/fallbacks.js";
import { activeProvider } from "./_lib/providers/index.js";
import { createLimiter, memoryDriver } from "./_lib/rateLimit.js";
import { buildTurns, clientKey, normalizeBody } from "./_lib/request.js";
import { parseAndValidate } from "./_lib/schema.js";
import { buildSystemInstruction } from "./_lib/systemPrompt.js";

// Module scope, so the counter survives across invocations on a warm instance — which
// is the only reason the in-memory driver limits anything at all. Lazily built so tests
// can set env first. See rateLimit.js for the per-instance caveat.
let limiter;
function getLimiter(caps) {
  if (!limiter) {
    limiter = createLimiter({
      driver: memoryDriver(),
      perMinute: caps.perMinute,
      perHour: caps.perHour,
    });
  }
  return limiter;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, clientReply(CLIENT_MESSAGES.badRequest), "method_not_allowed");
  }

  // Resolved once per request, before anything else needs it: the rate limits are the
  // active provider's, so the driver has to be known before the caps are.
  const active = activeProvider();
  const caps = limits(active);

  // Cheap pre-parse rejection. content-length can lie, so the real enforcement is the
  // per-field caps below; this just avoids parsing an obviously oversized body.
  const declared = Number.parseInt(req.headers?.["content-length"] ?? "", 10);
  if (Number.isFinite(declared) && declared > caps.maxBodyBytes) {
    return send(res, 413, clientReply(CLIENT_MESSAGES.tooLong), "body_too_large");
  }

  const parsed = normalizeBody(req.body, caps);
  if (!parsed.ok) {
    const text = parsed.status === 413 ? CLIENT_MESSAGES.tooLong : CLIENT_MESSAGES.badRequest;
    return send(res, parsed.status, clientReply(text), parsed.reason);
  }

  const { message, history, locale, view } = parsed.value;

  const verdict = await getLimiter(caps).check(clientKey(req));
  if (!verdict.allowed) {
    res.setHeader("Retry-After", String(verdict.retryAfter));
    return send(res, 429, clientReply(CLIENT_MESSAGES.rateLimited), `rate_limited_${verdict.scope}`);
  }

  // The system prompt is deliberately NOT parameterised by provider. If a rail only
  // holds because one vendor's model is agreeable, it is not a rail — so every driver
  // gets the identical instruction and has to hold it on its own.
  const result = await active.generate({
    apiKey: active.apiKey(),
    model: modelId(active),
    systemInstruction: buildSystemInstruction({ view, locale }),
    turns: buildTurns({ message, history }),
    timeoutMs: providerTimeoutMs(),
  });

  if (!result.ok) {
    // 200, not 5xx: a provider outage is not the user's fault and must not surface as a
    // browser error. The in-character message carries it instead.
    return send(res, 200, fallbackReply(result.reason), result.reason, true);
  }

  // Gate 2. Raw model text has not been trusted up to this point and is not trusted now
  // — only the validated, allowlisted fields go into the envelope.
  const validated = parseAndValidate(result.text);
  if (!validated.ok) {
    console.error("[tachy] model response failed schema validation");
    return send(res, 200, fallbackReply(REASON.INVALID_RESPONSE), REASON.INVALID_RESPONSE, true);
  }

  return send(res, 200, validated.reply, null, false);
}

// Single exit point, so every response — success, client error, provider failure — has
// the same shape and the client never needs to branch on status to find the text.
function send(res, status, reply, reason, fallback = false) {
  res.setHeader("content-type", "application/json; charset=utf-8");
  // This is per-user conversational output; caching it would be a correctness bug.
  res.setHeader("cache-control", "no-store");

  return res.status(status).json({
    ok: status === 200,
    reply,
    // `reason` is a short code for logs and client telemetry. It is never provider text
    // and is safe to expose.
    meta: { fallback, reason: reason ?? null },
  });
}
