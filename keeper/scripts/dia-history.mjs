// STEP 0 — DIA HISTORY WALK (read-only, standalone). No 2h wait.
//
// DIA's AggregatorV3 adapters keep ROUNDS. Instead of sampling live for hours to
// observe the staleness sawtooth, we read it straight out of history: from the
// latest roundId, walk getRoundData(roundId - n) backwards until the feed stops
// retaining rounds (revert / zero answer / zero updatedAt). Consecutive
// updatedAt gaps ARE the real per-feed staleness sawtooth -> CB_SEC_MAXAGE must
// sit above each feed's MAX observed gap.
//
// Divergence: historical RedStone marks aren't cheaply available (pull oracle,
// signed on demand — no historical query). So divergence is reported from the
// live samples already in logs/divergence-run1.csv (however many landed before
// the live run was stopped), and clearly labeled as such.
//
// STANDALONE: needs ONLY an RPC URL and the two DIA addresses — no private key,
// no other repo files, no RedStone. Defaults below are the verified chain-4441
// values; override via env to run off-Codespace on an always-on box:
//   LITVM_RPC_URL, DIA_BTC_ADDR, DIA_ETH_ADDR
// Usage:  node dia-history.mjs [--max 5000] [--csv path-to-live-samples.csv]

import { ethers } from "ethers";
import { readFileSync, existsSync } from "node:fs";

const RPC = process.env.LITVM_RPC_URL || "https://liteforge.rpc.caldera.xyz/infra-partner-http";
const MARKETS = [
  { name: "BTC", dia: process.env.DIA_BTC_ADDR || "0x7d0445782E383223c7B4B660bb96b87213e9b605" },
  { name: "ETH", dia: process.env.DIA_ETH_ADDR || "0xc760B46beF9eD3F9A3d2b825164324D6703F0185" },
];
const AGG_ABI = [
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function getRoundData(uint80 _roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
];

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const MAX_WALK = Number(arg("max", "20000"));
const LIVE_CSV = arg("csv", "logs/divergence-run1.csv");

function toSecondary1e8(answer, decimals) {
  if (decimals > 8) return answer / 10n ** BigInt(decimals - 8);
  if (decimals < 8) return answer * 10n ** BigInt(8 - decimals);
  return answer;
}
function pct(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}
const fmtN = (v) => (v == null ? "n/a" : Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : "n/a");
function dist(label, arr, unit) {
  const s = [...arr].sort((a, b) => a - b);
  console.log(
    `  ${label.padEnd(20)} n=${s.length}  min=${fmtN(s[0])}  median=${fmtN(pct(s, 50))}  p95=${fmtN(pct(s, 95))}  p99=${fmtN(pct(s, 99))}  max=${fmtN(s[s.length - 1])} ${unit}`,
  );
}
const hms = (sec) => `${Math.floor(sec / 3600)}h${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}m`;

async function walkFeed(provider, m) {
  const c = new ethers.Contract(m.dia, AGG_ABI, provider);
  const dec = await c.decimals();
  const latest = await c.latestRoundData();
  const latestId = BigInt(latest.roundId.toString());
  console.log(`\n${m.name}  ${m.dia}  decimals=${dec}  latestRoundId=${latestId}`);

  const rounds = []; // {id, price1e8(Number usd), updatedAt}
  let consecMisses = 0;
  for (let n = 0n; n <= BigInt(MAX_WALK); n++) {
    const id = latestId - n;
    if (id <= 0n) break;
    try {
      const rd = n === 0n ? latest : await c.getRoundData(id);
      const answer = BigInt(rd.answer.toString());
      const updatedAt = Number(rd.updatedAt.toString());
      if (answer <= 0n || updatedAt === 0) {
        if (++consecMisses >= 5) break;
        continue;
      }
      consecMisses = 0;
      rounds.push({ id, usd: Number(ethers.utils.formatUnits(toSecondary1e8(answer, dec).toString(), 8)), updatedAt });
    } catch (e) {
      if (++consecMisses >= 5) break; // history exhausted (revert) — stop after a few misses
    }
  }
  rounds.reverse(); // chronological
  return { dec, rounds };
}

function loadLiveDivergence(market) {
  if (!existsSync(LIVE_CSV)) return null;
  const lines = readFileSync(LIVE_CSV, "utf8").trim().split("\n").slice(1);
  const bps = [];
  for (const ln of lines) {
    const f = ln.split(",");
    if (f[2] === market && f[7] !== "" && f[7] != null) bps.push(Number(f[7]));
  }
  return bps;
}

async function main() {
  console.log(`RPC ${RPC}\nwalking up to ${MAX_WALK} rounds back per feed; live-divergence csv: ${LIVE_CSV}`);
  const provider = new ethers.providers.JsonRpcProvider(RPC);

  for (const m of MARKETS) {
    const { rounds } = await walkFeed(provider, m);
    if (rounds.length < 2) {
      console.log(`  retained rounds: ${rounds.length} — TOO SHALLOW. Fall back to a SHORT live run (~15-20m @ 6s).`);
      continue;
    }
    const first = rounds[0], last = rounds[rounds.length - 1];
    const span = last.updatedAt - first.updatedAt;
    console.log(`  retained rounds: ${rounds.length}  span: ${hms(span)} (${new Date(first.updatedAt * 1000).toISOString()} -> ${new Date(last.updatedAt * 1000).toISOString()})`);

    // update gaps = sawtooth: time between consecutive distinct updates
    const gaps = [];
    for (let i = 1; i < rounds.length; i++) {
      const g = rounds[i].updatedAt - rounds[i - 1].updatedAt;
      if (g > 0) gaps.push(g);
    }
    dist("DIA update gap (s)", gaps, "s");
    console.log(`  -> max gap = ${gaps.length ? Math.max(...gaps) : "n/a"}s (${gaps.length ? hms(Math.max(...gaps)) : "n/a"})  [CB_SEC_MAXAGE floor]`);

    // round-to-round price step magnitude (how much DIA jumps per update — informs deviation trigger)
    const steps = [];
    for (let i = 1; i < rounds.length; i++) {
      if (rounds[i - 1].usd > 0) steps.push((Math.abs(rounds[i].usd - rounds[i - 1].usd) / rounds[i - 1].usd) * 10000);
    }
    dist("DIA price step (bps)", steps, "bps");

    const liveBps = loadLiveDivergence(m.name);
    if (liveBps && liveBps.length) {
      dist("LIVE |rs-dia| (bps)", liveBps, `bps  [from ${LIVE_CSV}, ${liveBps.length} samples — RedStone-vs-DIA, NOT historical]`);
    } else {
      console.log(`  LIVE divergence: none found in ${LIVE_CSV}`);
    }
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
