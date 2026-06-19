// Central config, read from Vite's import.meta.env (VITE_-prefixed only).
// No secrets here — addresses + RPC + the RedStone service id are all public.

const env = import.meta.env;

export const RPC_URL = env.VITE_RPC_URL || "https://liteforge.rpc.caldera.xyz/http";
export const CHAIN_ID = Number(env.VITE_CHAIN_ID || 4441);

export const ADDRESSES = {
  musd: (env.VITE_MUSD_ADDRESS || "").trim(),
  pool: (env.VITE_LIQUIDITY_POOL_ADDRESS || "").trim(),
  positionManager: (env.VITE_POSITION_MANAGER_ADDRESS || "").trim(),
};

export const REDSTONE_DATA_SERVICE = env.VITE_REDSTONE_DATA_SERVICE || "redstone-main-demo";

// RedStone redstone-main-demo single demo signer (same as scripts/smoke-perps.mjs).
export const REDSTONE_DEMO_SIGNER = "0x0C39486f770B26F5527BBBf942726537986Cd7eb";

// LiteForge chain params for wallet_addEthereumChain.
export const LITEFORGE_CHAIN = {
  chainId: "0x" + CHAIN_ID.toString(16),
  chainName: "LitVM LiteForge",
  nativeCurrency: { name: "zkLTC", symbol: "zkLTC", decimals: 18 },
  rpcUrls: [RPC_URL],
  blockExplorerUrls: ["https://liteforge.explorer.caldera.xyz"],
};

export const LITEFORGE_FAUCET_URL = "https://liteforge.hub.caldera.xyz";

// Candidate markets to probe. Only those returning supportedMarkets==true are shown.
// The market KEY is bytes32(symbol) — exactly how PositionManager.sol encodes
// MARKET_BTC = bytes32("BTC") (see lib/marketKey.js). RedStone feed id == symbol.
export const CANDIDATE_MARKETS = [
  { symbol: "BTC", name: "BTC-PERP", full: "Bitcoin", ico: "₿", bg: "linear-gradient(135deg,#F7931A,#FFB347)", fg: "#0A0D12" },
  { symbol: "ETH", name: "ETH-PERP", full: "Ethereum", ico: "Ξ", bg: "linear-gradient(135deg,#6F7CE0,#A6B0F5)", fg: "#fff" },
  { symbol: "SOL", name: "SOL-PERP", full: "Solana", ico: "◎", bg: "linear-gradient(135deg,#9945FF,#19FB9B)", fg: "#fff" },
  { symbol: "LTC", name: "LTC-PERP", full: "Litecoin", ico: "Ł", bg: "linear-gradient(135deg,#A6A9AA,#4C82D8)", fg: "#0A0D12" },
];

export function addressesConfigured() {
  return Boolean(ADDRESSES.musd && ADDRESSES.pool && ADDRESSES.positionManager);
}
