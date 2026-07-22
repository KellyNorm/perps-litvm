import { useCallback, useRef, useState } from "react";
import { ethers } from "ethers";
import { placeBet as placeBetTx, claimPayout } from "../../lib/prediction/predictionActions.js";
import { MIN_BET, PHASE } from "../../lib/prediction/predictionConfig.js";

// Drives the prediction money path for the connected wallet: place a bet (approve mUSD if
// needed → bet) and claim a payout/refund. One action in flight at a time (busyRef).
// `flow` powers the modal / card inline status line. On success onDone() refreshes the
// board (pools, phase, claimable) and the caller re-reads balances.
//
// SAFETY: the bet is gated on CHAIN time (market.tLock vs the chain-anchored `now`), the
// same clock the contract locks on, so the UI never offers a bet the chain will reject.
// The contract still enforces the gate — this only avoids a guaranteed-revert prompt.
export function usePredictionActions({ account, getSigner, wrongChain, chainNow, toast, onDone }) {
  const [flow, setFlow] = useState(null); // { kind, marketId, phase, ok, message, amount? }
  const busyRef = useRef(false);
  const clearTimer = useRef(null);

  const scheduleClear = useCallback((ms = 6000) => {
    clearTimeout(clearTimer.current);
    clearTimer.current = setTimeout(() => setFlow(null), ms);
  }, []);

  const guard = useCallback(() => {
    if (busyRef.current) {
      toast("An action is already in progress.", true);
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

  // Shared revert → friendly UI. A user-dismissed wallet prompt is not an error banner.
  const onError = useCallback(
    (err, kind, marketId) => {
      const reason = err?.message || String(err);
      if (err?.code === 4001 || err?.code === "ACTION_REJECTED" || /user rejected|denied/i.test(reason)) {
        setFlow(null);
        toast("Cancelled.", true);
        return;
      }
      const friendly = /BettingClosed/.test(reason)
        ? "Betting has closed for this market — it locked before the tx landed."
        : /BelowMinBet/.test(reason)
          ? "Minimum bet is 1 mUSD."
          : /ERC20InsufficientBalance|transfer amount exceeds balance/.test(reason)
            ? "Insufficient mUSD balance. Use the faucet to get test tokens."
            : /EnforcedPause|Paused/.test(reason)
              ? "Betting is paused by governance right now."
              : /AlreadyResolved|NotResolved/.test(reason)
                ? "This market isn't claimable right now."
                : `Failed: ${reason.slice(0, 140)}`;
      setFlow({ kind, marketId, phase: "error", ok: false, message: friendly });
      scheduleClear(8000);
    },
    [toast, scheduleClear],
  );

  // Place a bet. `market` is the board row; `side` is a SIDE value (0=Up,1=Down);
  // `amountStr` is the user's mUSD string. Returns true on success.
  const placeBet = useCallback(
    async (market, side, amountStr) => {
      if (!guard()) return false;

      let amountRaw;
      try {
        amountRaw = ethers.utils.parseUnits(String(amountStr || "").trim() || "0", 18);
      } catch {
        toast("Enter a valid amount.", true);
        return false;
      }
      if (amountRaw.lt(MIN_BET)) {
        toast("Minimum bet is 1 mUSD.", true);
        return false;
      }
      // Chain-time lock gate: the contract rejects at `block.timestamp >= tLock`. Use the
      // chain-anchored clock so we never send a doomed tx.
      if (market.phase !== PHASE.OPEN || (chainNow != null && chainNow >= market.tLock)) {
        toast("Betting is locked for this market.", true);
        return false;
      }

      busyRef.current = true;
      clearTimeout(clearTimer.current);
      try {
        const signer = getSigner();
        setFlow({ kind: "bet", marketId: market.id, phase: "approving", message: "Checking mUSD allowance…" });
        await placeBetTx({
          signer,
          account,
          marketId: market.id,
          side,
          amountRaw,
          onApproving: () =>
            setFlow({
              kind: "bet",
              marketId: market.id,
              phase: "approving",
              message: "Approve mUSD spending — confirm in your wallet (one-time).",
            }),
        });
        const musd = ethers.utils.formatUnits(amountRaw, 18);
        setFlow({
          kind: "bet",
          marketId: market.id,
          phase: "done",
          ok: true,
          message: `Bet ${Number(musd).toLocaleString()} mUSD on ${side === 0 ? "▲ UP" : "▼ DOWN"} ✓`,
        });
        toast("Bet placed ✓");
        onDone?.();
        scheduleClear();
        return true;
      } catch (err) {
        onError(err, "bet", market.id);
        return false;
      } finally {
        busyRef.current = false;
      }
    },
    [account, guard, getSigner, chainNow, toast, onDone, onError, scheduleClear],
  );

  // Claim a settled-win payout or a void refund. Amount is decided on-chain.
  const claim = useCallback(
    async (market) => {
      if (!guard()) return false;
      busyRef.current = true;
      clearTimeout(clearTimer.current);
      const isVoid = market.phase === PHASE.VOID;
      try {
        const signer = getSigner();
        setFlow({
          kind: "claim",
          marketId: market.id,
          phase: "working",
          message: `${isVoid ? "Claiming refund" : "Claiming payout"} — confirm in your wallet…`,
        });
        const amount = await claimPayout({ signer, marketId: market.id });
        const musd = ethers.utils.formatUnits(amount, 18);
        setFlow({
          kind: "claim",
          marketId: market.id,
          phase: "done",
          ok: true,
          message: amount.isZero()
            ? "Nothing left to claim here."
            : `${isVoid ? "Refunded" : "Claimed"} ${Number(musd).toLocaleString(undefined, { maximumFractionDigits: 2 })} mUSD ✓`,
        });
        toast(isVoid ? "Refund claimed ✓" : "Payout claimed ✓");
        onDone?.();
        scheduleClear();
        return true;
      } catch (err) {
        onError(err, "claim", market.id);
        return false;
      } finally {
        busyRef.current = false;
      }
    },
    [guard, getSigner, toast, onDone, onError, scheduleClear],
  );

  const dismiss = useCallback(() => {
    clearTimeout(clearTimer.current);
    setFlow(null);
  }, []);

  const busy = Boolean(flow && (flow.phase === "approving" || flow.phase === "working"));
  return { flow, busy, placeBet, claim, dismiss };
}
