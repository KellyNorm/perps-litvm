// Nitro revert-decoder for the prediction keeper. Self-contained — a deliberate
// own copy, NOT shared with the perp keeper's lib, so the two services stay fully
// isolated.
//
// This LitVM node (Arbitrum Nitro) has two quirks we must handle:
//   1. A failed eth_call often comes back as a SUCCESSFUL result whose return data
//      IS the revert payload, rather than throwing.
//   2. Custom errors (UnhealthySample, AwaitGrace, ...) arrive as raw 4-byte
//      selectors + args that must be decoded against the ABI to be readable.
//
// staticProbe() decides whether observe()/settle()/replenish() would land BEFORE
// spending gas + a nonce on a real send; revertReason() logs a human-readable
// reason when a real tx reverts.

// Pull a usable revert blob out of an ethers v5 error, digging through the nested
// shapes a JSON-RPC provider can wrap it in.
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

// Decode an ethers v5 error to a readable string, resolving custom errors via iface.
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

// STATIC landing probe. Replays a populated (calldata-only) tx through a raw
// provider.call. replenish/observe/settle all return nothing on success, so:
//   - empty return ("0x")        => it WOULD land now      => { ok: true }
//   - non-empty return / a throw => it would revert (gate) => { ok: false, reason }
// Never sends a tx, never costs gas. The keeper only sends after ok:true.
export async function staticProbe(provider, iface, to, data, from) {
  try {
    const raw = await provider.call({ to, data, from });
    if (!raw || raw === "0x") return { ok: true, reason: null };
    let reason;
    try {
      const p = iface.parseError(raw);
      reason = `${p.name}(${p.args.map((a) => a.toString()).join(", ")})`;
    } catch {
      reason = `raw ${raw}`;
    }
    return { ok: false, reason };
  } catch (err) {
    return { ok: false, reason: revertReason(iface, err) };
  }
}
