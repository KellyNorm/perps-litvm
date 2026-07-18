# Prediction Market — Deploy Record

## Stage 1: DIA AggregatorV3 Adapters (chain 4441, LitVM LiteForge)

Deployed via `script/DeployPrediction.s.sol` (`deployAdapters` signature).
Artifact: `broadcast/DeployPrediction.s.sol/4441/deployAdapters-latest.json`
(named per-sig, not `run-latest.json`).

- **Adapter contract:** `DIAAggregatorV3Adapter`
- **Underlying DIA oracle (immutable, all 11):** `0x49c39225Dbc64700936bb641d1E81113DbadD2DF`
- **Decimals (all 11):** `18`
- **Count:** 11 adapters (confirmed).

### Key → adapter map (transaction order)

| # | DIA Key   | Adapter Address                              | Verified Price (1e18) | decimals | oracle OK | symbol OK |
|---|-----------|----------------------------------------------|-----------------------|----------|-----------|-----------|
| 1 | BTC/USD   | `0x7a75890ad9a2ecef4a3b64b62b4050d583fc1aee` | ~$63,935              | 18       | ✅        | ✅        |
| 2 | ETH/USD   | `0xd16526c879c7fc8caec6a45112c513e7012fbe71` | ~$1,842               | 18       | ✅        | ✅        |
| 3 | BNB/USD   | `0xd1632391626ab78d098a795d80ef5431426aadce` | ~$566.59              | 18       | ✅        | ✅        |
| 4 | XRP/USD   | `0x30c0b874aa4deefbb15f12eb650947ef5a4d51fb` | ~$1.088               | 18       | ✅        | ✅        |
| 5 | SOL/USD   | `0x3ab5383fb5be15c362b474a91ab3afed18450f2c` | ~$75.21               | 18       | ✅        | ✅        |
| 6 | TRX/USD   | `0xbda584811c879ed6f7466dbd2c47b4b85d644338` | ~$0.3226              | 18       | ✅        | ✅        |
| 7 | HYPE/USD  | `0x914fceaf39b2c0f083431ebf16a1e9310a94259d` | ~$59.73               | 18       | ✅        | ✅        |
| 8 | DOGE/USD  | `0x7129116eb54d511cfe99d4fc296e008afc617a5c` | ~$0.0726              | 18       | ✅        | ✅        |
| 9 | RAIN/USD  | `0xd943d73f213f4248df2491343e05c7e143ab44df` | ~$0.014097            | 18       | ✅        | ✅        |
| 10| ZEC/USD   | `0x70dbb5eabd852504d40c82b68cc5908658af3080` | ~$548.22              | 18       | ✅        | ✅        |
| 11| LTC/USD   | `0x23ac0fe0a76e324cadc66fcbd81df7b294375fd3` | ~$45.44               | 18       | ✅        | ✅        |

### Verification method

Each adapter was checked on-chain via `cast` (RPC retried — degraded endpoint):
- `latestRoundData()` → live, sane 18-dec price with a recent `updatedAt`.
- `decimals()` == `18`.
- `oracle()` == `0x49c39225Dbc64700936bb641d1E81113DbadD2DF` (all 11).
- `symbol()` == intended DIA key (no adapter constructed with the wrong string).

Canaries:
- **RAIN** (scaling canary, sub-cent): reads ~$0.0141 — scaling correct, not off by orders of magnitude.
- **ZEC** (mis-keying canary): keyed `ZEC/USD` (Zcash, ~$548), **not** `ZCASH/USD` — correct.

> Note: DIA feed cadence on LitVM updates every ~6–29 min (not ~1 min); a tight
> `MAX_STALENESS` breaks the market. See [dia-cadence-diagnostic.md](dia-cadence-diagnostic.md).

## Stage 2: PredictionMarketFactory + wire assets (chain 4441)

Deployed via `deployFactoryAndWire(address[])` (adapters passed in Stage 1 tx order).
Artifact: `broadcast/DeployPrediction.s.sol/4441/deployFactoryAndWire-latest.json`

- **Factory (`PredictionMarketFactory`):** `0x6338985C7f689C3e1959bfe1a8bb36E44849EA40`
- **Collateral (mUSD, reused):** `0x4AedaB95d41A31f891EE12d13CD77102705e2dEF` (`symbol()=="mUSD"`)
- **Treasury:** `0xE9Dd9bFf0ad5254673daaA77397e84Fec2312292` (= deployer, testnet)
- **Owner:** `0xE9Dd9bFf0ad5254673daaA77397e84Fec2312292` (= deployer)
- **feeBps:** `0` (fair 50/50, testnet)
- **maxStaleness:** `300` s
- **assetCount:** `11` (confirmed on-chain)

### Asset registry (on-chain `assets(assetId)` — verified)

| assetId | display | feed (adapter)                               | feedDecimals | displayDp | enabled |
|---------|---------|----------------------------------------------|--------------|-----------|---------|
| 0  | BTC   | `0x7a75890ad9a2ecef4a3b64b62b4050d583fc1aee` | 18 | 2 | true |
| 1  | ETH   | `0xd16526c879c7fc8caec6a45112c513e7012fbe71` | 18 | 2 | true |
| 2  | BNB   | `0xd1632391626ab78d098a795d80ef5431426aadce` | 18 | 2 | true |
| 3  | XRP   | `0x30c0b874aa4deefbb15f12eb650947ef5a4d51fb` | 18 | 4 | true |
| 4  | SOL   | `0x3ab5383fb5be15c362b474a91ab3afed18450f2c` | 18 | 2 | true |
| 5  | TRX   | `0xbda584811c879ed6f7466dbd2c47b4b85d644338` | 18 | 5 | true |
| 6  | HYPE  | `0x914fceaf39b2c0f083431ebf16a1e9310a94259d` | 18 | 2 | true |
| 7  | DOGE  | `0x7129116eb54d511cfe99d4fc296e008afc617a5c` | 18 | 5 | true |
| 8  | RAIN  | `0xd943d73f213f4248df2491343e05c7e143ab44df` | 18 | 6 | true |
| 9  | ZCASH | `0x70dbb5eabd852504d40c82b68cc5908658af3080` | 18 | 2 | true |
| 10 | LTC   | `0x23ac0fe0a76e324cadc66fcbd81df7b294375fd3` | 18 | 2 | true |

> assetId 9's **display symbol is `ZCASH`** while its adapter queries DIA key
> **`ZEC/USD`** — intentional (display label ≠ oracle key).

`addAsset` reads only `decimals()`; it does **not** enforce staleness, so wiring
cannot revert on DIA cadence. Feed-freshness gating lives in market *creation*
(`replenish`/`_select` → `SafeAggregatorReader`), not in Stage 2.
`previewSelect()` returned `found=true` post-deploy → ≥1 feed healthy, a market is
creatable now.

### Not done here (later stages)
- Keeper / `replenish` automation is **Stage 5b** — not set up in this deploy.
- Ownership currently = deployer (required for in-script `addAsset`); transfer to a
  governance owner later if desired.
