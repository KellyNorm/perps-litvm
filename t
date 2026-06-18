[1mdiff --git a/src/PositionManager.sol b/src/PositionManager.sol[m
[1mindex 634fc96..7392e64 100644[m
[1m--- a/src/PositionManager.sol[m
[1m+++ b/src/PositionManager.sol[m
[36m@@ -19,20 +19,34 @@[m [mimport {LiquidityPool} from "./LiquidityPool.sol";[m
  *         (via {MainDemoConsumerBase}) verifies the signer(s) and the package[m
  *         timestamp before using the value.[m
  *[m
[31m- * @dev    SCOPE (PR-3): open/close of one full position per[m
[32m+[m[32m * @dev    SCOPE (PR-3 + PR-4a): open/close of one full position per[m
  *         (owner, market, direction); P&L settled against the pool; LP-share[m
[31m- *         valuation via a cached aggregate mark; reserved-liquidity solvency.[m
[32m+[m[32m *         valuation via a cached aggregate mark; reserved-liquidity solvency;[m
[32m+[m[32m *         a time-based borrow fee (PR-4a) charged on notional, accrued O(1) via[m
[32m+[m[32m *         a per-market cumulative index and deducted from payout at close.[m
  *[m
  *         OUT OF SCOPE — deferred to later PRs:[m
[31m- *         - Funding rate & fees (PR-4).[m
[32m+[m[32m *         - Funding rate between longs & shorts (PR-4b, sequenced AFTER PR-5 so[m
[32m+[m[32m *           liquidations can bound a funding payer who outruns its collateral).[m
  *         - Liquidations AND residual bad debt beyond collateral (PR-5). Here a[m
[31m- *           loss is floored at the trader's collateral; any deficit past it is[m
[31m- *           simply not collected — PR-5 owns that path.[m
[32m+[m[32m *           loss — and likewise a borrow fee — is floored at the trader's[m
[32m+[m[32m *           collateral; any deficit past it is simply not collected — PR-5 owns[m
[32m+[m[32m *           that path.[m
  *         - Two-step deferred execution / front-running protection (PR-6). This[m
  *           contract reads the price in the SAME transaction as the action.[m
  *         - Payload-aware LP deposit/withdraw to close the share-price fairness[m
  *           gap (its own PR; see TASK.md).[m
  *[m
[32m+[m[32m *         BORROW FEE (PR-4a): a flat per-second rate on each position's notional[m
[32m+[m[32m *         (`sizeUsd`) compensates LPs for the liquidity the position reserves.[m
[32m+[m[32m *         It is a pure trader -> pool transfer, recognized on close (never[m
[32m+[m[32m *         pre-credited to LP NAV — same conservative stance as unrealized[m
[32m+[m[32m *         losses). Accrual is O(1): a single per-market index accumulates[m
[32m+[m[32m *         `Σ rate·dt`; each position records the index at open; the fee owed is[m
[32m+[m[32m *         `sizeUsd · (indexNow − indexAtOpen)`. Because the rate is constant,[m
[32m+[m[32m *         lazy accrual is exact regardless of gaps between trades, so no keeper[m
[32m+[m[32m *         tick is required.[m
[32m+[m[32m *[m
  *         COLLATERAL CUSTODY: trader collateral is held by THIS contract, never[m
  *         by the pool, so it is never counted as LP NAV. On close the pool pays[m
  *         profit (capped) or absorbs loss (capped at collateral); collateral is[m
[36m@@ -82,6 +96,17 @@[m [mcontract PositionManager is MainDemoConsumerBase, ReentrancyGuard {[m
     ///      chosen large enough to preserve precision through integer division.[m
     uint256 private constant WEIGHT_PRECISION = 1e18;[m
 [m
[32m+[m[32m    /// @dev Fixed-point scale for the borrow-fee index (accumulated[m
[32m+[m[32m    ///      `Σ rate·dt`, a dimensionless fraction of notional). 1e18 keeps the[m
[32m+[m[32m    ///      per-second rate well above the integer-truncation floor.[m
[32m+[m[32m    uint256 private constant FEE_PRECISION = 1e18;[m
[32m+[m
[32m+[m[32m    /// @notice Borrow-fee rate per second, scaled by {FEE_PRECISION}, charged on[m
[32m+[m[32m    ///         a position's notional (`sizeUsd`). Conservative starting value:[m
[32m+[m[32m    ///         `0.10 / 31_536_000 · 1e18 ≈ 3.17e9`, i.e. ~10%/yr on notional.[m
[32m+[m[32m    ///         Flat (utilization-independent) so the index advance is exact.[m
[32m+[m[32m    uint256 public constant BORROW_RATE_PER_SECOND = 3_170_979_198;[m
[32m+[m
     // --- supported markets (RedStone feed ids) ---------------------------[m
 [m
     /// @notice Supported market feed id for BTC.[m
[36m@@ -108,6 +133,9 @@[m [mcontract PositionManager is MainDemoConsumerBase, ReentrancyGuard {[m
      * @param  collateral Collateral posted, in asset units (18 dp).[m
      * @param  sizeUsd    Notional size = collateral * leverage (18 dp).[m
      * @param  entryPrice Entry mark price (1e8).[m
[32m+[m[32m     * @param  entryCumBorrowRate Borrow-fee index ({MarketState.cumBorrowRate})[m
[32m+[m[32m     *                    snapshotted at open; the fee owed at close is[m
[32m+[m[32m     *                    `sizeUsd · (cumBorrowRate − entryCumBorrowRate)`.[m
      */[m
     struct Position {[m
         address owner;[m
[36m@@ -116,6 +144,7 @@[m [mcontract PositionManager is MainDemoConsumerBase, ReentrancyGuard {[m
         uint256 collateral;[m
         uint256 sizeUsd;[m
         uint256 entryPrice;[m
[32m+[m[32m        uint256 entryCumBorrowRate;[m
     }[m
 [m
     /**[m
[36m@@ -129,6 +158,11 @@[m [mcontract PositionManager is MainDemoConsumerBase, ReentrancyGuard {[m
      * @param  shortWeight  Σ shortSize/shortEntry (scaled).[m
      * @param  lastMarkPrice Most recent mark for this market (1e8), refreshed on[m
      *                       every open/close.[m
[32m+[m[32m     * @param  cumBorrowRate Cumulative borrow-fee index for this market:[m
[32m+[m[32m     *                       `Σ BORROW_RATE_PER_SECOND·dt` scaled by[m
[32m+[m[32m     *                       {FEE_PRECISION}. Monotonically non-decreasing.[m
[32m+[m[32m     * @param  lastBorrowAccrual Timestamp the index last advanced; 0 until the[m
[32m+[m[32m     *                       market's first touch.[m
      */[m
     struct MarketState {[m
         uint256 longSizeUsd;[m
[36m@@ -136,6 +170,8 @@[m [mcontract PositionManager is MainDemoConsumerBase, ReentrancyGuard {[m
         uint256 shortSizeUsd;[m
         uint256 shortWeight;[m
         uint256 lastMarkPrice;[m
[32m+[m[32m        uint256 cumBorrowRate;[m
[32m+[m[32m        uint256 lastBorrowAccrual;[m
     }[m
 [m
     /// @notice Open positions keyed by keccak256(owner, market, isLong).[m
[36m@@ -183,6 +219,7 @@[m [mcontract PositionManager is MainDemoConsumerBase, ReentrancyGuard {[m
         uint256 exitPrice,[m
         bool profit,[m
         uint256 pnl,[m
[32m+[m[32m        uint256 borrowFee,[m
         uint256 payout[m
     );[m
 [m
[36m@@ -252,14 +289,17 @@[m [mcontract PositionManager is MainDemoConsumerBase, ReentrancyGuard {[m
             revert ExceedsUtilization();[m
         }[m
 [m
[31m-        // Effects.[m
[32m+[m[32m        // Effects. Accrue the borrow index to now so the position's entry[m
[32m+[m[32m        // snapshot excludes fees that accrued before it existed.[m
[32m+[m[32m        uint256 entryCumBorrowRate = _accrueBorrow(market);[m
         positions[key] = Position({[m
             owner: msg.sender,[m
             market: market,[m
             isLong: isLong,[m
             collateral: collateral,[m
             sizeUsd: sizeUsd,[m
[31m-            entryPrice: entryPrice[m
[32m+[m[32m            entryPrice: entryPrice,[m
[32m+[m[32m            entryCumBorrowRate: entryCumBorrowRate[m
         });[m
         _updateMarket(market, isLong, sizeUsd, entryPrice, entryPrice, true);[m
         totalReserved += reserve;[m
[36m@@ -282,6 +322,16 @@[m [mcontract PositionManager is MainDemoConsumerBase, ReentrancyGuard {[m
      *         and collateral is returned in full. Loss is capped at collateral[m
      *         (any deficit beyond it is left for PR-5); the trader receives[m
      *         collateral - loss and the loss is pushed into the pool.[m
[32m+[m[32m     *[m
[32m+[m[32m     *         BORROW FEE (PR-4a): the position's accrued borrow fee is then[m
[32m+[m[32m     *         deducted from the amount the trader would otherwise receive and[m
[32m+[m[32m     *         routed to the pool. With A = the trader's pre-fee proceeds[m
[32m+[m[32m     *         (profit: collateral + pnl; loss: collateral - pnl) the fee charged[m
[32m+[m[32m     *         is `min(fee, A)`, so payout = A - charged floors at 0 and never[m
[32m+[m[32m     *         underflows. If the fee alone exceeds A, the uncollected remainder[m
[32m+[m[32m     *         is simply not taken — the same bad-debt seam as a loss past[m
[32m+[m[32m     *         collateral, owned by PR-5. Net pool flow combines pnl and the fee[m
[32m+[m[32m     *         into a single {payProfit}/{receiveLoss} call (no new pool ABI).[m
      * @param  market Market feed id.[m
      * @param  isLong Direction of the position to close.[m
      */[m
[36m@@ -294,27 +344,56 @@[m [mcontract PositionManager is MainDemoConsumerBase, ReentrancyGuard {[m
         if (exitPrice == 0) revert InvalidPrice();[m
 [m
         (bool profit, uint256 pnl) = _computePnl(pos, exitPrice);[m
[31m-        uint256 reserve = pos.collateral * MAX_PROFIT_FACTOR;[m
 [m
[31m-        // Effects.[m
[32m+[m[32m        // Effects. Accrue the borrow index to now and snapshot the fee owed over[m
[32m+[m[32m        // this position's lifetime (Ceil rounding favours the pool), then clear[m
[32m+[m[32m        // the position's state before any external interaction (CEI).[m
[32m+[m[32m        uint256 borrowFee =[m
[32m+[m[32m            Math.mulDiv(pos.sizeUsd, _accrueBorrow(market) - pos.entryCumBorrowRate, FEE_PRECISION, Math.Rounding.Ceil);[m
         delete positions[key];[m
         _updateMarket(market, isLong, pos.sizeUsd, pos.entryPrice, exitPrice, false);[m
[31m-        totalReserved -= reserve;[m
[32m+[m[32m        totalReserved -= pos.collateral * MAX_PROFIT_FACTOR;[m
 [m
[31m-        // Interactions.[m
[31m-        uint256 payout;[m
[31m-        if (profit) {[m
[31m-            payout = pos.collateral + pnl;[m
[31m-            if (pnl > 0) pool.payProfit(pos.owner, pnl);[m
[32m+[m[32m        // Interactions (kept in a helper to bound this frame's stack).[m
[32m+[m[32m        uint256 payout = _settle(pos, profit, pnl, borrowFee);[m
[32m+[m
[32m+[m[32m        emit PositionClosed(pos.owner, market, isLong, exitPrice, profit, pnl, borrowFee, payout);[m
[32m+[m[32m    }[m
[32m+[m
[32m+[m[32m    /**[m
[32m+[m[32m     * @dev Settles a closing position's transfers and returns the trader payout.[m
[32m+[m[32m     *      `A` = pre-fee proceeds (profit: collateral + pnl; loss:[m
[32m+[m[32m     *      collateral - pnl). The fee is charged as `min(fee, A)` so payout[m
[32m+[m[32m     *      `= A - charged` floors at 0 and never underflows; any uncollected[m
[32m+[m[32m     *      remainder is left for PR-5. Pool flow is netted into a single[m
[32m+[m[32m     *      {payProfit} (pool -> trader) or {receiveLoss} (-> pool) call, with the[m
[32m+[m[32m     *      collected fee folded into that net. Called only from {closePosition}[m
[32m+[m[32m     *      after all state effects, so it runs under that function's CEI ordering[m
[32m+[m[32m     *      and `nonReentrant` guard.[m
[32m+[m[32m     */[m
[32m+[m[32m    function _settle(Position memory pos, bool profit, uint256 pnl, uint256 borrowFee)[m
[32m+[m[32m        internal[m
[32m+[m[32m        returns (uint256 payout)[m
[32m+[m[32m    {[m
[32m+[m[32m        uint256 available = profit ? pos.collateral + pnl : pos.collateral - pnl;[m
[32m+[m[32m        uint256 feeCharged = borrowFee > available ? available : borrowFee;[m
[32m+[m[32m        payout = available - feeCharged;[m
[32m+[m
[32m+[m[32m        // Net pool flow: pool pays profit, receives loss + the collected fee.[m
[32m+[m[32m        uint256 poolOut = profit ? pnl : 0;[m
[32m+[m[32m        uint256 poolIn = (profit ? 0 : pnl) + feeCharged;[m
[32m+[m
[32m+[m[32m        if (poolOut > poolIn) {[m
[32m+[m[32m            // Pool nets a payment to the trader; full collateral returned by PM.[m
[32m+[m[32m            pool.payProfit(pos.owner, poolOut - poolIn);[m
             asset.safeTransfer(pos.owner, pos.collateral);[m
         } else {[m
[31m-            uint256 returned = pos.collateral - pnl; // pnl already capped to collateral[m
[31m-            payout = returned;[m
[32m+[m[32m            // Pool nets an inflow (loss and/or fee); PM funds it from collateral.[m
[32m+[m[32m            uint256 toPool = poolIn - poolOut;[m
[32m+[m[32m            uint256 returned = pos.collateral - toPool; // toPool <= collateral by construction[m
             if (returned > 0) asset.safeTransfer(pos.owner, returned);[m
[31m-            if (pnl > 0) pool.receiveLoss(pnl);[m
[32m+[m[32m            if (toPool > 0) pool.receiveLoss(toPool);[m
         }[m
[31m-[m
[31m-        emit PositionClosed(pos.owner, market, isLong, exitPrice, profit, pnl, payout);[m
     }[m
 [m
     // --- views -----------------------------------------------------------[m
[36m@@ -324,6 +403,25 @@[m [mcontract PositionManager is MainDemoConsumerBase, ReentrancyGuard {[m
         return _positionKey(owner, market, isLong);[m
     }[m
 [m
[32m+[m[32m    /**[m
[32m+[m[32m     * @notice Borrow fee a currently-open position would owe if closed at the[m
[32m+[m[32m     *         current block time. View-only: projects the market's index forward[m
[32m+[m[32m     *         by the elapsed interval without mutating state. Returns 0 if no[m
[32m+[m[32m     *         such position is open. Uncapped (does not floor against[m
[32m+[m[32m     *         collateral); {closePosition} applies the cap on settlement.[m
[32m+[m[32m     */[m
[32m+[m[32m    function pendingBorrowFee(address owner, bytes32 market, bool isLong) external view returns (uint256) {[m
[32m+[m[32m        Position memory pos = positions[_positionKey(owner, market, isLong)];[m
[32m+[m[32m        if (pos.sizeUsd == 0) return 0;[m
[32m+[m[32m        MarketState storage m = markets[market];[m
[32m+[m[32m        uint256 cum = m.cumBorrowRate;[m
[32m+[m[32m        uint256 last = m.lastBorrowAccrual;[m
[32m+[m[32m        if (last != 0 && block.timestamp > last) {[m
[32m+[m[32m            cum += BORROW_RATE_PER_SECOND * (block.timestamp - last);[m
[32m+[m[32m        }[m
[32m+[m[32m        return Math.mulDiv(pos.sizeUsd, cum - pos.entryCumBorrowRate, FEE_PRECISION, Math.Rounding.Ceil);[m
[32m+[m[32m    }[m
[32m+[m
     // --- internal: P&L & aggregates --------------------------------------[m
 [m
     /**[m
[36m@@ -415,6 +513,36 @@[m [mcontract PositionManager is MainDemoConsumerBase, ReentrancyGuard {[m
         if (m.shortSizeUsd > shortValue) unrealized += m.shortSizeUsd - shortValue;[m
     }[m
 [m
[32m+[m[32m    // --- internal: borrow-fee accrual ------------------------------------[m
[32m+[m
[32m+[m[32m    /**[m
[32m+[m[32m     * @dev Advances `market`'s borrow-fee index to the current block time and[m
[32m+[m[32m     *      returns the up-to-date cumulative value. Because the rate is flat[m
[32m+[m[32m     *      (size-independent), the advance `rate · elapsed` is exact for any[m
[32m+[m[32m     *      interval, so this lazy accrual is correct with no keeper tick — gaps[m
[32m+[m[32m     *      between trades are captured in full on the next touch. The first[m
[32m+[m[32m     *      touch only seeds the timestamp (no retroactive accrual).[m
[32m+[m[32m     *[m
[32m+[m[32m     *      Touches only `cumBorrowRate`/`lastBorrowAccrual`; it never moves[m
[32m+[m[32m     *      `totalUnrealizedProfit` or `totalReserved`, so pure time passing[m
[32m+[m[32m     *      cannot shift LP NAV or reserved liquidity — the fee is recognized[m
[32m+[m[32m     *      only when a close realizes it.[m
[32m+[m[32m     */[m
[32m+[m[32m    function _accrueBorrow(bytes32 market) internal returns (uint256) {[m
[32m+[m[32m        MarketState storage m = markets[market];[m
[32m+[m[32m        uint256 last = m.lastBorrowAccrual;[m
[32m+[m[32m        if (last == 0) {[m
[32m+[m[32m            m.lastBorrowAccrual = block.timestamp;[m
[32m+[m[32m            return m.cumBorrowRate;[m
[32m+[m[32m        }[m
[32m+[m[32m        uint256 elapsed = block.timestamp - last;[m
[32m+[m[32m        if (elapsed != 0) {[m
[32m+[m[32m            m.cumBorrowRate += BORROW_RATE_PER_SECOND * elapsed;[m
[32m+[m[32m            m.lastBorrowAccrual = block.timestamp;[m
[32m+[m[32m        }[m
[32m+[m[32m        return m.cumBorrowRate;[m
[32m+[m[32m    }[m
[32m+[m
     // --- internal: helpers -----------------------------------------------[m
 [m
     function _positionKey(address owner, bytes32 market, bool isLong) internal pure returns (bytes32) {[m
