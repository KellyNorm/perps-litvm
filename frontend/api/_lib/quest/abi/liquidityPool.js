// LiquidityPool ABI fragments — PORTED, NOT IMPORTED.
//
// PROVENANCE: hand-copied from `frontend/src/abi/LiquidityPool.json` (the forge artifact
// for the ERC-4626 vault), reduced to the two members the quest checks need. Verified
// field-for-field against that artifact on 2026-07-25.
//
// See the porting note in ./positionManager.js for why api/ keeps its own copies.
// IF THE POOL IS REDEPLOYED WITH A CHANGED SIGNATURE, UPDATE BOTH FILES.
export const LIQUIDITY_POOL_ABI = [
  // Share balance. NON-ZERO IS PROOF OF NOTHING BUT CUSTODY: shares are transferable
  // ERC-20, so a balance could have been received rather than minted by a deposit. That
  // hole is accepted deliberately for the Tier 1 fast positive — the honest proof of
  // "provided liquidity" is the Deposit event below, which names the depositor.
  "function balanceOf(address account) view returns (uint256)",
  // ERC-4626 Deposit. `sender` paid the assets, `owner` received the shares — both are
  // indexed, so either can be filtered on. The quest credits the DEPOSITOR (sender).
  "event Deposit(address indexed sender,address indexed owner,uint256 assets,uint256 shares)",
];
