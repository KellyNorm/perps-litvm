// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Owner-extendable market registry tests (PR-8).
//
// Covers the new owner-only registry layered onto PositionManager: BTC and ETH
// are seeded at deploy; the owner may add new markets (enabling opens) or remove
// markets (blocking NEW opens only). Delisting must never strand an existing
// position — close and liquidate are deliberately ungated — so the headline test
// proves a BTC position opened before a delisting still closes via the two-step
// flow afterward.
//
// FFI: prices come from the Node helper `test/ffi/redstone-mock-payload.js` (same
// as the other suites). `executeRequest` reads the signed price from the *tail*
// of the calldata, so its calls are built as
// abi.encodeWithSelector(fn, args) ++ redstonePayload and `call`ed. The request
// functions take no oracle payload and are called directly.

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {LiquidityPool} from "../src/LiquidityPool.sol";
import {PositionManager} from "../src/PositionManager.sol";
import {Governance} from "../src/Governance.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {AuthorisedMockSignersBase} from "@redstone-finance/evm-connector/contracts/mocks/AuthorisedMockSignersBase.sol";

/**
 * @dev Test-only subclass swapping the real demo signer for RedStone's mock
 *      signers so offline mock payloads verify (mirrors the other suites). The
 *      deployer (the test contract) is the {Ownable} owner.
 */
contract RegistryHarness is PositionManager, AuthorisedMockSignersBase {
    constructor(LiquidityPool pool_, Governance governance_) PositionManager(pool_, governance_) {}

    function getAuthorisedSignerIndex(address signerAddress) public view virtual override returns (uint8) {
        return getAuthorisedMockSignerIndex(signerAddress);
    }
}

contract MarketRegistryTest is Test {
    MockERC20 internal asset;
    LiquidityPool internal pool;
    RegistryHarness internal pm;

    address internal lp = makeAddr("lp");
    address internal alice = makeAddr("alice");
    address internal keeper = makeAddr("keeper");

    bytes32 internal constant BTC = bytes32("BTC");
    bytes32 internal constant ETH = bytes32("ETH");
    bytes32 internal constant SOL = bytes32("SOL");

    uint256 internal constant ONE8 = 1e8;
    uint256 internal constant LP_LIQUIDITY = 1_000_000e18;

    uint256 internal constant EXECUTION_FEE = 0.5e18;
    uint256 internal constant MIN_EXECUTION_DELAY = 3;

    // Position economics: collateral 1000, leverage 5 -> size 5000, entry 60000.
    uint256 internal constant COL = 1_000e18;
    uint256 internal constant LEV = 5;
    uint256 internal constant ENTRY = 60_000;

    function setUp() public {
        asset = new MockERC20("Mock USD", "mUSD");
        Governance gov = new Governance(address(this));
        pool = new LiquidityPool(IERC20(address(asset)), "Perps LP", "pLP", gov);
        pm = new RegistryHarness(pool, gov); // deployer == owner == address(this)
        pool.setPositionManager(address(pm));
        asset.mint(address(this), LP_LIQUIDITY);
        asset.approve(address(pool), LP_LIQUIDITY);
        pool.deposit(LP_LIQUIDITY, lp);
        vm.warp(1_700_000_000); // base block time (seconds)
    }

    // --- helpers ---------------------------------------------------------

    /// @dev bytes32 short-string feed id -> ascii string for the FFI helper.
    function _feedStr(bytes32 market) internal pure returns (string memory) {
        uint256 len;
        while (len < 32 && market[len] != 0) len++;
        bytes memory b = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            b[i] = market[i];
        }
        return string(b);
    }

    function _payload(uint256 tsMs, bytes32 market, uint256 price) internal returns (bytes memory) {
        string[] memory cmd = new string[](4);
        cmd[0] = "node";
        cmd[1] = "test/ffi/redstone-mock-payload.js";
        cmd[2] = vm.toString(tsMs);
        cmd[3] = string.concat(_feedStr(market), ":", vm.toString(price));
        return vm.ffi(cmd);
    }

    function _fund(address who, uint256 amt) internal {
        asset.mint(who, amt);
        vm.prank(who);
        asset.approve(address(pm), amt);
    }

    function _requestOpen(address who, bytes32 market, bool isLong, uint256 acceptablePrice)
        internal
        returns (uint256 id)
    {
        vm.prank(who);
        id = pm.requestOpen(market, isLong, COL, LEV, acceptablePrice);
    }

    function _requestClose(address who, bytes32 market, bool isLong, uint256 acceptablePrice)
        internal
        returns (uint256 id)
    {
        vm.prank(who);
        id = pm.requestClose(market, isLong, acceptablePrice);
    }

    /// @dev Execute a request with a payload stamped at the current block time.
    function _execute(address who, uint256 requestId, bytes32 market, uint256 price)
        internal
        returns (bool ok, bytes memory ret)
    {
        bytes memory payload = _payload(block.timestamp * 1000, market, price);
        bytes memory data =
            abi.encodePacked(abi.encodeWithSelector(PositionManager.executeRequest.selector, requestId), payload);
        vm.prank(who);
        (ok, ret) = address(pm).call(data);
    }

    function _sizeUsd(address who, bytes32 market, bool isLong) internal view returns (uint256 s) {
        (,,,, s,,,) = pm.positions(pm.getPositionKey(who, market, isLong));
    }

    /// @dev Drive a full two-step open of `market` for `who` (must be supported).
    function _openTwoStep(address who, bytes32 market) internal {
        _fund(who, COL + EXECUTION_FEE);
        uint256 id = _requestOpen(who, market, true, (ENTRY + 1_000) * ONE8); // acceptable above fill
        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);
        (bool ok,) = _execute(keeper, id, market, ENTRY);
        require(ok, "two-step open failed");
    }

    // =====================================================================
    // 1. BTC and ETH are seeded supported at deploy
    // =====================================================================

    function test_BtcAndEth_SupportedAtDeploy() public view {
        assertTrue(pm.supportedMarkets(BTC), "BTC seeded supported");
        assertTrue(pm.supportedMarkets(ETH), "ETH seeded supported");
        assertEq(pm.owner(), address(this), "deployer is the owner");
    }

    // =====================================================================
    // 2. Owner addMarket enables a new market: a two-step open on it fills
    // =====================================================================

    function test_AddMarket_OwnerEnablesNewMarket() public {
        assertFalse(pm.supportedMarkets(SOL), "SOL not supported before add");

        vm.expectEmit(true, false, false, false, address(pm));
        emit PositionManager.MarketAdded(SOL);
        pm.addMarket(SOL); // owner == address(this)
        assertTrue(pm.supportedMarkets(SOL), "SOL supported after add");

        // A full two-step open on SOL now succeeds (no MarketNotSupported revert).
        _openTwoStep(alice, SOL);
        assertEq(_sizeUsd(alice, SOL, true), COL * LEV, "SOL position opened after listing");
    }

    // =====================================================================
    // 3. addMarket by a non-owner reverts OwnableUnauthorizedAccount
    // =====================================================================

    function test_AddMarket_RevertWhen_NotOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pm.addMarket(SOL);
        assertFalse(pm.supportedMarkets(SOL), "SOL stays unsupported after a rejected add");
    }

    // =====================================================================
    // 4. removeMarket blocks NEW opens but an existing position still closes
    //    via the two-step flow (delisting never strands a position)
    // =====================================================================

    function test_RemoveMarket_BlocksOpensButExistingPositionCloses() public {
        // Open a BTC position while BTC is still supported.
        _openTwoStep(alice, BTC);
        assertEq(_sizeUsd(alice, BTC, true), COL * LEV, "BTC position open before delisting");

        // Delist BTC.
        vm.expectEmit(true, false, false, false, address(pm));
        emit PositionManager.MarketRemoved(BTC);
        pm.removeMarket(BTC);
        assertFalse(pm.supportedMarkets(BTC), "BTC unsupported after removal");

        // A NEW open on BTC now reverts MarketNotSupported.
        _fund(alice, COL + EXECUTION_FEE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PositionManager.MarketNotSupported.selector, BTC));
        pm.requestOpen(BTC, true, COL, LEV, (ENTRY + 1_000) * ONE8);

        // But the pre-existing BTC position still closes via the two-step flow.
        _fund(alice, EXECUTION_FEE);
        uint256 closeId = _requestClose(alice, BTC, true, ENTRY * ONE8); // acceptable below exit
        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);
        (bool ok,) = _execute(keeper, closeId, BTC, ENTRY + 6_000); // +10%, within bound
        require(ok, "two-step close of a delisted-market position failed");

        assertEq(_sizeUsd(alice, BTC, true), 0, "delisted-market position closed via two-step");
    }

    // =====================================================================
    // 5. removeMarket by a non-owner reverts OwnableUnauthorizedAccount
    // =====================================================================

    function test_RemoveMarket_RevertWhen_NotOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pm.removeMarket(BTC);
        assertTrue(pm.supportedMarkets(BTC), "BTC stays supported after a rejected removal");
    }

    // =====================================================================
    // 6. requestOpen on a never-added market reverts MarketNotSupported
    // =====================================================================

    function test_RequestOpen_RevertWhen_NeverAddedMarket() public {
        _fund(alice, COL + EXECUTION_FEE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PositionManager.MarketNotSupported.selector, SOL));
        pm.requestOpen(SOL, true, COL, LEV, ENTRY * ONE8);
    }
}
