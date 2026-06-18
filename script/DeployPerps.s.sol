// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {LiquidityPool} from "../src/LiquidityPool.sol";
import {PositionManager} from "../src/PositionManager.sol";

/**
 * @title DeployPerps
 * @notice Deploys the full PR-3 perps stack to LitVM LiteForge (chain 4441):
 *         the test collateral token (Mock USD), the GLP-style {LiquidityPool},
 *         and the {PositionManager}, then links them and seeds the pool with
 *         starting LP liquidity so it can cover payouts and pass the utilization
 *         gate on the first trade.
 * @dev    The RPC URL is supplied on the command line via `--rpc-url`; the
 *         deployer key is read from the environment (`DEPLOYER_PRIVATE_KEY` —
 *         testnet key only; see the gitignored .env). Run with:
 *
 *           forge script script/DeployPerps.s.sol:DeployPerps \
 *             --rpc-url "$LITVM_RPC_URL" --broadcast
 *
 *         The Mock USD token is freely mintable and TEST-ONLY (see MockERC20);
 *         this script is for the testnet smoke deploy, never mainnet.
 */
contract DeployPerps is Script {
    /// @dev Seed LP liquidity deposited into the pool by the deployer (18 dp).
    uint256 internal constant SEED_LIQUIDITY = 100_000e18;

    function run() external returns (MockERC20 musd, LiquidityPool pool, PositionManager positionManager) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        // 1. Collateral asset: Mock USD, 18 decimals (OZ ERC20 default).
        musd = new MockERC20("Mock USD", "mUSD");

        // 2. GLP-style liquidity pool over mUSD.
        pool = new LiquidityPool(musd, "Perps LP", "pLP");

        // 3. Position engine, wired to the pool.
        positionManager = new PositionManager(pool);

        // 4. One-shot link: pool trusts this PositionManager.
        pool.setPositionManager(address(positionManager));

        // 5. Seed LP liquidity: mint mUSD to the deployer and deposit it so the
        //    pool can cover trader payouts and satisfy the utilization gate.
        musd.mint(deployer, SEED_LIQUIDITY);
        musd.approve(address(pool), SEED_LIQUIDITY);
        pool.deposit(SEED_LIQUIDITY, deployer);

        vm.stopBroadcast();

        console.log("chain id:        ", block.chainid);
        console.log("MockERC20 (mUSD):", address(musd));
        console.log("LiquidityPool:   ", address(pool));
        console.log("PositionManager: ", address(positionManager));
        console.log("seed liquidity:  ", SEED_LIQUIDITY);
    }
}
