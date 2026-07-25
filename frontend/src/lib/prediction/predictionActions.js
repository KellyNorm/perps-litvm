import { ethers } from "ethers";
import { musdRead } from "../contracts.js";
import { ensureAllowance } from "../trade.js";
import { PREDICTION_FACTORY_ABI } from "./predictionAbi.js";
import { requirePredictionFactoryAddress } from "./predictionConfig.js";

// Money-path WRITES for the prediction board: place a bet (approve mUSD → bet) and claim
// a payout/refund. Deliberately separate from the perps write path — it shares only the
// mUSD token helpers and `ensureAllowance`, which the LP/trade paths already use.
//
// The factory IS the fund custodian here (ParimutuelPredictions.bet does
// `musd.safeTransferFrom(msg.sender, address(this), amount)`), so the mUSD allowance is
// granted to the FACTORY address, not to a separate vault.

/**
 * Signer-bound factory for bet()/claim(). Throws (rather than defaulting to any address)
 * when the factory env var is unset — this grants an mUSD allowance, so a wrong or guessed
 * custodian address is the one mistake that must never be made quietly.
 */
export function predictionWrite(signer) {
  return new ethers.Contract(requirePredictionFactoryAddress(), PREDICTION_FACTORY_ABI, signer);
}

/**
 * Approve (if needed) then bet `amountRaw` (18-dec mUSD) on `side` of `marketId`.
 * `side` MUST be a Side enum value (0 = Up, 1 = Down) — see SIDE in predictionConfig.
 * onApproving() fires only when an approve prompt is actually needed.
 *
 * @returns {Promise<ethers.providers.TransactionReceipt>} the bet receipt.
 */
export async function placeBet({ signer, account, marketId, side, amountRaw, onApproving }) {
  const factory = predictionWrite(signer);
  const musd = musdRead().connect(signer);
  // Approve the FACTORY as the mUSD spender — it is the contract that transferFrom's.
  await ensureAllowance(musd, account, requirePredictionFactoryAddress(), amountRaw, onApproving);
  const tx = await factory.bet(marketId, side, amountRaw);
  return tx.wait();
}

/**
 * Claim a settled-win payout or a void refund for `marketId`. The paid amount is decided
 * ON-CHAIN (from the market's pools/outcome); this never recomputes it. Returns the exact
 * amount transferred, parsed from the Claimed event (0 if nothing was owed).
 *
 * @returns {Promise<ethers.BigNumber>} amount paid out, in 18-dec mUSD.
 */
export async function claimPayout({ signer, marketId }) {
  const factory = predictionWrite(signer);
  const tx = await factory.claim(marketId);
  const receipt = await tx.wait();
  // Read the actual on-chain amount from the Claimed event rather than trusting any
  // pre-tx estimate — the event is the source of truth for what the contract paid.
  for (const log of receipt.logs) {
    try {
      const parsed = factory.interface.parseLog(log);
      if (parsed.name === "Claimed") return parsed.args.amount;
    } catch {
      // Not one of our events — skip.
    }
  }
  return ethers.constants.Zero;
}
