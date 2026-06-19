import { requestDataPackages, getDataPackagesTimestamp } from "@redstone-finance/sdk";
import { REDSTONE_DATA_SERVICE, REDSTONE_DEMO_SIGNER } from "../config.js";

// Live mark for a feed (e.g. "BTC", "ETH") via the RedStone pull oracle — the same
// request + decode scripts/smoke-perps.mjs uses to read P. Returns the human price
// (float) and the package timestamp (ms). No on-chain call; this is the public
// gateway fetch that also feeds the in-tx payload on the trading path.
export async function fetchMark(feed) {
  const pkgs = await requestDataPackages({
    dataServiceId: REDSTONE_DATA_SERVICE,
    dataPackagesIds: [feed],
    uniqueSignersCount: 1,
    authorizedSigners: [REDSTONE_DEMO_SIGNER],
  });
  const list = pkgs[feed];
  if (!list || !list.length) throw new Error(`no RedStone package for ${feed}`);
  const value = list[0].dataPackage.dataPoints[0].toObj().value; // human float
  const tsMs = getDataPackagesTimestamp(pkgs);
  return { price: Number(value), tsMs };
}

// Fetch several feeds concurrently; returns { SYMBOL: {price, tsMs} | {error} }.
export async function fetchMarks(feeds) {
  const out = {};
  await Promise.all(
    feeds.map(async (f) => {
      try {
        out[f] = await fetchMark(f);
      } catch (e) {
        out[f] = { error: e?.message || String(e) };
      }
    }),
  );
  return out;
}
