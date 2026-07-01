import { useCallback, useRef, useState } from "react";
import { ethers } from "ethers";
import { poolWrite, musdWrite, poolRead } from "../lib/contracts.js";
import { toAsset } from "../lib/trade.js";
import * as vault from "../lib/vault.js";
import { recordDeposit, recordWithdraw } from "../lib/lpBasis.js";
import { assetToNum } from "../lib/engine.js";

// Drives the LP deposit / withdraw money path for the connected wallet: approve mUSD (if
// needed) → deposit, or (instantly) redeem/withdraw. One action in flight at a time
// (busyRef). `flow` powers the panel's inline status line; on success the local cost-basis
// is updated from the event's exact share delta and onDone() refreshes vault + balances.
//
// Withdraw is INSTANT on this pool — no cooldown. The only on-chain limit is the
// solvency cap (maxWithdraw = free, unreserved liquidity); an over-cap attempt reverts
// ERC4626ExceededMaxWithdraw, which we translate to a plain-English message rather than a
// raw custom error.
export function useVaultActions({ account, getSigner, wrongChain, toast, onDone }) {
  const [flow, setFlow] = useState(null); // { kind, phase, ok, message, shares?, assets? }
  const busyRef = useRef(false);
  const clearTimer = useRef(null);

  const scheduleClear = useCallback((ms = 6000) => {
    clearTimeout(clearTimer.current);
    clearTimer.current = setTimeout(() => setFlow(null), ms);
  }, []);

  const finish = useCallback(
    (payload) => {
      setFlow(payload);
      onDone?.();
      scheduleClear();
    },
    [onDone, scheduleClear],
  );

  const guard = useCallback(() => {
    if (busyRef.current) {
      toast("An LP action is already in progress.", true);
      return false;
    }
    if (!account) {
      toast("Connect a wallet first.", true);
      return false;
    }
    if (wrongChain) {
      toast("Switch to LiteForge (4441) first.", true);
      return false;
    }
    return true;
  }, [account, wrongChain, toast]);

  // Shared revert → UI. A user-dismissed wallet prompt is not an error banner.
  const onError = useCallback(
    (err, kind) => {
      const reason = err?.message || String(err);
      if (err?.rejected) {
        setFlow(null);
        toast("Cancelled.", true);
        return;
      }
      const friendly = /ExceededMaxWithdraw|ExceededMaxRedeem/.test(reason)
        ? "Amount exceeds the liquidity free to withdraw right now (some is reserved against open positions). Try a smaller amount or Max."
        : /ERC20InsufficientBalance/.test(reason)
          ? "Insufficient mUSD balance."
          : /Paused/.test(reason)
            ? "Deposits are paused by governance right now. Withdrawals stay open."
            : `Failed: ${reason.slice(0, 120)}`;
      setFlow({ kind, phase: "error", ok: false, message: friendly });
      scheduleClear(8000);
    },
    [toast, scheduleClear],
  );

  // Deposit `amount` mUSD → mint pLP. amount is a user string / number (mUSD).
  const deposit = useCallback(
    async (amount) => {
      if (!guard()) return;
      const assetsRaw = toAsset(amount);
      if (assetsRaw.lte(0)) return toast("Enter an amount to deposit.", true);
      busyRef.current = true;
      clearTimeout(clearTimer.current);
      try {
        const signer = getSigner();
        const pool = poolWrite(signer);
        const musd = musdWrite(signer);
        setFlow({ kind: "deposit", phase: "approving", message: "Checking mUSD allowance…" });
        const { shares } = await vault.deposit(pool, musd, account, assetsRaw, () =>
          setFlow({ kind: "deposit", phase: "approving", message: "Approve mUSD spending — confirm in your wallet (one-time)." }),
        );
        setFlow({ kind: "deposit", phase: "working", message: "Depositing — confirm in your wallet…" });
        if (shares) recordDeposit(account, assetsRaw, shares);
        const sharesStr = shares ? fmtShares(shares) : "—";
        finish({
          kind: "deposit",
          phase: "done",
          ok: true,
          message: `Deposited ${assetToNum(assetsRaw).toLocaleString()} mUSD → +${sharesStr} pLP shares ✓`,
        });
        toast("Liquidity deposited ✓");
      } catch (err) {
        onError(err, "deposit");
      } finally {
        busyRef.current = false;
      }
    },
    [account, guard, getSigner, toast, finish, onError],
  );

  // Withdraw. isMax → redeem the full maxRedeem (avoids a 1-wei share dust remainder);
  // otherwise withdraw an exact mUSD amount. Instant — no cooldown.
  const withdraw = useCallback(
    async (amount, isMax) => {
      if (!guard()) return;
      busyRef.current = true;
      clearTimeout(clearTimer.current);
      try {
        const signer = getSigner();
        const pool = poolWrite(signer);
        setFlow({ kind: "withdraw", phase: "working", message: "Withdrawing — confirm in your wallet…" });
        let opts;
        if (isMax) {
          const maxSharesRaw = await poolRead().maxRedeem(account);
          if (maxSharesRaw.lte(0)) {
            setFlow(null);
            busyRef.current = false;
            return toast("Nothing available to withdraw right now.", true);
          }
          opts = { maxSharesRaw };
        } else {
          const assetsRaw = toAsset(amount);
          if (assetsRaw.lte(0)) {
            setFlow(null);
            busyRef.current = false;
            return toast("Enter an amount to withdraw.", true);
          }
          opts = { assetsRaw };
        }
        const { shares } = await vault.withdraw(pool, account, opts);
        if (shares) recordWithdraw(account, shares);
        finish({
          kind: "withdraw",
          phase: "done",
          ok: true,
          message: shares ? `Withdrew — burned ${fmtShares(shares)} pLP shares ✓` : "Withdrawn ✓",
        });
        toast("Liquidity withdrawn ✓");
      } catch (err) {
        onError(err, "withdraw");
      } finally {
        busyRef.current = false;
      }
    },
    [account, guard, getSigner, toast, finish, onError],
  );

  const dismiss = useCallback(() => {
    clearTimeout(clearTimer.current);
    setFlow(null);
  }, []);

  const busy = Boolean(flow && (flow.phase === "approving" || flow.phase === "working"));
  return { flow, busy, deposit, withdraw, dismiss };
}

// pLP shares are 24-dec; show a compact human count (3 dp) for the status line.
function fmtShares(sharesRaw) {
  const n = parseFloat(ethers.utils.formatUnits(sharesRaw, 24));
  return n.toLocaleString("en-US", { maximumFractionDigits: 3 });
}
