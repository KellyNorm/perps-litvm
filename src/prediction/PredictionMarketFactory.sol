// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAggregatorV3} from "./IAggregatorV3.sol";
import {SafeAggregatorReader} from "./SafeAggregatorReader.sol";
import {ParimutuelPredictions} from "./ParimutuelPredictions.sol";

/**
 * @title PredictionMarketFactory
 * @notice The AUTO-FACTORY / replenish layer (design §2, §9) on top of the
 *         verified {ParimutuelPredictions} money layer. It keeps a rolling board
 *         of ~7 live markets across a GOVERNANCE-CONFIGURABLE asset list, each on
 *         a randomly chosen asset + timeframe, and guarantees there is ALWAYS at
 *         least one OPEN (bettable) market.
 *
 * @dev    Design guarantees encoded here:
 *         - **Configurable feeds, not fixed-at-deploy (§2).** Assets live in a
 *           registry that governance can extend ({addAsset}), toggle
 *           ({setAssetEnabled}), and — crucially — RE-POINT ({setAssetFeed}).
 *           This is what lets us deploy on a stand-in feed today and swap in DIA's
 *           real addresses later as a config transaction, no redeploy. A market
 *           SNAPSHOTS its feed at creation (resolution layer), so re-pointing an
 *           asset only affects FUTURE markets; in-flight markets settle on their
 *           original feed.
 *         - **Never all-locked (§9.1).** {replenish} refills the board to the
 *           target; if the board would otherwise have nothing Open, it force-opens
 *           a fresh short-timeframe market. Because every freshly created market
 *           starts Open, ≥1 Open market is structural — independent of the random
 *           draw.
 *         - **Randomness touches ONLY selection (§9.3).** `block.prevrandao` picks
 *           which asset/timeframe to list next — nothing else. No strike, TWAP,
 *           payout, fee, or refund reads it (verified in tests, invariant §14.6).
 *         - **Permissionless & self-healing (§9.4).** Anyone can {replenish}; a
 *           dead keeper cannot freeze the board, and the resolution layer's grace
 *           refund still guarantees eventual exit.
 *         - **Bounded gas.** A pruned active-set is scanned, never full history.
 */
contract PredictionMarketFactory is ParimutuelPredictions {
    // ------------------------------------------------------------------ types

    struct Asset {
        string symbol; // display / keeper label
        IAggregatorV3 feed; // AggregatorV3 adapter (a DIA feed in prod) — RE-POINTABLE
        uint8 feedDecimals; // cached decimals() of the feed
        uint8 displayDp; // UI display precision (per-asset)
        bool enabled; // governance toggle: stops NEW markets; in-flight settle on
    }

    // -------------------------------------------------------------- constants

    /// Target rolling count of live (Open|Locked) markets (design §9.1).
    uint256 public constant TARGET_ACTIVE = 7;

    /// Timeframe indices and their betting/settlement windows (design §4, ⅔/⅓;
    /// 24h is the ratio exception — see {_windows}).
    uint8 public constant TF_15M = 0;
    uint8 public constant TF_30M = 1;
    uint8 public constant TF_1H = 2;
    uint8 public constant TF_24H = 3;
    /// Number of timeframes; keep in lockstep with the TF_* set and {_windows}.
    uint256 internal constant TF_COUNT = 4;

    // ---------------------------------------------------------------- storage

    /// Asset registry; index = assetId. Governance-configurable (design §2).
    Asset[] public assets;

    /// Ids of not-yet-resolved markets — the bounded set replenish scans.
    uint256[] internal _liveIds;
    mapping(uint256 => uint256) internal _livePos; // marketId => index+1 (0 = absent)

    /// Timeframe a market was opened at (for selection de-dup / labeling).
    mapping(uint256 => uint8) internal _timeframeOf;

    // ----------------------------------------------------------------- events

    event AssetAdded(uint16 indexed assetId, string symbol, address feed, uint8 feedDecimals, uint8 displayDp);
    event AssetFeedUpdated(uint16 indexed assetId, address oldFeed, address newFeed, uint8 feedDecimals);
    event AssetEnabledSet(uint16 indexed assetId, bool enabled);
    event FactoryMarketCreated(uint256 indexed marketId, uint16 indexed assetId, uint8 timeframe);

    // ----------------------------------------------------------------- errors

    error NoSuchAsset();
    error InvalidFeed();
    error BadTimeframe();

    // ------------------------------------------------------------ constructor

    constructor(IERC20 musd_, address treasury_, uint256 feeBps_, address owner_, uint256 maxStaleness_)
        ParimutuelPredictions(musd_, treasury_, feeBps_, owner_, maxStaleness_)
    {}

    // -------------------------------------------- asset registry (design §2/§11)

    /**
     * @notice Onboard a DIA (or any AggregatorV3-shaped) feed as a new asset.
     * @dev Governance only. Reads `decimals()` to validate the feed really is an
     *      aggregator and to cache its precision. Starts enabled.
     */
    function addAsset(string calldata symbol, IAggregatorV3 feed, uint8 displayDp)
        external
        onlyOwner
        returns (uint16 assetId)
    {
        uint8 dec = _readDecimals(feed);
        assets.push(Asset({symbol: symbol, feed: feed, feedDecimals: dec, displayDp: displayDp, enabled: true}));
        assetId = uint16(assets.length - 1);
        emit AssetAdded(assetId, symbol, address(feed), dec, displayDp);
    }

    /**
     * @notice RE-POINT an asset to a new feed — the DIA-swap path (design §2).
     * @dev Governance only. Only affects FUTURE markets: existing markets hold
     *      their own snapshotted feed and settle on it. Re-reads/caches decimals.
     */
    function setAssetFeed(uint16 assetId, IAggregatorV3 newFeed) external onlyOwner {
        Asset storage a = _asset(assetId);
        address old = address(a.feed);
        uint8 dec = _readDecimals(newFeed);
        a.feed = newFeed;
        a.feedDecimals = dec;
        emit AssetFeedUpdated(assetId, old, address(newFeed), dec);
    }

    /// Enable/disable NEW markets on an asset; in-flight markets settle normally.
    function setAssetEnabled(uint16 assetId, bool enabled) external onlyOwner {
        _asset(assetId).enabled = enabled;
        emit AssetEnabledSet(assetId, enabled);
    }

    function assetCount() external view returns (uint256) {
        return assets.length;
    }

    // ------------------------------------------------------- replenish (§9.2)

    /**
     * @notice Permissionless board maintenance (design §9.2, §9.4). Reaps expired
     *         markets, refills the board to {TARGET_ACTIVE}, and guarantees ≥1
     *         Open market. Idempotent and cheap when the board is already full.
     * @dev While paused, only reaping runs (settle/claim must always work); no new
     *      markets are opened until unpaused. Anyone may call.
     */
    function replenish() external {
        _reap();
        if (paused()) return;
        _fillBoard();
    }

    /// Settle any live market that is past expiry. Best-effort: a market that
    /// cannot form a TWAP yet (awaiting grace) is simply left for a later call.
    function _reap() internal {
        uint256[] memory ids = _liveIds; // snapshot: settle() mutates _liveIds
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 id = ids[i];
            Market storage m = _market(id);
            if ((m.phase == Phase.Open || m.phase == Phase.Locked) && block.timestamp >= m.tExpiry) {
                try this.settle(id) {} catch {}
            }
        }
    }

    /// Refill to the target and enforce the never-all-locked guarantee (§9.1).
    function _fillBoard() internal {
        uint16[] memory enabled = _enabledAssetIds();
        if (enabled.length == 0) return; // no feed to create on

        (uint256 active, uint256 open) = _boardCounts();

        while (active < TARGET_ACTIVE) {
            (bool ok, uint16 assetId, uint8 tf) = _select(enabled, _markets.length);
            if (!ok) break; // no creatable (healthy) asset right now
            _createFactoryMarket(assetId, tf);
            active += 1;
            open += 1; // a freshly created market is always Open
        }

        // Guarantee: if nothing is Open, force a fresh SHORT-timeframe Open market.
        // Structural — does not depend on the random draw.
        if (open == 0) {
            (bool ok, uint16 assetId) = _firstHealthyEnabled(enabled);
            if (ok) _createFactoryMarket(assetId, TF_15M); // shortest frame
        }
    }

    // ------------------------------------------------- randomized selection (§9.3)

    /**
     * @notice Pick an (asset, timeframe) to list next. `block.prevrandao` seeds
     *         the choice — and ONLY the choice (design §9.3, invariant §14.6).
     * @dev De-dup preferred (avoid an identical live-Open market), but a duplicate
     *      is accepted rather than create on an unhealthy feed. Never returns an
     *      unhealthy-feed asset: a market is never created on a stale/invalid feed.
     */
    function _select(uint16[] memory enabled, uint256 nonce)
        internal
        view
        returns (bool found, uint16 assetId, uint8 timeframe)
    {
        uint256 len = enabled.length;
        // prevrandao is sequencer-influenced on Nitro — acceptable BY CONSTRUCTION
        // because it steers only which market is listed, never any money value.
        uint256 seed = uint256(keccak256(abi.encodePacked(block.prevrandao, block.timestamp, nonce, len)));
        uint256 start = seed % len;
        timeframe = uint8((seed >> 128) % TF_COUNT);

        // Pass 1: healthy feed AND no identical live-Open market (variety).
        for (uint256 k = 0; k < len; k++) {
            uint16 cand = enabled[(start + k) % len];
            if (_feedHealthy(cand) && !_hasLiveOpen(cand, timeframe)) return (true, cand, timeframe);
        }
        // Pass 2: accept a duplicate, but still require a healthy feed.
        for (uint256 k = 0; k < len; k++) {
            uint16 cand = enabled[(start + k) % len];
            if (_feedHealthy(cand)) return (true, cand, timeframe);
        }
        return (false, 0, timeframe);
    }

    /// Read-only preview of the current-block selection (keeper / UI / tests).
    function previewSelect() external view returns (bool found, uint16 assetId, uint8 timeframe) {
        return _select(_enabledAssetIds(), _markets.length);
    }

    // --------------------------------------------------------- factory internals

    function _createFactoryMarket(uint16 assetId, uint8 tf) internal {
        (uint64 betWindow, uint64 settleWindow) = _windows(tf);
        // offset 0 => strike = spot, a fair ~50/50 market (design §6 default).
        uint256 id = _openMarket(assetId, assets[assetId].feed, betWindow, settleWindow, 0, false);
        _timeframeOf[id] = tf;
        emit FactoryMarketCreated(id, assetId, tf);
    }

    function _windows(uint8 tf) internal pure returns (uint64 betWindow, uint64 settleWindow) {
        if (tf == TF_15M) return (600, 300); // 15m: ⅔ bet / ⅓ settle
        if (tf == TF_30M) return (1200, 600); // 30m: ⅔ bet / ⅓ settle
        if (tf == TF_1H) return (2400, 1200); // 1h:  ⅔ bet / ⅓ settle
        // 24h: settlement window FIXED at 1800s (30m), DECOUPLED from the ⅔/⅓ ratio
        // (which would be an 8h window). An 8h window stores ~thousands of samples
        // that settle() must loop — risking an unsettleable market — and needs 8h of
        // continuous keeper sampling on a 502/504-prone RPC. 1800s clears the 60%
        // coverage gate ~12x at 300s staleness. betWindow = 24h − 30m.
        if (tf == TF_24H) return (84_600, 1_800);
        revert BadTimeframe(); // no silent fallthrough to a default window
    }

    function _feedHealthy(uint16 assetId) internal view returns (bool ok) {
        (ok,) = SafeAggregatorReader.readFreshPrice(assets[assetId].feed, maxStaleness);
    }

    /// Is there already a bettable (Open, pre-lock) market on this asset+timeframe?
    function _hasLiveOpen(uint16 assetId, uint8 tf) internal view returns (bool) {
        uint256 n = _liveIds.length;
        for (uint256 i = 0; i < n; i++) {
            uint256 id = _liveIds[i];
            Market storage m = _market(id);
            if (m.assetId == assetId && _timeframeOf[id] == tf && m.phase == Phase.Open && block.timestamp < m.tLock) {
                return true;
            }
        }
        return false;
    }

    function _enabledAssetIds() internal view returns (uint16[] memory ids) {
        uint256 n = assets.length;
        uint256 c;
        for (uint256 i = 0; i < n; i++) {
            if (assets[i].enabled) c++;
        }
        ids = new uint16[](c);
        uint256 j;
        for (uint256 i = 0; i < n; i++) {
            if (assets[i].enabled) ids[j++] = uint16(i);
        }
    }

    function _firstHealthyEnabled(uint16[] memory enabled) internal view returns (bool, uint16) {
        for (uint256 i = 0; i < enabled.length; i++) {
            if (_feedHealthy(enabled[i])) return (true, enabled[i]);
        }
        return (false, 0);
    }

    // --------------------------------------------------- board bookkeeping

    /// Count live markets that are still active (pre-expiry) and still Open.
    function _boardCounts() internal view returns (uint256 active, uint256 open) {
        uint256 n = _liveIds.length;
        for (uint256 i = 0; i < n; i++) {
            Market storage m = _market(_liveIds[i]);
            bool notTerminal = m.phase == Phase.Open || m.phase == Phase.Locked;
            if (notTerminal && block.timestamp < m.tExpiry) {
                active += 1;
                if (m.phase == Phase.Open && block.timestamp < m.tLock) open += 1;
            }
        }
    }

    function boardCounts() external view returns (uint256 active, uint256 open) {
        return _boardCounts();
    }

    function liveMarketCount() external view returns (uint256) {
        return _liveIds.length;
    }

    function timeframeOf(uint256 marketId) external view returns (uint8) {
        return _timeframeOf[marketId];
    }

    // ------------------------------------------------------------ hooks (§ base)

    /// Register a freshly opened market in the active-set.
    function _onMarketCreated(uint256 marketId) internal override {
        _liveIds.push(marketId);
        _livePos[marketId] = _liveIds.length; // store index+1
    }

    /// Prune a resolved market from the active-set (swap-and-pop, O(1)).
    function _afterResolve(uint256 marketId) internal override {
        uint256 pos = _livePos[marketId];
        if (pos == 0) return; // not tracked
        uint256 i = pos - 1;
        uint256 lastId = _liveIds[_liveIds.length - 1];
        _liveIds[i] = lastId;
        _livePos[lastId] = i + 1;
        _liveIds.pop();
        _livePos[marketId] = 0;
    }

    // ----------------------------------------------------------------- internal

    function _asset(uint16 assetId) internal view returns (Asset storage) {
        if (assetId >= assets.length) revert NoSuchAsset();
        return assets[assetId];
    }

    function _readDecimals(IAggregatorV3 feed) internal view returns (uint8) {
        if (address(feed) == address(0)) revert InvalidFeed();
        try feed.decimals() returns (uint8 dec) {
            return dec;
        } catch {
            revert InvalidFeed();
        }
    }
}
