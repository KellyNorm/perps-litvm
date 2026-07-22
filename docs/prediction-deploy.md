# Prediction market — deploy record (chain 4441, LiteForge)

Durable record of the deployed parimutuel prediction factory + adapters. **No secrets
in this file** — the deployer key lives only in `.env` (gitignored).

Deploy script: `script/DeployPrediction.s.sol` (staged: `deployAdapters()` then
`deployFactoryAndWire(address[])`). All config is in that script's CONFIG block.

## ✅ 8h-window factory redeployed (2026-07-22)

`0x7dd9e01fD4f96F9b1F875351eaccb5cA6C84c512` — the current, live factory.

Deployed from `feat/prediction-8h-window` (contract restored at `620767f`, 8h change on
top, 412/412 forge tests green). Verified on-chain: deployed runtime bytecode == the local
8h artifact (only the `musd` immutable differs) and ≠ the old 24h factory's code.

### What changed vs the previous factory: the 8h window

`_windows(TF_8H)` in `PredictionMarketFactory.sol` (was `TF_24H`):

| | betWindow | settleWindow | total life | strike staleness |
|---|---|---|---|---|
| old (24h) | 84,600s (23.5h) | 1,800s (30m) | 86,400s (24h) | up to 23.5h |
| **new (8h)** | **27,000s (7.5h)** | **1,800s (30m)** | **28,800s (8h)** | **up to 7.5h** |

Motivation: live 24h markets averaged ~1.0% strike drift (max 2.70%) with betting still
open, because the strike is set at `t0` and the window was 23.5h. Shortening to 7.5h
betting cuts that. `label == total life` is preserved across all four frames
(15m/30m/1h/**8h**). Settlement window is UNCHANGED at 1,800s, so the 60% TWAP coverage
gate still clears comfortably (~10-12x at 300s staleness). `tExpiry = tLock + settleWindow`
still holds — no lock→settlement gap; `observe()`/`settle()` untouched.

### Config (identical to the previous deploy)

| param | value |
|---|---|
| mUSD collateral | `0x4AedaB95d41A31f891EE12d13CD77102705e2dEF` (shared with perps) |
| treasury | `0xE9Dd9bFf0ad5254673daaA77397e84Fec2312292` (deployer, testnet) |
| owner | `0xE9Dd9bFf0ad5254673daaA77397e84Fec2312292` (= deployer) |
| feeBps | `0` (fair 50/50) |
| maxStaleness | `300` seconds |
| DIA oracle | `0x49c39225Dbc64700936bb641d1E81113DbadD2DF` |

### Adapters — REUSED as-is (not redeployed)

The 11 `DIAAggregatorV3Adapter`s from the prior deploy were wired into the new factory
unchanged (each verified `oracle() == DIA oracle` above). Order matches `_assets()`:

| idx | symbol | dp | adapter (feed) |
|---|---|---|---|
| 0 | BTC | 2 | `0x7a75890Ad9a2ECef4a3B64B62B4050D583Fc1aEe` |
| 1 | ETH | 2 | `0xD16526c879C7fC8cAeC6A45112C513e7012fBE71` |
| 2 | BNB | 2 | `0xD1632391626Ab78d098A795d80EF5431426AaDcE` |
| 3 | XRP | 4 | `0x30C0B874Aa4deeFbb15f12eB650947eF5A4D51Fb` |
| 4 | SOL | 2 | `0x3Ab5383Fb5BE15c362b474a91aB3afEd18450f2c` |
| 5 | TRX | 5 | `0xbDa584811C879Ed6f7466Dbd2C47B4B85D644338` |
| 6 | HYPE | 2 | `0x914FceAF39B2C0F083431eBF16a1E9310a94259d` |
| 7 | DOGE | 5 | `0x7129116Eb54d511Cfe99D4FC296e008aFC617A5c` |
| 8 | RAIN | 6 | `0xd943D73F213f4248df2491343e05C7E143aB44Df` |
| 9 | ZCASH | 2 | `0x70dBB5Eabd852504d40c82B68Cc5908658AF3080` |
| 10 | LTC | 2 | `0x23aC0FE0A76e324CAdC66FcBD81DF7b294375fd3` |

(ZCASH's live DIA key is `ZEC/USD`, not `ZCASH/USD`.)

### How it was deployed (split & verify, degraded RPC)

1. `forge create PredictionMarketFactory` with the 5 constructor args — one CREATE tx,
   address precomputed from the deployer nonce so the landing was verifiable even on an
   RPC timeout. **Note:** `--constructor-args` is variadic — put it LAST or it swallows
   `--rpc-url`/`--private-key`.
2. `cast send addAsset(string,address,uint8)` ×11, checking `assetCount` before each
   (resumable, never a blind re-send) and verifying the row after each.

Deployer nonce 502 → 514 (1 deploy + 11 addAsset), ~0.0000428 zkLTC total at 0.01 gwei.

## Old factory `0x6338985C7f689C3e1959bfe1a8bb36E44849EA40` — DRAINING

Left untouched (immutable — cannot be upgraded). Its live markets were all **empty-book**
(0/0 pools), so they VOID with **no funds stranded**; nothing to migrate. It keeps its
23.5h windows until its markets expire. Once the keeper is repointed at the new factory it
stops settling old-factory markets — safe here precisely because they carry no stake.

## Cutover checklist (do the last two together)

- [ ] Keeper (Railway): `PREDICTION_FACTORY_ADDRESS` → `0x7dd9e01fD4f96F9b1F875351eaccb5cA6C84c512`,
      redeploy. Its loop `replenish()`s the new board and observes/settles — no manual seeding.
- [ ] Frontend: `VITE_PREDICTION_FACTORY_ADDRESS` → the new address **together with** the
      `24-hour → 8-hour` `TIMEFRAME_LABEL[3]` relabel (branch `chore/prediction-8h-label-redeploy`),
      so live index-3 markets are never mislabeled.
