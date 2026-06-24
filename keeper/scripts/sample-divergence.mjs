// STEP 0 — DIVERGENCE SAMPLING (read-only, no contract/ABI change).
//
// Picks CB_DEV_BPS (divergence band) and CB_SEC_MAXAGE (secondary staleness
// window) per market from REAL data instead of a guess. For BTC and ETH it
// samples, on a fixed cadence:
//   - the RedStone PRIMARY mark, scaled exactly as executeRequest sees it
//     (fetchMark -> price1e8 — same helper the keeper uses), and
//   - the DIA SECONDARY via its AggregatorV3 adapter (latestRoundData),
//     normalized 1e18 -> 1e8 (÷1e10) exactly like _checkBreaker on-chain.
//
// Per sample it logs: wall ts, redstone price, dia price, |Δ|/dia in bps, and
// DIA's updatedAt age in seconds (measured against the latest chain block
// timestamp, the same clock _checkBreaker compares to). At the end it prints the
// divergence distribution (median / p95 / p99 / max) and the DIA staleness-age
// distribution (median / p95 / max), and writes every row to a CSV.
//
// Read-only: no private key, no state-changing calls. Mirrors keeper config so
// the numbers are apples-to-apples with the live execution path.
//
// Usage:
//   cd keeper && node scripts/sample-divergence.mjs --once         # single sample, connectivity check
//   cd keeper && node scripts/sample-divergence.mjs --interval 12 --count 900   # ~3h at 12s
//   cd keeper && node scripts/sample-divergence.mjs --interval 12 --minutes 180
// Env (optional, all defaulted to the documented 4441 values):
//   LITVM_RPC_URL, REDSTONE_DATA_SERVICE, DIA_BTC_ADDR, DIA_ETH_ADDR

import { ethers } from "ethers";
import { fetchMark, feedOf } from "../lib/redstone.mjs";
import { writeFileSync, appendFileSync, existsSync } from "node:fs";

// ---- config (all read-only; defaults are the verified chain-4441 values) ----
const RPC = process.env.LITVM_RPC_URL || "https://liteforge.rpc.caldera.xyz/infra-partner-http";
const DATA_SERVICE = process.env.REDSTONE_DATA_SERVICE || "redstone-primary-prod";

// DIA AggregatorV3 adapters on 4441 (docs/oracle-discovery.md). 18-decimal.
const MARKETS = [
  { name: "BTC", feed: ethers.utils.formatBytes32String("BTC"), dia: process.env.DIA_BTC_ADDR || "0x7d0445782E383223c7B4B660bb96b87213e9b605" },
  { name: "ETH", feed: ethers.utils.formatBytes32String("ETH"), dia: process.env.DIA_ETH_ADDR || "0xc760B46beF9eD3F9A3d2b825164324D6703F0185" },
];

// AggregatorV3 minimal ABI — the exact getters _checkBreaker uses.
const AGG_ABI = [
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
];

const BPS = 10000n;

// ---- arg parsing ------------------------------------------------------------
function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const ONCE = process.argv.includes("--once");
const INTERVAL_S = Number(arg("interval", "12"));
const COUNT = arg("count", null);
const MINUTES = arg("minutes", null);
const TARGET_SAMPLES = ONCE
  ? 1
  : COUNT
    ? Number(COUNT)
    : MINUTES
      ? Math.ceil((Number(MINUTES) * 60) / INTERVAL_S)
      : 900; // default ~3h at 12s

const CSV = arg("out", `logs/divergence-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.csv`);

// ---- normalization: DIA answer (1e18) -> 1e8, exactly as _checkBreaker -------
// secondary1e8 = answer / 10**(decimals-8); for DIA decimals=18 that is ÷1e10.
function toSecondary1e8(answer, decimals) {
  if (decimals > 8) return answer / 10n ** BigInt(decimals - 8);
  if (decimals < 8) return answer * 10n ** BigInt(8 - decimals);
  return answer;
}

// divergence in bps: |primary - secondary| * 1e4 / secondary  (integer, like-on-chain feel)
function bps(primary1e8, secondary1e8) {
  if (secondary1e8 === 0n) return null;
  const diff = primary1e8 > secondary1e8 ? primary1e8 - secondary1e8 : secondary1e8 - primary1e8;
  return Number((diff * BPS) / secondary1e8);
}

const fmt8 = (v) => Number(ethers.utils.formatUnits(v.toString(), 8));

// ---- distribution helpers ---------------------------------------------------
function pct(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}
function summarize(label, arr, unit) {
  const s = [...arr].sort((a, b) => a - b);
  const median = pct(s, 50), p95 = pct(s, 95), p99 = pct(s, 99), max = s[s.length - 1], min = s[0];
  console.log(
    `  ${label.padEnd(22)} n=${s.length}  min=${fmtN(min)}  median=${fmtN(median)}  p95=${fmtN(p95)}  p99=${fmtN(p99)}  max=${fmtN(max)} ${unit}`,
  );
  return { n: s.length, min, median, p95, p99, max };
}
const fmtN = (v) => (v == null ? "n/a" : Number.isInteger(v) ? String(v) : v.toFixed(2));

// ---- one sample across all markets ------------------------------------------
async function sample(provider, diaContracts, decimalsByName, blockTs) {
  const rows = [];
  for (const m of MARKETS) {
    let redstone1e8 = null, dia1e8 = null, divBps = null, age = null, note = "";
    try {
      const mark = await fetchMark(DATA_SERVICE, m.name); // {ts, price1e8 (BigNumber)}
      redstone1e8 = BigInt(mark.price1e8.toString());
    } catch (e) {
      note += `redstone_err:${(e.message || e).toString().slice(0, 60)};`;
    }
    try {
      const rd = await diaContracts[m.name].latestRoundData();
      const answer = BigInt(rd.answer.toString());
      const updatedAt = Number(rd.updatedAt.toString());
      const dec = decimalsByName[m.name];
      if (answer <= 0n) note += "dia_nonpos;";
      else dia1e8 = toSecondary1e8(answer, dec);
      age = blockTs - updatedAt; // seconds, vs chain clock (matches _checkBreaker)
    } catch (e) {
      note += `dia_err:${(e.message || e).toString().slice(0, 60)};`;
    }
    if (redstone1e8 != null && dia1e8 != null) divBps = bps(redstone1e8, dia1e8);
    rows.push({ market: m.name, redstone1e8, dia1e8, divBps, age, note });
  }
  return rows;
}

// ---- main -------------------------------------------------------------------
async function main() {
  console.log(`RPC          ${RPC}`);
  console.log(`data service ${DATA_SERVICE}`);
  console.log(`markets      ${MARKETS.map((m) => `${m.name}(${feedOf(m.feed)})->${m.dia}`).join(", ")}`);
  console.log(`plan         ${TARGET_SAMPLES} sample(s) @ ${INTERVAL_S}s  (~${((TARGET_SAMPLES * INTERVAL_S) / 60).toFixed(0)} min)`);
  console.log(`csv          keeper/${CSV}\n`);

  const provider = new ethers.providers.JsonRpcProvider(RPC);
  const dia = {}, decimalsByName = {};
  for (const m of MARKETS) {
    dia[m.name] = new ethers.Contract(m.dia, AGG_ABI, provider);
    decimalsByName[m.name] = await dia[m.name].decimals();
    console.log(`  ${m.name} DIA decimals = ${decimalsByName[m.name]}`);
  }
  console.log("");

  if (!existsSync(CSV)) writeFileSync(CSV, "iso_ts,block_ts,market,redstone_1e8,dia_1e8,redstone_usd,dia_usd,div_bps,dia_age_s,note\n");

  const acc = { BTC: { bps: [], age: [] }, ETH: { bps: [], age: [] } };

  for (let i = 0; i < TARGET_SAMPLES; i++) {
    let blockTs;
    try {
      blockTs = (await provider.getBlock("latest")).timestamp;
    } catch (e) {
      blockTs = Math.floor(Date.now() / 1000);
    }
    const iso = new Date().toISOString();
    const rows = await sample(provider, dia, decimalsByName, blockTs);
    for (const r of rows) {
      const rUsd = r.redstone1e8 != null ? fmt8(r.redstone1e8) : null;
      const dUsd = r.dia1e8 != null ? fmt8(r.dia1e8) : null;
      appendFileSync(
        CSV,
        `${iso},${blockTs},${r.market},${r.redstone1e8 ?? ""},${r.dia1e8 ?? ""},${rUsd ?? ""},${dUsd ?? ""},${r.divBps ?? ""},${r.age ?? ""},${r.note}\n`,
      );
      if (r.divBps != null) acc[r.market].bps.push(r.divBps);
      if (r.age != null) acc[r.market].age.push(r.age);
      console.log(
        `[${iso.slice(11, 19)}] ${r.market}  rs=${rUsd != null ? rUsd.toFixed(2) : "ERR"}  dia=${dUsd != null ? dUsd.toFixed(2) : "ERR"}  ` +
          `div=${r.divBps != null ? r.divBps + "bps" : "n/a"}  dia_age=${r.age != null ? r.age + "s" : "n/a"}${r.note ? "  " + r.note : ""}`,
      );
    }
    if (i < TARGET_SAMPLES - 1) await new Promise((res) => setTimeout(res, INTERVAL_S * 1000));
  }

  // ---- report ----
  console.log(`\n================ DISTRIBUTION (n samples per market) ================`);
  for (const m of MARKETS) {
    console.log(`\n${m.name}:`);
    summarize("divergence", acc[m.name].bps, "bps");
    summarize("dia staleness age", acc[m.name].age, "s");
  }
  console.log(`\nCSV written: keeper/${CSV}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
