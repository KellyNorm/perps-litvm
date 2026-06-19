// Revert decoding for the Nitro (Arbitrum) RPC behind LiteForge. Ported verbatim
// from scripts/smoke-perps.mjs — the same logic that surfaced custom-error reverts
// in the smoke surfaces them in the browser. Two quirks this handles:
//   1. ethers v5 buries the revert bytes in different places per node/provider.
//   2. This Nitro node returns revert bytes as a SUCCESSFUL eth_call result rather
//      than throwing — so a "successful" call with non-empty return data IS a revert.

import { ethers } from "ethers";

// Pull a usable revert string out of an ethers v5 error, decoding custom errors
// against `iface` when the data is present.
export function extractErrorData(err) {
  const direct = [err?.data, err?.error?.data, err?.error?.error?.data];
  for (const c of direct) if (typeof c === "string" && c.startsWith("0x")) return c;
  const body = err?.error?.body ?? err?.body;
  if (typeof body === "string") {
    try {
      const d = JSON.parse(body)?.error?.data;
      if (typeof d === "string" && d.startsWith("0x")) return d;
    } catch {}
  }
  return null;
}

// Best-effort human revert reason: a decoded custom error like
// "SlippageNotMet(123, 456)", else the plain ethers message.
export function revertReason(iface, err) {
  const data = extractErrorData(err);
  if (data && data.length >= 10) {
    try {
      const p = iface.parseError(data);
      return `${p.name}(${p.args.map((a) => a.toString()).join(", ")})`;
    } catch {}
  }
  return err?.reason || err?.error?.message || err?.shortMessage || err?.message || String(err);
}

// MetaMask / EIP-1193 user-rejection (code 4001, or ACTION_REJECTED in ethers v5).
export function isUserRejection(err) {
  return err?.code === 4001 || err?.code === "ACTION_REJECTED" || /user (rejected|denied)/i.test(err?.message || "");
}

// Try to name the leading custom error in raw return bytes (the Nitro "successful
// revert" case). Returns null if the bytes don't decode to a known error.
export function decodeRawError(iface, raw) {
  if (!raw || raw === "0x" || raw.length < 10) return null;
  try {
    const p = iface.parseError(raw);
    return `${p.name}(${p.args.map((a) => a.toString()).join(", ")})`;
  } catch {
    return null;
  }
}
