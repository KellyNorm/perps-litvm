// LP money-path writes for the ERC-4626 LiquidityPool: deposit (approve mUSD → deposit)
// and withdraw/redeem (instant — no cooldown on this pool). Mirrors lib/trade.js: decode
// custom-error reverts via revert.js, flag user rejections, and pull the exact share
// delta from the emitted Deposit/Withdraw event so the local cost-basis stays precise.
//
// Decimals: mUSD (asset) is 18-dec; pLP shares are 24-dec (asset 18 + pool
// _DECIMALS_OFFSET 6). This module deals in RAW BigNumbers only — callers scale asset
// inputs with trade.toAsset (1e18) and read share quantities straight off the event, so
// there is never an implicit 18-vs-24 mixup on a fund amount.

import { ethers } from "ethers";
import { revertReason, isUserRejection } from "./revert.js";
import { ensureAllowance } from "./trade.js";

// Pull the `shares` arg out of the pool's own Deposit/Withdraw event in a receipt. The
// event is the authoritative post-rounding share delta (previewDeposit can differ by a
// wei). Returns a BigNumber, or null if the log isn't found (basis update is then skipped
// rather than recorded wrong).
function sharesFromEvent(pool, rcpt, name) {
  for (const log of rcpt.logs || []) {
    try {
      const parsed = pool.interface.parseLog(log);
      if (parsed && parsed.name === name && parsed.args && parsed.args.shares != null) {
        return ethers.BigNumber.from(parsed.args.shares);
      }
    } catch {
      /* not one of the pool's events — skip */
    }
  }
  return null;
}

function decodeError(pool, err) {
  const e = new Error(revertReason(pool.interface, err));
  e.rejected = isUserRejection(err);
  e.cause = err;
  return e;
}

// Approve mUSD to the pool if short, then deposit `assetsRaw` (1e18) → mints pLP to the
// owner. onApproving() fires only when an approve prompt is actually needed. Returns the
// minted share delta (BigNumber) for the local basis.
export async function deposit(pool, musd, owner, assetsRaw, onApproving) {
  await ensureAllowance(musd, owner, pool.address, assetsRaw, onApproving);
  let rcpt;
  try {
    rcpt = await (await pool.deposit(assetsRaw, owner)).wait();
  } catch (err) {
    throw decodeError(pool, err);
  }
  return { shares: sharesFromEvent(pool, rcpt, "Deposit"), rcpt };
}

// Withdraw from the pool. Two modes, both instant:
//   • { assetsRaw }     -> withdraw an exact mUSD amount (burns however many shares).
//   • { maxSharesRaw }  -> redeem an exact share count (used for "Max": redeem the full
//                          maxRedeem so rounding can't leave 1 wei of shares behind).
// Returns the burned share delta (BigNumber) for the local basis.
export async function withdraw(pool, owner, { assetsRaw, maxSharesRaw }) {
  let rcpt;
  try {
    const tx =
      maxSharesRaw != null
        ? await pool.redeem(maxSharesRaw, owner, owner)
        : await pool.withdraw(assetsRaw, owner, owner);
    rcpt = await tx.wait();
  } catch (err) {
    throw decodeError(pool, err);
  }
  return { shares: sharesFromEvent(pool, rcpt, "Withdraw"), rcpt };
}
