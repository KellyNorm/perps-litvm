// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title PredictionTwap
 * @notice Pure TWAP math + validity gates for the prediction market's settlement
 *         window (design §7). Given the observations collected during
 *         `[tLock, tExpiry)`, it produces a manipulation-resistant settlement
 *         price `S` — but ONLY if the sample set is trustworthy. A thin / stale /
 *         empty set yields `valid == false`, which the caller turns into a VOID
 *         (refund) rather than a wrong outcome (design §5.8, §14.5). No funds, no
 *         storage, no oracle reads here — this is deterministic arithmetic over a
 *         set of already-validated observations.
 * @dev    Observations are assumed appended in non-decreasing `ts` order (the
 *         collector enforces a strictly-increasing minimum spacing) and each `ts`
 *         within `[tLock, tExpiry)`. The library is defensive regardless: a zero
 *         or negative span can never divide. Split into small helpers to keep the
 *         stack shallow under the repo's `optimizer_runs = 1` / non-IR build.
 */
library PredictionTwap {
    /// One settlement-window sample. `ts` is the block time it was taken (clamped
    /// to the window by the collector); `price` is the healthy feed answer.
    struct Obs {
        uint64 ts;
        int256 price;
    }

    /// The settlement-window parameters + validity thresholds (design §7.2).
    struct Config {
        uint64 tLock; // window start
        uint64 tExpiry; // window end (exclusive)
        uint256 minSamples; // minimum observations
        uint256 minCoverageBps; // min fraction (bps) of the window the samples must span
        uint256 maxStaleness; // last sample must be within this of tExpiry
    }

    /**
     * @notice Compute the time-weighted settlement price and whether it is valid.
     * @return valid  True IFF every gate held; when false `twap` is 0 and unusable.
     * @return twap   The stepwise (last-observation-carried-forward) TWAP over
     *                `[first.ts, last.ts]` when valid; else 0.
     */
    function compute(Obs[] memory obs, Config memory cfg) internal pure returns (bool valid, int256 twap) {
        if (!_valid(obs, cfg)) return (false, 0);
        uint256 span = uint256(obs[obs.length - 1].ts - obs[0].ts);
        return (true, _weightedSum(obs) / int256(span));
    }

    /// All §7.2 validity gates: min-samples, positive span, coverage, freshness.
    function _valid(Obs[] memory obs, Config memory cfg) private pure returns (bool) {
        uint256 n = obs.length;
        if (n < cfg.minSamples) return false; // too thin

        uint64 first = obs[0].ts;
        uint64 last = obs[n - 1].ts;
        if (last <= first) return false; // zero span — cannot time-weight
        if (cfg.tExpiry <= cfg.tLock) return false; // malformed window

        uint256 window = uint256(cfg.tExpiry - cfg.tLock);
        uint256 span = uint256(last - first);
        if (span * 10_000 < window * cfg.minCoverageBps) return false; // coverage
        if (uint256(cfg.tExpiry - last) > cfg.maxStaleness) return false; // late-freshness
        return true;
    }

    /// Stepwise time-weight: each price holds until the next sample; the final
    /// sample only bounds the last interval. Numerator of the TWAP.
    function _weightedSum(Obs[] memory obs) private pure returns (int256 acc) {
        uint256 n = obs.length;
        for (uint256 i = 0; i + 1 < n; i++) {
            uint256 dt = uint256(obs[i + 1].ts - obs[i].ts);
            acc += obs[i].price * int256(dt);
        }
    }
}
