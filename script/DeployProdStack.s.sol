// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {LiquidityPool} from "../src/LiquidityPool.sol";
import {PositionManager} from "../src/PositionManager.sol";
import {Governance} from "../src/Governance.sol";

/**
 * @title DeployProdStack
 * @notice Step 2 of the RedStone demo->production migration: redeploy the
 *         {LiquidityPool} + {PositionManager} (now on
 *         {PrimaryProdDataServiceConsumerBase}) to LitVM LiteForge (chain 4441),
 *         REUSING the already-deployed Mock USD collateral token.
 * @dev    WHY a fresh pool too: {LiquidityPool.setPositionManager} is a one-shot,
 *         irreversible link ("once linked, the engine is fixed for the life of the
 *         pool"). The existing pool is already linked to the old (demo-base)
 *         PositionManager, so the new prod-base engine cannot be wired into it.
 *         A fresh pool is therefore required to link the new engine; mUSD carries
 *         no PositionManager reference and is reused unchanged.
 *
 *         The fresh PositionManager seeds BTC + ETH as supported markets in its
 *         constructor, and every economic parameter (collateral/leverage limits,
 *         MAX_PROFIT_FACTOR, borrow/funding rates, EXECUTION_FEE, execution/cancel
 *         delays) is a `constant` baked into bytecode — so there is NO separate
 *         post-deploy config step; the contract is fully configured on deploy.
 *
 *         Run:
 *           forge script script/DeployProdStack.s.sol:DeployProdStack \
 *             --rpc-url "$LITVM_RPC_URL" --broadcast
 *
 *         TEST-ONLY (mUSD is freely mintable); never mainnet.
 */
contract DeployProdStack is Script {
    /// @dev Existing Mock USD collateral token (reused, NOT redeployed).
    address internal constant MUSD = 0x4AedaB95d41A31f891EE12d13CD77102705e2dEF;

    /// @dev Seed LP liquidity deposited into the new pool by the deployer (18 dp).
    ///      Matches the original DeployPerps seed.
    uint256 internal constant SEED_LIQUIDITY = 100_000e18;

    function run() external returns (Governance governance, LiquidityPool pool, PositionManager positionManager) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        // Reuse the existing mUSD; sanity-check it really is the expected token.
        MockERC20 musd = MockERC20(MUSD);
        require(keccak256(bytes(musd.symbol())) == keccak256(bytes("mUSD")), "unexpected mUSD");

        vm.startBroadcast(deployerKey);

        // 1. Governance first: the deployer is the initial owner (pause + param
        //    authority). Pool + engine then read it immutably.
        governance = new Governance(deployer);

        // 2. Fresh GLP-style pool over the EXISTING mUSD, reading governance.
        pool = new LiquidityPool(IERC20(MUSD), "Perps LP", "pLP", governance);

        // 3. Fresh prod-base position engine, wired to the new pool + governance.
        positionManager = new PositionManager(pool, governance);

        // 4. One-shot link: new pool trusts the new PositionManager.
        pool.setPositionManager(address(positionManager));

        // 5. Seed LP liquidity so the pool can cover payouts and pass the
        //    utilization gate on the first trade.
        musd.mint(deployer, SEED_LIQUIDITY);
        musd.approve(address(pool), SEED_LIQUIDITY);
        pool.deposit(SEED_LIQUIDITY, deployer);

        vm.stopBroadcast();

        console.log("chain id:            ", block.chainid);
        console.log("mUSD (reused):       ", MUSD);
        console.log("Governance (new):    ", address(governance));
        console.log("LiquidityPool (new): ", address(pool));
        console.log("PositionManager (new):", address(positionManager));
        console.log("seed liquidity:      ", SEED_LIQUIDITY);
    }
}
