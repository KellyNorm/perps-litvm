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

// Production RedStone signer set (redstone-primary-prod) — mirrors the on-chain
// authorised set in PrimaryProdDataServiceConsumerBase (same constants the smoke
// pins). The contract requires 3 unique signers, so the SDK requests packages
// from this set.
export const PROD_SIGNERS = [
  "0x8BB8F32Df04c8b654987DAaeD53D6B6091e3B774",
  "0xdEB22f54738d54976C4c0fe5ce6d408E40d88499",
  "0x51Ce04Be4b3E32572C4Ec9135221d0691Ba7d202",
  "0xDD682daEC5A90dD295d14DA4b0bec9281017b5bE",
  "0x9c5AE89C4Af6aA32cE58588DBaF90d18a855B6de",
];
export const UNIQUE_SIGNERS = 3;

// Markets are stored on-chain as bytes32 feed ids (formatBytes32String("BTC")),
// which is exactly the RedStone data-package id. Decode straight back to "BTC"/"ETH".
export function feedOf(marketBytes32) {
  return ethers.utils.parseBytes32String(marketBytes32);
}

// Wrap a contract so the signed RedStone payload for `feed` is injected into the
// call's calldata. Used ONLY for executeRequest (the keeper step) — never for a
// plain view/read. `dataServiceId` selects the feed source (redstone-primary-prod).
export function makeWrap(dataServiceId) {
  return (contract, feed) =>
    WrapperBuilder.wrap(contract).usingDataService({
      dataServiceId,
      dataPackagesIds: [feed],
      uniqueSignersCount: UNIQUE_SIGNERS,
      authorizedSigners: PROD_SIGNERS,
    });
}

// Fetch the signed data packages for `feed` ONCE: returns { pkgs, ts (sec) }.
// `pkgs` is the raw DataServiceResponse — reuse it both for the freshness gate
// (its `ts`) AND to inject calldata via wrapWithPackages, so the submit path needs
// no second requestDataPackages round-trip. This is the single-fetch primitive the
// other helpers (fetchMark, payloadTimestampSec) are now built on.
export async function fetchPackages(dataServiceId, feed) {
  const pkgs = await requestDataPackages({
    dataServiceId,
    dataPackagesIds: [feed],
    uniqueSignersCount: UNIQUE_SIGNERS,
    authorizedSigners: PROD_SIGNERS,
  });
  const ts = Math.floor(getDataPackagesTimestamp(pkgs) / 1000);
  return { pkgs, ts };
}

// Wrap a contract so ALREADY-FETCHED signed packages are injected into the call's
// calldata — the reuse counterpart to makeWrap that does NOT hit the network. Same
// on-chain payload as usingDataService, but built from packages already in hand, so
// the payload→submit critical path is one fetch instead of two.
export function wrapWithPackages(contract, pkgs) {
  return WrapperBuilder.wrap(contract).usingDataPackages(pkgs);
}

// Fetch the live data package for `feed`: returns { ts (sec), price1e8 (BigNumber) }.
// The mark is the package value scaled to the on-chain 1e8 convention.
export async function fetchMark(dataServiceId, feed) {
  const { pkgs, ts } = await fetchPackages(dataServiceId, feed);
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
      throw new Error(`timed out waiting for a prod payload stamped >= ${floor} (last pkg ts ${pkgTs})`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
