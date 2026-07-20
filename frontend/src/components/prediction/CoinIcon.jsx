import { ASSET_BADGE, DEFAULT_BADGE } from "../../lib/prediction/predictionConfig.js";

// Coin icons are BUNDLED LOCAL FILES — no CDN, nothing fetched at runtime. The RPC is
// already a fragile dependency; images must not add a second one that can fail.
//
// Source: `cryptocurrency-icons` v0.18.1, CC0-1.0 (public domain, redistribution
// permitted). The .svg files were extracted into ./assets/coins and committed; the
// npm package is NOT a dependency. Licence text lives alongside them.
//
// TO ADD A MISSING LOGO: drop `<lowercase-symbol>.svg` into src/assets/coins/ and it
// is picked up automatically — no code change. For symbols whose on-chain string
// differs from the icon filename, add an alias in SYMBOL_ALIAS below.
const ICONS = import.meta.glob("../../assets/coins/*.svg", { eager: true, query: "?url", import: "default" });

const byName = {};
for (const [path, url] of Object.entries(ICONS)) {
  const name = path.split("/").pop().replace(".svg", "").toUpperCase();
  byName[name] = url;
}

// The factory's asset 9 is the string "ZCASH"; the icon file is zec.svg. Without this
// alias the lookup silently misses and ZCASH falls back to a text badge.
const SYMBOL_ALIAS = { ZCASH: "ZEC" };

export function hasIcon(symbol) {
  const s = (symbol || "").toUpperCase();
  return Boolean(byName[SYMBOL_ALIAS[s] || s]);
}

/**
 * Coin logo with a styled monogram fallback.
 *
 * The fallback is deliberately the same size/radius/border treatment as the real
 * icons so a logo-less asset (RAIN, HYPE) reads as an intentional badge rather than
 * a broken image.
 */
export default function CoinIcon({ symbol, size = 30 }) {
  const s = (symbol || "").toUpperCase();
  const url = byName[SYMBOL_ALIAS[s] || s];
  const badge = ASSET_BADGE[s] || DEFAULT_BADGE;

  if (url) {
    return (
      <span className="pm-coin" style={{ width: size, height: size }}>
        <img src={url} alt="" aria-hidden="true" width={size} height={size} loading="lazy" />
      </span>
    );
  }

  // Monogram fallback: up to 4 chars so RAIN/HYPE render in full.
  return (
    <span
      className="pm-coin pm-coin-fallback"
      style={{
        width: size,
        height: size,
        color: badge.fg,
        background: badge.bg,
        border: `1px solid ${badge.bd}`,
        fontSize: s.length > 3 ? size * 0.3 : size * 0.36,
      }}
      aria-hidden="true"
    >
      {s.slice(0, 4)}
    </span>
  );
}
