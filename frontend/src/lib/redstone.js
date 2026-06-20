import { requestDataPackages, getDataPackagesTimestamp } from "@redstone-finance/sdk";
import { WrapperBuilder } from "@redstone-finance/evm-connector";
import { REDSTONE_DATA_SERVICE, REDSTONE_PROD_SIGNERS, REDSTONE_UNIQUE_SIGNERS } from "../config.js";

// Live mark for a feed (e.g. "BTC", "ETH") via the RedStone pull oracle — the same
// request + decode scripts/smoke-perps.mjs uses to read P. Returns the human price
// (float) and the package timestamp (ms). No on-chain call; this is the public
// gateway fetch that also feeds the in-tx payload on the trading path.
export async function fetchMark(feed) {
  const pkgs = await requestDataPackages({
    dataServiceId: REDSTONE_DATA_SERVICE,
    dataPackagesIds: [feed],
    uniqueSignersCount: REDSTONE_UNIQUE_SIGNERS,
    authorizedSigners: REDSTONE_PROD_SIGNERS,
  });
  const list = pkgs[feed];
  if (!list || !list.length) throw new Error(`no RedStone package for ${feed}`);
  const value = list[0].dataPackage.dataPoints[0].toObj().value; // human float
  const tsMs = getDataPackagesTimestamp(pkgs);
  return { price: Number(value), tsMs };
}

// Package timestamp (SECONDS) for a feed — the on-chain freshness clock. Mirrors
// scripts/smoke-perps.mjs payloadTimestampSec(): floor(getDataPackagesTimestamp/1000).
export async function payloadTimestampSec(feed) {
  return Math.floor((await fetchMark(feed)).tsMs / 1000);
}

// Wrap a signer-bound contract so the signed RedStone payload is injected into the
// call's calldata. Used ONLY for executeRequest (the keeper step) — NEVER for the
// plain request* calls. Identical config to the smoke's `wrap`, but `feed` is the
// market's data-package id (e.g. "BTC", "ETH") instead of a hard-coded constant.
export function wrapForExecute(contract, feed) {
  return WrapperBuilder.wrap(contract).usingDataService({
    dataServiceId: REDSTONE_DATA_SERVICE,
    dataPackagesIds: [feed],
    uniqueSignersCount: REDSTONE_UNIQUE_SIGNERS,
    authorizedSigners: REDSTONE_PROD_SIGNERS,
  });
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
