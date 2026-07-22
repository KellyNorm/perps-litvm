// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {IDIAOracle} from "../src/prediction/IDIAOracle.sol";
import {IAggregatorV3} from "../src/prediction/IAggregatorV3.sol";
import {DIAAggregatorV3Adapter} from "../src/prediction/DIAAggregatorV3Adapter.sol";
import {PredictionMarketFactory} from "../src/prediction/PredictionMarketFactory.sol";

/**
 * @title DeployPrediction
 * @notice Staged deploy for the parimutuel prediction market on LitVM LiteForge
 *         (chain 4441). EVERY external input is a named constant in the CONFIG and
 *         ASSET TABLE blocks below — change them there, not in the logic.
 *
 *         STAGED — nothing runs by accident (there is no `run()`); each stage is an
 *         explicit `--sig`:
 *           Stage 1 (adapters only):
 *             forge script script/DeployPrediction.s.sol:DeployPrediction \
 *               --sig "deployAdapters()" --rpc-url "$LITVM_RPC_URL" --broadcast
 *           Stage 2 (factory + wire assets — reviewed separately, LATER):
 *             forge script script/DeployPrediction.s.sol:DeployPrediction \
 *               --sig "deployFactoryAndWire(address[])" "[0xADAPTER1,0xADAPTER2,...]" \
 *               --rpc-url "$LITVM_RPC_URL" --broadcast
 *
 *         Needs env `DEPLOYER_PRIVATE_KEY` for broadcasting (never committed).
 *         TEST-ONLY (reuses freely-mintable mUSD); never mainnet.
 *
 * @dev The adapter is fail-safe: it reshapes DIA `getValue(key)` into IAggregatorV3
 *      without manufacturing a price. Deploying an adapter for a key that is not yet
 *      live is harmless — but the factory cannot open a market on a dead key
 *      (`FeedUnhealthyAtCreation`), so verify each key is live before Stage 2.
 */
contract DeployPrediction is Script {
    // =========================================================================
    // CONFIG — the only place to edit addresses / params
    // =========================================================================

    /// Live DIA push oracle on chain 4441 (verified in docs/dia-cadence-diagnostic.md).
    /// STAGE 1 needs ONLY this + the ASSET TABLE below.
    IDIAOracle internal constant DIA_ORACLE = IDIAOracle(0x49c39225Dbc64700936bb641d1E81113DbadD2DF);

    // ---- Stage 2 (factory) params — NOT used by Stage 1 ----
    /// Reuse the existing testnet mUSD collateral (also used by the perps stack).
    address internal constant MUSD = 0x4AedaB95d41A31f891EE12d13CD77102705e2dEF;
    /// Fee / dust sink (segregated — never the perps LP). MUST be set before Stage 2.
    address internal constant TREASURY = 0xE9Dd9bFf0ad5254673daaA77397e84Fec2312292; // deployer (testnet)
    /// Governance owner. MUST equal the deployer for in-script wiring (addAsset is
    /// onlyOwner); transfer ownership afterwards if a different owner is desired.
    address internal constant OWNER = 0xE9Dd9bFf0ad5254673daaA77397e84Fec2312292; // = deployer
    /// Protocol fee in bps (design default: fair 50/50 = 0). Capped at 300 by the factory.
    uint256 internal constant FEE_BPS = 0;
    /// Oracle staleness window (seconds). Shipped default 300s — sized above the DIA
    /// heartbeat floor (docs/dia-cadence-diagnostic.md). Governance-settable post-deploy.
    uint256 internal constant MAX_STALENESS = 300;

    // =========================================================================
    // ASSET TABLE — one row per prediction asset (edit / trim here)
    //   key     = the DIA getValue() key the adapter queries (e.g. "BTC/USD")
    //   display = factory/UI label (e.g. "BTC")   [Asset.symbol]
    //   dp      = UI display precision only (does NOT affect money)
    //
    // NOTE: "ZCASH"'s LIVE DIA key is "ZEC/USD" (NOT "ZCASH/USD").
    // All 11 keys verified returning a live 18-dec price with recent timestamps
    // (BTC/ETH/LTC/SOL/ZEC/RAIN + XRP earlier; BNB/TRX/HYPE/DOGE on 2026-07-18).
    // The design doc lists 11 assets; trim rows here to reach the intended set.
    // =========================================================================
    function _assets() internal pure returns (string[] memory key, string[] memory display, uint8[] memory dp) {
        uint256 n = 11;
        key = new string[](n);
        display = new string[](n);
        dp = new uint8[](n);

        key[0] = "BTC/USD"; // verified live
        display[0] = "BTC";
        dp[0] = 2; // cents
        key[1] = "ETH/USD"; // verified live
        display[1] = "ETH";
        dp[1] = 2;
        key[2] = "BNB/USD"; // verified live (~$566)
        display[2] = "BNB";
        dp[2] = 2;
        key[3] = "XRP/USD"; // verified live (07-08)
        display[3] = "XRP";
        dp[3] = 4;
        key[4] = "SOL/USD"; // verified live
        display[4] = "SOL";
        dp[4] = 2;
        key[5] = "TRX/USD"; // verified live (~$0.32)
        display[5] = "TRX";
        dp[5] = 5;
        key[6] = "HYPE/USD"; // verified live (~$60)
        display[6] = "HYPE";
        dp[6] = 2; // cents
        key[7] = "DOGE/USD"; // verified live (~$0.07)
        display[7] = "DOGE";
        dp[7] = 5;
        key[8] = "RAIN/USD"; // verified live
        display[8] = "RAIN";
        dp[8] = 6;
        key[9] = "ZEC/USD"; // verified live (display "ZCASH")
        display[9] = "ZCASH";
        dp[9] = 2;
        key[10] = "LTC/USD"; // verified live
        display[10] = "LTC";
        dp[10] = 2;
    }

    // =========================================================================
    // STAGE 1 — deploy one DIAAggregatorV3Adapter per asset (adapters only)
    // =========================================================================
    function deployAdapters() external returns (address[] memory adapters) {
        require(address(DIA_ORACLE) != address(0), "DIA_ORACLE unset");
        (string[] memory key,,) = _assets();

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        console.log("=== Stage 1: adapters ===");
        console.log("chain id:  ", block.chainid);
        console.log("DIA oracle:", address(DIA_ORACLE));
        console.log("assets:    ", key.length);

        adapters = new address[](key.length);
        vm.startBroadcast(deployerKey);
        for (uint256 i; i < key.length; i++) {
            DIAAggregatorV3Adapter a = new DIAAggregatorV3Adapter(DIA_ORACLE, key[i]);
            adapters[i] = address(a);
            console.log(key[i], address(a));
        }
        vm.stopBroadcast();

        console.log("Stage 1 done. Pass these addresses (same order) to Stage 2's deployFactoryAndWire.");
    }

    // =========================================================================
    // STAGE 2 — deploy the factory + wire each asset to its adapter (LATER)
    //   `adapters` MUST be the Stage 1 output, in the SAME order as _assets().
    // =========================================================================
    function deployFactoryAndWire(address[] calldata adapters) external returns (PredictionMarketFactory factory) {
        require(TREASURY != address(0), "TREASURY unset");
        require(OWNER != address(0), "OWNER unset");

        (string[] memory key, string[] memory display, uint8[] memory dp) = _assets();
        require(adapters.length == key.length, "adapters length != assets");

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        require(OWNER == vm.addr(deployerKey), "OWNER must be the deployer for in-script wiring (transfer later)");

        // Sanity: mUSD really is the expected token (mirrors DeployProdStack).
        require(keccak256(bytes(MockERC20(MUSD).symbol())) == keccak256(bytes("mUSD")), "unexpected mUSD");

        vm.startBroadcast(deployerKey);
        factory = new PredictionMarketFactory(IERC20(MUSD), TREASURY, FEE_BPS, OWNER, MAX_STALENESS);
        for (uint256 i; i < adapters.length; i++) {
            require(adapters[i] != address(0), "adapter unset");
            factory.addAsset(display[i], IAggregatorV3(adapters[i]), dp[i]);
        }
        vm.stopBroadcast();

        console.log("=== Stage 2: factory ===");
        console.log("factory:      ", address(factory));
        console.log("mUSD:         ", MUSD);
        console.log("treasury:     ", TREASURY);
        console.log("owner:        ", OWNER);
        console.log("feeBps:       ", FEE_BPS);
        console.log("maxStaleness: ", MAX_STALENESS);
        console.log("assets wired: ", adapters.length);
    }
}
