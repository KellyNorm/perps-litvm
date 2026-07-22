// END-TO-END money-path smoke for the PREDICTION market on LitVM (chain 4441).
//
// Proves the exact cycle the frontend drives, on-chain, with a real wallet:
//
//   SETUP     ensure mUSD (faucet if low) -> approve the factory as mUSD spender
//   CREATE    owner-create a FAST market (short bet/settle windows) with strike just
//             below spot, so the run finishes in ~3 min and lands a definitive outcome
//   BET BOTH  bet 1 mUSD UP (Side=0) and 1 mUSD DOWN (Side=1) from the SAME wallet, so
//             the book is two-sided (a one-sided book voids) -> assert pools match stake
//   LOCK      wait for CHAIN time to reach tLock (betting closes; the same gate the UI uses)
//   OBSERVE   the keeper step: observe() repeatedly across [tLock, tExpiry) to build a TWAP
//   SETTLE    after tExpiry, settle() -> Up / Down (or Void on a tie / thin TWAP)
//   CLAIM     read claimable() (on-chain), claim(), assert the Claimed amount == claimable
//
// Whatever the outcome, the same wallet holds the whole winning side (or is refunded on a
// void), so claimable == the full pot and net mUSD is conserved (gas is zkLTC, not mUSD).
// That conservation + the pools==stake check is the acceptance gate.
//
// Usage:
//   set -a; source .env; set +a; node scripts/smoke-predictions.mjs
//   (reads LITVM_RPC_URL, DEPLOYER_PRIVATE_KEY, MUSD_ADDRESS, and optionally
//    PREDICTION_FACTORY_ADDRESS — defaults to the deployed factory.)

import { ethers } from "ethers";

const RPC = process.env.LITVM_RPC_URL || "https://liteforge.rpc.caldera.xyz/infra-partner-http";
const PK = process.env.DEPLOYER_PRIVATE_KEY;
const MUSD = process.env.MUSD_ADDRESS || "0x4AedaB95d41A31f891EE12d13CD77102705e2dEF";
const FACTORY = process.env.PREDICTION_FACTORY_ADDRESS || "0x6338985C7f689C3e1959bfe1a8bb36E44849EA40";

// Fast-market windows (seconds). Generous enough that 2 bet txs land before lock and the
// TWAP clears its coverage gate (span >= 60% of the settle window, >= 3 samples, >= 10s apart).
const BET_WINDOW = 90;
const SETTLE_WINDOW = 60;
const OFFSET_BPS = 50; // strike = spot * (1 - 0.50%) — below spot, so UP is the likely winner
const STAKE = ethers.utils.parseUnits("1", 18); // 1 mUSD per side (== MIN_BET)

const FACTORY_ABI = [
  "function owner() view returns (address)",
  "function assetCount() view returns (uint256)",
  "function assets(uint256) view returns (string symbol,address feed,uint8 feedDecimals,uint8 displayDp,bool enabled)",
  "function createMarket(uint16 assetId,address feed,uint64 betWindow,uint64 settleWindow,uint256 offsetBps,bool offsetUp) returns (uint256)",
  "function getMarket(uint256) view returns (tuple(uint16 assetId,address feed,uint64 t0,uint64 tLock,uint64 tExpiry,uint64 lastObsTs,uint64 maxStaleness,int256 strike,int256 settlePrice,uint8 phase,uint8 outcome))",
  "function pools(uint256) view returns (uint256 upPool,uint256 downPool,uint16 marketFeeBps)",
  "function bet(uint256 marketId,uint8 side,uint256 amount)",
  "function observe(uint256 marketId)",
  "function settle(uint256 marketId)",
  "function claim(uint256 marketId)",
  "function claimable(uint256 marketId,address who) view returns (uint256)",
  "event MarketCreated(uint256 indexed marketId,uint16 indexed assetId,address feed,uint64 t0,uint64 tLock,uint64 tExpiry,int256 strike)",
  "event Claimed(uint256 indexed marketId,address indexed claimer,uint8 phase,uint256 amount)",
];
const MUSD_ABI = [
  "function faucet()",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

const PHASE = ["Open", "Locked", "Settled", "Void"];
const OUTCOME = ["None", "Up", "Down"];
const fmt = (bn) => ethers.utils.formatUnits(bn, 18);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
  passed++;
  console.log("  ✓ " + msg);
}

async function chainNow(provider) {
  return (await provider.getBlock("latest")).timestamp;
}

async function waitForChainTs(provider, target, label) {
  for (;;) {
    const now = await chainNow(provider);
    if (now >= target) return now;
    const left = target - now;
    process.stdout.write(`  … ${label}: chain +${left}s\r`);
    await sleep(Math.min(left, 5) * 1000);
  }
}

async function main() {
  if (!PK) throw new Error("DEPLOYER_PRIVATE_KEY not set (run: set -a; source .env; set +a)");
  const provider = new ethers.providers.StaticJsonRpcProvider(RPC, { chainId: 4441, name: "litvm" });
  const wallet = new ethers.Wallet(PK, provider);
  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, wallet);
  const musd = new ethers.Contract(MUSD, MUSD_ABI, wallet);

  console.log("PREDICTION money-path smoke");
  console.log("  wallet :", wallet.address);
  console.log("  factory:", FACTORY);
  console.log("  mUSD   :", MUSD, "\n");

  // ---- ownership (createMarket is owner-gated) ----------------------------
  const owner = await factory.owner();
  assert(owner.toLowerCase() === wallet.address.toLowerCase(), `wallet is factory owner (${owner})`);

  // ---- SETUP: mUSD + approval --------------------------------------------
  let bal = await musd.balanceOf(wallet.address);
  console.log("\nSETUP");
  if (bal.lt(STAKE.mul(3))) {
    console.log("  low mUSD — calling faucet()…");
    try {
      await (await musd.faucet()).wait();
      bal = await musd.balanceOf(wallet.address);
    } catch (e) {
      console.log("  faucet skipped:", (e.reason || e.message || "").slice(0, 60));
    }
  }
  assert(bal.gte(STAKE.mul(2)), `mUSD balance covers both bets (${fmt(bal)} mUSD)`);

  const allowance = await musd.allowance(wallet.address, FACTORY);
  if (allowance.lt(STAKE.mul(2))) {
    console.log("  approving factory as mUSD spender…");
    await (await musd.approve(FACTORY, ethers.constants.MaxUint256)).wait();
  }
  assert((await musd.allowance(wallet.address, FACTORY)).gte(STAKE.mul(2)), "factory approved for mUSD");

  const musdBefore = await musd.balanceOf(wallet.address); // baseline for the conservation check

  // ---- CREATE a fast market ----------------------------------------------
  console.log("\nCREATE");
  const asset = await factory.assets(0); // asset 0 (BTC) — healthy feed
  console.log(`  asset 0 = ${asset.symbol}  feed ${asset.feed}`);
  const createRc = await (
    await factory.createMarket(0, asset.feed, BET_WINDOW, SETTLE_WINDOW, OFFSET_BPS, false)
  ).wait();
  let marketId;
  for (const log of createRc.logs) {
    try {
      const p = factory.interface.parseLog(log);
      if (p.name === "MarketCreated") marketId = p.args.marketId;
    } catch {
      /* not ours */
    }
  }
  assert(marketId !== undefined, `market created (id ${marketId})`);

  const m = await factory.getMarket(marketId);
  const tLock = Number(m.tLock);
  const tExpiry = Number(m.tExpiry);
  console.log(`  t0=${m.t0} tLock=${tLock} tExpiry=${tExpiry} strike=${fmt(m.strike)}  phase=${PHASE[m.phase]}`);
  assert(tExpiry - tLock === SETTLE_WINDOW, "settle window is disjoint & after the lock");

  // ---- BET both sides -----------------------------------------------------
  console.log("\nBET (both sides, same wallet — two-sided book)");
  await (await factory.bet(marketId, 0, STAKE)).wait(); // Side.Up = 0
  console.log("  bet 1 mUSD UP   (side=0) ✓");
  await (await factory.bet(marketId, 1, STAKE)).wait(); // Side.Down = 1
  console.log("  bet 1 mUSD DOWN (side=1) ✓");

  const pools = await factory.pools(marketId);
  assert(pools.upPool.eq(STAKE), `upPool == staked (${fmt(pools.upPool)} mUSD)`);
  assert(pools.downPool.eq(STAKE), `downPool == staked (${fmt(pools.downPool)} mUSD)`);
  const staked = pools.upPool.add(pools.downPool);

  // ---- LOCK ---------------------------------------------------------------
  console.log("\nLOCK");
  await waitForChainTs(provider, tLock, "waiting for lock");
  console.log("\n  chain reached tLock — betting closed");

  // ---- OBSERVE (keeper) ---------------------------------------------------
  console.log("\nOBSERVE (building TWAP across the settlement window)");
  let samples = 0;
  // Observe until ~6s before expiry, spaced > MIN_OBS_SPACING (10s), for span coverage.
  for (;;) {
    const now = await chainNow(provider);
    if (now >= tExpiry - 6) break;
    try {
      await (await factory.observe(marketId)).wait();
      samples++;
      console.log(`  observe #${samples} @ chain ${now}`);
    } catch (e) {
      console.log("  observe retry:", (e.reason || e.message || "").slice(0, 50));
    }
    await sleep(12_000);
  }
  assert(samples >= 3, `collected >= 3 observations (${samples}) for a valid TWAP`);

  // ---- SETTLE -------------------------------------------------------------
  console.log("\nSETTLE");
  await waitForChainTs(provider, tExpiry, "waiting for expiry");
  await (await factory.settle(marketId)).wait();
  const settled = await factory.getMarket(marketId);
  console.log(`\n  phase=${PHASE[settled.phase]} outcome=${OUTCOME[settled.outcome]} settlePrice=${fmt(settled.settlePrice)}`);
  assert(settled.phase === 2 || settled.phase === 3, "market resolved (Settled or Void), not stuck");

  // ---- CLAIM --------------------------------------------------------------
  console.log("\nCLAIM");
  const owed = await factory.claimable(marketId, wallet.address);
  console.log(`  claimable() on-chain = ${fmt(owed)} mUSD`);
  // Sole holder of the winning side (or refunded on a void) => the whole pot comes back.
  assert(owed.eq(staked), `claimable == full pot (${fmt(owed)} == ${fmt(staked)} mUSD)`);

  const claimRc = await (await factory.claim(marketId)).wait();
  let paid = ethers.constants.Zero;
  for (const log of claimRc.logs) {
    try {
      const p = factory.interface.parseLog(log);
      if (p.name === "Claimed") paid = p.args.amount;
    } catch {
      /* not ours */
    }
  }
  assert(paid.eq(owed), `Claimed event amount == claimable (${fmt(paid)} mUSD)`);

  const musdAfter = await musd.balanceOf(wallet.address);
  assert(musdAfter.eq(musdBefore), `net mUSD conserved (before ${fmt(musdBefore)} == after ${fmt(musdAfter)})`);

  console.log(`\n✅ ALL ${passed} CHECKS PASSED — bet → lock → observe → settle → claim verified on-chain.`);
}

main().catch((e) => {
  console.error("\n❌ " + (e.stack || e.message));
  process.exit(1);
});
