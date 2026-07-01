<div align="center">

# TachyonFi

### High-Speed Perpetuals on LitVM

A decentralized perpetual-futures exchange where traders take leveraged BTC and ETH positions against a single shared mUSD liquidity pool — filled around the clock by an automated keeper at fresh oracle prices.

[**Trade →**](https://app.tachyonfi.xyz) · [**Site →**](https://tachyonfi.xyz) · [**X →**](https://x.com/_tachyonfi)

`Live on LitVM Testnet` · `Unaudited` · `In active development`

</div>

---

> [!WARNING]
> **This is an unaudited testnet release.** TachyonFi runs on the LitVM testnet using test **mUSD** claimed from a faucet. Nothing here has real monetary value, no code has been audited, and this is not production-ready. It is published for testing and feedback only. Do not treat it as financial advice or a secure, mainnet-ready system.

## Overview

TachyonFi is a GMX-style, single-collateral perpetuals DEX. Every market is backed by **one shared mUSD vault**, so liquidity stays deep and unified and liquidity providers earn from all trading activity rather than a single isolated pair. Orders use a two-step request-and-execute flow with front-running protection, and an off-chain **keeper** fills them 24/7 at fresh oracle prices. An on-chain **circuit-breaker** cross-checks a secondary price feed and halts new risk when prices diverge abnormally, protecting the pool from oracle manipulation and bad debt during fast moves.

Built native to LitVM — the Litecoin-aligned EVM chain (Arbitrum Nitro / Caldera stack) — trades settle quickly with sub-cent gas.

## Product suite

TachyonFi is a two-product trading hub, both housed in the same app at `app.tachyonfi.xyz`:

| Product | Status | Description |
| --- | --- | --- |
| **Perps** | **Live (testnet)** | Leveraged long/short on BTC & ETH vs. a shared mUSD pool. |
| **Predictions** | Coming soon | Fast, simple crypto up/down price markets — no leverage, short windows, beginner-friendly. |

## Live deployment

| Surface | URL |
| --- | --- |
| Trading dApp | https://app.tachyonfi.xyz |
| Marketing site | https://tachyonfi.xyz |
| Social | https://x.com/_tachyonfi |

## How it works

1. **Connect** a wallet — the app prompts you to switch to LitVM.
2. **Claim** test mUSD from the built-in faucet (no real funds needed).
3. **Trade** — open a long or short on BTC/ETH with leverage. The keeper fills your request at the current oracle price.

Under the hood:

- **Request / execute:** placing a position emits a request; the keeper executes it in a separate transaction at a fresh price, which removes the ability to front-run the mark.
- **Keeper:** a standalone service (dedicated key, separate from the deployer) watches for requests and fills them continuously, hosted independently so it runs unattended.
- **Pricing & safety:** a **RedStone** feed is the primary oracle, cross-checked against a **DIA** secondary. If the two diverge beyond a bound, the circuit-breaker trips — halting new risk while allowing liquidations to continue in observe-only mode.

## Architecture

```
                         ┌─────────────────────────┐
   tachyonfi.xyz  ─────▶ │  landing/  (static site)│
                         └─────────────────────────┘

                         ┌─────────────────────────┐
app.tachyonfi.xyz ─────▶ │  frontend/ (React/Vite) │
                         └───────────┬─────────────┘
                                     │ RPC (chain 4441)
                         ┌───────────▼─────────────┐
                         │  Contracts (Foundry)    │
                         │  PositionManager        │
                         │  LiquidityPool (mUSD)    │◀── circuit-breaker
                         │  mUSD / Governance       │      (RedStone + DIA)
                         └───────────▲─────────────┘
                                     │ request / execute
                         ┌───────────┴─────────────┐
                         │  keeper/ (24/7 filler)   │
                         └─────────────────────────┘
```

## Repository layout

This is a monorepo. Each part deploys independently.

| Path | What it is |
| --- | --- |
| `src/` | Core Solidity contracts (PositionManager, LiquidityPool, mUSD, governance, oracle logic). |
| `test/` | Foundry tests. |
| `script/` | Foundry deployment / operations scripts. |
| `lib/` | Foundry dependencies (git submodules). |
| `keeper/` | Off-chain keeper service that fills orders 24/7. |
| `frontend/` | The trading dApp (React + Vite) → `app.tachyonfi.xyz`. |
| `landing/` | Static marketing site (React + Vite) → `tachyonfi.xyz`. |
| `docs/` | Design notes, oracle calibration, deployment records. |
| `foundry.toml` | Foundry configuration. |

> The `frontend/`, `landing/`, and `keeper/` folders are self-contained and do not depend on one another.

## Network

| | |
| --- | --- |
| Chain | LitVM Testnet |
| Chain ID | `4441` |
| Gas token | zkLTC |
| Stack | Arbitrum Nitro (Caldera) |
| RPC | `https://liteforge.rpc.caldera.xyz/infra-partner-http` |

## Contracts (LitVM testnet)

| Contract | Address |
| --- | --- |
| PositionManager | `0x9396d36f713302ff39e0ba5b38012656f8e4eacf` |
| LiquidityPool | `0x4716a0c9c504f83918002a3086590f1ed192560b` |
| mUSD | `0x4aedab95d41a31f891ee12d13cd77102705e2def` |

Additional deployed addresses (governance, oracle adapters) are recorded under `docs/` and the `broadcast/` deployment artifacts.

## Getting started

### Prerequisites

- [Foundry](https://book.getfoundry.sh/) (`forge`, `cast`) for contracts
- [Node.js](https://nodejs.org/) LTS + npm for the frontend, landing, and keeper

### Contracts

```bash
# install submodule dependencies
forge install

# build
forge build

# run the test suite
forge test
```

### Frontend (trading dApp)

```bash
cd frontend
npm install
npm run dev
```

### Landing site

```bash
cd landing
npm install
npm run dev
```

### Keeper

```bash
cd keeper
npm install
# copy the example env and fill in the RPC + keeper key
cp .env.example .env
npm start
```

> The keeper uses its own dedicated signing key, separate from the deployer. Never commit real keys — keep them in `.env` (gitignored).

## Security model

- **Oracle circuit-breaker:** RedStone (primary) is validated against DIA (secondary). Abnormal divergence trips the breaker, halting new risk while liquidations continue in observe-only mode.
- **Front-running protection:** the two-step request/execute flow prevents users from acting on a price they can see before it is committed.
- **Separation of duties:** the keeper key is isolated from the deployer/governance keys.

These measures reduce risk but **do not** make the system audited or safe for real value. It is a testnet product.

## Roadmap

- **Phase 2** — position editing / partial close, limit & stop orders, a market registry for more assets (LTC next), an mUSD faucet, and the **Predictions** product (fast crypto up/down markets in the same app).
- **Phase 3 (mainnet hardening)** — governance/pause controls, per-market exposure caps, oracle fallback/circuit-breaker upgrades, trading fees, a hardened keeper bot, event indexing, invariant/fuzz testing, and a third-party audit.

## Contributing & feedback

Found a bug or have feedback? Reach out on X: [@_tachyonfi](https://x.com/_tachyonfi).

## License

See [`LICENSE`](./LICENSE).

---

<div align="center">

**Testnet · Unaudited** — test mUSD only, nothing here has real value.

</div>
