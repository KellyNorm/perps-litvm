// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IAggregatorV3} from "../../src/prediction/IAggregatorV3.sol";
import {OracleResolvedMarket} from "../../src/prediction/OracleResolvedMarket.sol";
import {ParimutuelPredictions} from "../../src/prediction/ParimutuelPredictions.sol";
import {PredictionMarketFactory} from "../../src/prediction/PredictionMarketFactory.sol";
import {MockAggregatorV3} from "./MockAggregatorV3.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";

/// A contract with code but no `decimals()` - used to prove feed validation.
contract NotAFeed {
    uint256 public x;
}

/**
 * @title PredictionMarketFactoryTest
 * @notice Tests for the auto-factory / replenish layer (design section 2, section 9, section 14). The
 *         board is maintained at the target, selection spans assets/timeframes,
 *         the never-all-locked guarantee holds under adversarial randomness,
 *         randomness touches only selection, and feeds are governance-settable
 *         (the DIA-swap path) with unhealthy feeds rejected at creation.
 */
contract PredictionMarketFactoryTest is Test {
    PredictionMarketFactory internal f;
    MockERC20 internal musd;

    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal carol = makeAddr("carol");
    address internal keeper = makeAddr("keeper"); // an arbitrary permissionless caller

    uint256 internal constant NOW = 1_000_000;
    int256 internal constant PRICE = 60_000e8;

    function setUp() public {
        musd = new MockERC20("Mock USD", "mUSD");
        f = new PredictionMarketFactory(IERC20(address(musd)), treasury, 0, address(this));
        vm.warp(NOW);

        musd.mint(alice, 1e30);
        musd.mint(carol, 1e30);
        vm.prank(alice);
        musd.approve(address(f), type(uint256).max);
        vm.prank(carol);
        musd.approve(address(f), type(uint256).max);
    }

    // --- helpers -------------------------------------------------------------

    /// Add `n` assets, each with its own feed healthy at `PRICE` as of now.
    function _addAssets(uint256 n) internal returns (MockAggregatorV3[] memory feeds) {
        feeds = new MockAggregatorV3[](n);
        for (uint256 i = 0; i < n; i++) {
            MockAggregatorV3 feed = new MockAggregatorV3(8);
            feed.setHealthy(PRICE, block.timestamp);
            f.addAsset(string(abi.encodePacked("A", vm.toString(i))), IAggregatorV3(address(feed)), 2);
            feeds[i] = feed;
        }
    }

    /// Keep every asset's feed fresh at the current block time.
    function _refreshFeeds(MockAggregatorV3[] memory feeds) internal {
        for (uint256 i = 0; i < feeds.length; i++) {
            feeds[i].setHealthy(PRICE, block.timestamp);
        }
    }

    // =========================================================================
    // Board maintenance (design section 9.1, section 9.2)
    // =========================================================================

    function test_Replenish_FillsToTarget_AndSpansAssets() public {
        _addAssets(11);
        f.replenish();

        (uint256 active, uint256 open) = f.boardCounts();
        assertEq(active, f.TARGET_ACTIVE(), "board filled to target");
        assertGe(open, 1, "at least one Open market");
        assertEq(f.liveMarketCount(), f.TARGET_ACTIVE(), "live set == target");

        // De-dup spreads the board across assets (not 7 identical markets).
        uint256 distinctAssets = _distinctAssetCount();
        assertGe(distinctAssets, 2, "board spans multiple assets");
    }

    function test_Replenish_IdempotentWhenFull() public {
        _addAssets(11);
        f.replenish();
        uint256 liveAfterFirst = f.liveMarketCount();
        f.replenish(); // nothing to do
        assertEq(f.liveMarketCount(), liveAfterFirst, "no extra markets when already full");
    }

    function test_Replenish_RefillsAfterEverythingExpires() public {
        MockAggregatorV3[] memory feeds = _addAssets(11);
        f.replenish();
        assertEq(f.liveMarketCount(), 7, "initial board");

        // Warp past the longest timeframe so every market expires.
        vm.warp(NOW + 4000);
        _refreshFeeds(feeds);

        f.replenish(); // reaps all (empty => VOID) + refills
        (uint256 active,) = f.boardCounts();
        assertEq(active, 7, "board back to target after mass expiry");
        assertEq(f.liveMarketCount(), 7, "dead markets pruned from the live set");
    }

    function test_Replenish_IsPermissionless() public {
        _addAssets(3);
        vm.prank(keeper); // not the owner
        f.replenish();
        (uint256 active,) = f.boardCounts();
        assertEq(active, 7, "anyone can top up the board");
    }

    // =========================================================================
    // NEVER ALL LOCKED - structural guarantee under adversarial randomness (section 9.1)
    // =========================================================================

    function test_NeverAllLocked_ForcesOpenMarketOnFullLockedBoard() public {
        MockAggregatorV3[] memory feeds = _addAssets(1);
        IAggregatorV3 feed = IAggregatorV3(address(feeds[0]));

        // Hand-build a worst case: TARGET markets, all 5m, all created now.
        for (uint256 i = 0; i < 7; i++) {
            f.createMarket(0, feed, 200, 100, 0, false); // owner path, deterministic windows
        }
        // Warp past every lock (200s) but before every expiry (300s): all Locked.
        vm.warp(NOW + 250);
        (uint256 active, uint256 open) = f.boardCounts();
        assertEq(active, 7, "board full");
        assertEq(open, 0, "and nothing Open - the worst case");

        // Adversarial randomness: whatever prevrandao is, the guarantee holds.
        vm.prevrandao(bytes32(uint256(0xBADC0FFEE)));
        feeds[0].setHealthy(PRICE, block.timestamp);
        f.replenish();

        (, uint256 openAfter) = f.boardCounts();
        assertGe(openAfter, 1, "replenish force-opens a fresh bettable market");
    }

    function test_NeverAllLocked_FreshBoardAlwaysHasOpen() public {
        _addAssets(11);
        // Across several adversarial draws, a replenished board always has >=1 Open.
        for (uint256 s = 0; s < 5; s++) {
            vm.prevrandao(bytes32(uint256(keccak256(abi.encodePacked("adv", s)))));
            f.replenish();
            (, uint256 open) = f.boardCounts();
            assertGe(open, 1, "always at least one Open market");
        }
    }

    // =========================================================================
    // Randomized selection (design section 9.3) + randomness isolation (section 14.6)
    // =========================================================================

    function test_Selection_SpansAssetsAndTimeframes() public {
        _addAssets(11);
        bool[3] memory tfSeen;
        uint256 assetMask;
        for (uint256 s = 0; s < 40; s++) {
            vm.prevrandao(bytes32(uint256(keccak256(abi.encodePacked("seed", s)))));
            (bool ok, uint16 assetId, uint8 tf) = f.previewSelect();
            assertTrue(ok, "an enabled healthy asset is always selectable");
            tfSeen[tf] = true;
            assetMask |= (uint256(1) << assetId);
        }
        uint256 tfCount = (tfSeen[0] ? 1 : 0) + (tfSeen[1] ? 1 : 0) + (tfSeen[2] ? 1 : 0);
        assertEq(tfCount, 3, "selection spans all three timeframes");

        uint256 distinctAssets = _popcount(assetMask);
        assertGe(distinctAssets, 3, "selection spans several assets");
    }

    /// prevrandao steers WHICH market is listed, but never any money value.
    function test_Randomness_AffectsSelectionButNotPayouts() public {
        MockAggregatorV3[] memory feeds = _addAssets(11);

        // Two different prevrandao values generally pick different (asset, tf).
        vm.prevrandao(bytes32(uint256(1)));
        (, uint16 aX, uint8 tfX) = f.previewSelect();
        vm.prevrandao(bytes32(uint256(2)));
        (, uint16 aY, uint8 tfY) = f.previewSelect();
        assertTrue(aX != aY || tfX != tfY, "selection depends on randomness");

        // Now prove strike + payout do NOT: identical markets under different
        // prevrandao settle to byte-identical results.
        uint256 payoutUnderA = _runIdenticalMarket(feeds[0], bytes32(uint256(0xA11)));
        uint256 payoutUnderB = _runIdenticalMarket(feeds[0], bytes32(uint256(0xB22)));
        assertEq(payoutUnderA, payoutUnderB, "payout is independent of randomness (section 14.6)");
    }

    /// Build one market at a fixed price/fee, run one standard bet+resolve, and
    /// return the winner's payout. Only prevrandao differs between calls.
    function _runIdenticalMarket(MockAggregatorV3 feed, bytes32 rnd) internal returns (uint256 payout) {
        vm.prevrandao(rnd);
        feed.setHealthy(PRICE, block.timestamp);
        uint256 id = f.createMarket(0, IAggregatorV3(address(feed)), 600, 300, 0, false);

        // strike is the feed price, never the randomness.
        assertEq(f.getMarket(id).strike, PRICE, "strike = feed price, not prevrandao");

        vm.prank(alice);
        f.bet(id, ParimutuelPredictions.Side.Up, 100e18);
        vm.prank(carol);
        f.bet(id, ParimutuelPredictions.Side.Down, 100e18);

        uint256 t0 = block.timestamp;
        _obs(feed, id, t0 + 610, PRICE + 1_000e8);
        _obs(feed, id, t0 + 750, PRICE + 1_000e8);
        _obs(feed, id, t0 + 890, PRICE + 1_000e8);
        vm.warp(t0 + 900);
        f.settle(id);

        uint256 before = musd.balanceOf(alice);
        vm.prank(alice);
        f.claim(id);
        payout = musd.balanceOf(alice) - before;
    }

    function _obs(MockAggregatorV3 feed, uint256 id, uint256 ts, int256 price) internal {
        vm.warp(ts);
        feed.setHealthy(price, ts);
        f.observe(id);
    }

    // =========================================================================
    // Governance-settable feeds - the DIA swap (design section 2, section 11)
    // =========================================================================

    function test_Feed_IsGovernanceSettable_SwapPickedUpByNewMarkets() public {
        // Asset 0 on feedA @ priceA.
        MockAggregatorV3 feedA = new MockAggregatorV3(8);
        feedA.setHealthy(PRICE, block.timestamp);
        f.addAsset("BTC", IAggregatorV3(address(feedA)), 2);

        f.replenish(); // 7 markets on asset 0, strike from feedA
        uint256 oldId = 0;
        assertEq(address(f.getMarket(oldId).feed), address(feedA), "market snapshots feedA");
        assertEq(f.getMarket(oldId).strike, PRICE, "strike from feedA");

        // Governance re-points asset 0 to feedB @ a different price (the DIA swap).
        int256 priceB = 50_000e8;
        MockAggregatorV3 feedB = new MockAggregatorV3(8);
        f.setAssetFeed(0, IAggregatorV3(address(feedB)));
        (, IAggregatorV3 regFeed,,,) = f.assets(0);
        assertEq(address(regFeed), address(feedB), "registry now points at feedB");

        // In-flight market is UNAFFECTED (still holds feedA).
        assertEq(address(f.getMarket(oldId).feed), address(feedA), "old market keeps feedA");

        // New markets pick up feedB.
        vm.warp(NOW + 4000); // expire the old board
        feedB.setHealthy(priceB, block.timestamp);
        f.replenish();
        uint256 newId = f.liveMarketCount() > 0 ? _anyLiveMarketOnAsset(0) : 0;
        assertEq(address(f.getMarket(newId).feed), address(feedB), "new market uses swapped feedB");
        assertEq(f.getMarket(newId).strike, priceB, "strike now from feedB");
    }

    function test_SetAssetFeed_OwnerOnly_AndValidates() public {
        _addAssets(1);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        f.setAssetFeed(0, IAggregatorV3(address(0x1234)));

        vm.expectRevert(PredictionMarketFactory.InvalidFeed.selector);
        f.setAssetFeed(0, IAggregatorV3(address(0)));

        NotAFeed bad = new NotAFeed();
        vm.expectRevert(PredictionMarketFactory.InvalidFeed.selector);
        f.setAssetFeed(0, IAggregatorV3(address(bad)));

        vm.expectRevert(PredictionMarketFactory.NoSuchAsset.selector);
        f.setAssetFeed(9, IAggregatorV3(address(0x1234)));
    }

    function test_AddAsset_OwnerOnly_AndValidatesFeed() public {
        MockAggregatorV3 good = new MockAggregatorV3(8);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        f.addAsset("X", IAggregatorV3(address(good)), 2);

        vm.expectRevert(PredictionMarketFactory.InvalidFeed.selector);
        f.addAsset("X", IAggregatorV3(address(0)), 2);

        NotAFeed bad = new NotAFeed();
        vm.expectRevert(PredictionMarketFactory.InvalidFeed.selector);
        f.addAsset("X", IAggregatorV3(address(bad)), 2);
    }

    function test_DisabledAsset_NotSelected() public {
        _addAssets(2);
        f.setAssetEnabled(1, false); // only asset 0 is listable

        f.replenish();
        // Every created market is on asset 0.
        uint256 n = f.marketCount();
        for (uint256 i = 0; i < n; i++) {
            assertEq(uint256(f.getMarket(i).assetId), 0, "disabled asset never listed");
        }
    }

    // =========================================================================
    // Unhealthy feed handling (design section 6)
    // =========================================================================

    function test_CreateMarket_RejectsUnhealthyFeed() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8);
        f.addAsset("X", IAggregatorV3(address(feed)), 2);
        feed.setHealthy(PRICE, block.timestamp - 200); // stale (> 120s MAX_STALENESS)

        vm.expectRevert(OracleResolvedMarket.FeedUnhealthyAtCreation.selector);
        f.createMarket(0, IAggregatorV3(address(feed)), 600, 300, 0, false);
    }

    function test_Replenish_SkipsUnhealthyAsset_NoRevert() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8);
        f.addAsset("X", IAggregatorV3(address(feed)), 2);
        feed.setHealthy(PRICE, block.timestamp - 10_000); // stale, only asset

        f.replenish(); // must not revert; simply creates nothing
        assertEq(f.liveMarketCount(), 0, "no market created on an unhealthy feed");

        // Once the feed recovers, the board fills.
        feed.setHealthy(PRICE, block.timestamp);
        f.replenish();
        (uint256 active,) = f.boardCounts();
        assertEq(active, 7, "board fills once the feed is healthy");
    }

    // =========================================================================
    // Pause semantics (design section 11) - reap yes, new markets no
    // =========================================================================

    function test_Replenish_WhenPaused_ReapsButDoesNotCreate() public {
        MockAggregatorV3[] memory feeds = _addAssets(3);
        f.replenish();
        assertEq(f.liveMarketCount(), 7, "board built");

        f.pause();
        vm.warp(NOW + 4000); // everything expires
        _refreshFeeds(feeds);

        f.replenish(); // reaps the expired (empty) markets to VOID, creates none
        assertEq(f.liveMarketCount(), 0, "paused: reaped, not refilled");

        f.unpause();
        f.replenish();
        assertEq(f.liveMarketCount(), 7, "unpaused: board refills");
    }

    // --- test-only view shims + utilities -----------------------------------

    function _distinctAssetCount() internal view returns (uint256) {
        uint256 mask;
        uint256 n = f.marketCount();
        for (uint256 i = 0; i < n; i++) {
            mask |= (uint256(1) << f.getMarket(i).assetId);
        }
        return _popcount(mask);
    }

    function _anyLiveMarketOnAsset(uint16 assetId) internal view returns (uint256) {
        uint256 n = f.marketCount();
        for (uint256 i = n; i > 0; i--) {
            uint256 id = i - 1;
            OracleResolvedMarket.Market memory m = f.getMarket(id);
            if (
                m.assetId == assetId
                    && (m.phase == OracleResolvedMarket.Phase.Open || m.phase == OracleResolvedMarket.Phase.Locked)
            ) {
                return id;
            }
        }
        return 0;
    }

    function _popcount(uint256 x) internal pure returns (uint256 c) {
        while (x != 0) {
            c += x & 1;
            x >>= 1;
        }
    }
}
