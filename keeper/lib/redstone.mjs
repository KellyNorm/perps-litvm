// RedStone pull-oracle helpers, factored out of scripts/smoke-perps.mjs so the
// keeper and the smoke share ONE proven payload-wrap + freshness implementation.
//
// The keeper never invents a price: every executeRequest carries a fresh signed
// RedStone payload injected into the call's calldata by WrapperBuilder, exactly
// like the smoke's keeper step. The contract verifies the signature + timestamp
// on-chain; these helpers only fetch and wrap.

import { ethers } from "ethers";
import { WrapperBuilder } from "@redstone-finance/evm-connector";
import { requestDataPackages, getDataPackagesTimestamp } from "@redstone-finance/sdk";

// The single authorised signer behind the free redstone-main-demo data service
// (same constant the smoke pins). Production feeds would list the real signer set.
export const DEMO_SIGNER = "0x0C39486f770B26F5527BBBf942726537986Cd7eb";

// Markets are stored on-chain as bytes32 feed ids (formatBytes32String("BTC")),
// which is exactly the RedStone data-package id. Decode straight back to "BTC"/"ETH".
export function feedOf(marketBytes32) {
  return ethers.utils.parseBytes32String(marketBytes32);
}

// Wrap a contract so the signed RedStone payload for `feed` is injected into the
// call's calldata. Used ONLY for executeRequest (the keeper step) — never for a
// plain view/read. `dataServiceId` selects the feed source (redstone-main-demo).
export function makeWrap(dataServiceId) {
  return (contract, feed) =>
    WrapperBuilder.wrap(contract).usingDataService({
      dataServiceId,
      dataPackagesIds: [feed],
      uniqueSignersCount: 1,
      authorizedSigners: [DEMO_SIGNER],
    });
}

// Fetch the live data package for `feed`: returns { ts (sec), price1e8 (BigNumber) }.
// The mark is the package value scaled to the on-chain 1e8 convention.
export async function fetchMark(dataServiceId, feed) {
  const pkgs = await requestDataPackages({
    dataServiceId,
    dataPackagesIds: [feed],
    uniqueSignersCount: 1,
    authorizedSigners: [DEMO_SIGNER],
  });
  const ts = Math.floor(getDataPackagesTimestamp(pkgs) / 1000);
  const value = pkgs[feed][0].dataPackage.dataPoints[0].toObj().value; // human float
  const price1e8 = ethers.BigNumber.from(Math.round(value * 1e8).toString());
  return { ts, price1e8 };
}

// Just the package timestamp (seconds) for `feed` — the per-loop freshness gate.
export async function payloadTimestampSec(dataServiceId, feed) {
  return (await fetchMark(dataServiceId, feed)).ts;
}

// Blocking poll (ported verbatim in spirit from the smoke) — kept for the
// request-only test helper and any caller that genuinely wants to wait. The
// keeper's main loop does NOT use this; it does a non-blocking freshness check
// each tick instead so one slow feed never stalls the other requests.
export async function waitForFreshPayload(dataServiceId, feed, floor, provider, log = () => {}) {
  const TIMEOUT_MS = 180_000;
  const POLL_MS = 4_000;
  const start = Date.now();
  for (;;) {
    let pkgTs = 0;
    try {
      pkgTs = await payloadTimestampSec(dataServiceId, feed);
    } catch {}
    const blockTs = (await provider.getBlock("latest")).timestamp;
    log(`waiting for fresh payload: pkg ts ${pkgTs}, block ts ${blockTs}, need >= ${floor}`);
    if (pkgTs >= floor && blockTs >= floor) return;
    if (Date.now() - start > TIMEOUT_MS) {
      throw new Error(`timed out waiting for a demo payload stamped >= ${floor} (last pkg ts ${pkgTs})`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
