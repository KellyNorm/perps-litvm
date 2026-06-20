// Same-origin proxy for public exchange data (Vercel serverless).
//
// The browser fetches /api/px/<exchange>/<rest> (relative, same-origin). This runs the
// actual upstream fetch server-side, so it works even where the user's network DNS-blocks
// the exchange APIs at the ISP level. Dev uses an equivalent Vite server.proxy
// (frontend/vite.config.js). Display-only reference prices — never the settlement mark.
//
// Whitelist only. The first path segment selects the upstream host from a fixed map;
// any unknown key is rejected (no open proxy / SSRF). Only GET is allowed.

const HOSTS = {
  kraken: "https://api.kraken.com",
  bybit: "https://api.bybit.com",
  coinbase: "https://api.exchange.coinbase.com",
};

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  // req.query.path is the captured [...path] catch-all: ["kraken", "0", "public", "OHLC"].
  const segments = [].concat(req.query.path || []);
  const exchange = segments[0];
  const base = HOSTS[exchange];
  if (!base) {
    res.status(400).json({ error: "unknown exchange" });
    return;
  }

  // Remaining path after the exchange key, plus the original query string (minus `path`).
  const rest = segments.slice(1).map(encodeURIComponent).join("/");
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) {
    if (k === "path") continue;
    for (const val of [].concat(v)) qs.append(k, val);
  }
  const query = qs.toString();
  const upstream = `${base}/${rest}${query ? `?${query}` : ""}`;

  try {
    const r = await fetch(upstream, { headers: { accept: "application/json" } });
    const body = await r.text();
    const ct = r.headers.get("content-type") || "application/json";
    res.status(r.status);
    res.setHeader("content-type", ct);
    // Short edge cache: these are high-frequency reference prices. Kept tight so the
    // deployed live ticker stays close to real-time (no effect on the dev server).
    res.setHeader("cache-control", "s-maxage=1, stale-while-revalidate=2");
    res.send(body);
  } catch (e) {
    res.status(502).json({ error: "upstream fetch failed", detail: String(e?.message || e) });
  }
}
