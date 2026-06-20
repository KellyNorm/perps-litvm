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

export const REDSTONE_DATA_SERVICE = env.VITE_REDSTONE_DATA_SERVICE || "redstone-primary-prod";

// Production RedStone signer set (redstone-primary-prod) — mirrors the on-chain
// authorised set in PrimaryProdDataServiceConsumerBase (same as
// scripts/smoke-perps.mjs). The contract requires 3 unique signers.
export const REDSTONE_PROD_SIGNERS = [
  "0x8BB8F32Df04c8b654987DAaeD53D6B6091e3B774",
  "0xdEB22f54738d54976C4c0fe5ce6d408E40d88499",
  "0x51Ce04Be4b3E32572C4Ec9135221d0691Ba7d202",
  "0xDD682daEC5A90dD295d14DA4b0bec9281017b5bE",
  "0x9c5AE89C4Af6aA32cE58588DBaF90d18a855B6de",
];
export const REDSTONE_UNIQUE_SIGNERS = 3;

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
