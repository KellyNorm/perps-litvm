# Keeper service

A standalone Node service that fills two-step trades on the perps stack (LitVM,
chain 4441). Traders sign only the **request** (a plain `request*` call, no
payload); this keeper watches `PositionManager`, attaches a fresh signed RedStone
price, and calls **`executeRequest`** — earning the `0.5 mUSD` execution fee per
fill. No Solidity changes.

It reuses the proven Node helpers from `scripts/smoke-perps.mjs` — the RedStone
payload wrap, the payload-freshness check, and the Nitro revert-decoder — factored
into [`lib/`](./lib).

## Safety

The keeper calls **exactly one** state-changing function: `executeRequest`. It
never calls `cancelRequest`, never moves funds, and runs its **own dedicated
account** (not the deployer).

## How it works

- **Discovery.** Maintains the active request-id set. On startup it walks the id
  counter and reconciles each id against `requests(id).active`, so a restart
  rebuilds the exact live set from chain state (idempotent). It then stays live on
  the `*Requested` events (add) and `RequestExecuted` / `RequestCancelled`
  (remove); every event handler re-reads chain state through the same
  `reconcile()`, and a per-loop counter catch-up backstops any missed log.
- **Execution** (a request is a TRIGGER iff `triggers(id).triggerPrice != 0`):
  - **Market** (open/close/increase/decrease): once
    `now >= requestTimestamp + MIN_EXECUTION_DELAY` and a payload stamped past
    that floor exists, it sends `executeRequest`. The contract fills or
    auto-cancels on slippage; the keeper records the receipt's outcome.
  - **Trigger** (resting): each loop it **static-probes** fillability
    (`provider.call` via the revert-decoder) and sends the real `executeRequest`
    **only** when the probe would succeed. Never blind-sends.
- **Robustness.** Sequential nonce + in-flight id tracking (an id is never
  double-submitted); a real-tx `TriggerNotMet`/`SlippageNotMet` (price moved back)
  is treated as still-resting and retried; a lost race (`RequestNotActive`) is
  caught gracefully; transient RPC/payload errors back off. Structured per-id logs
  (`discovered` / `waiting-delay` / `waiting-payload` / `not-met` / `executing` /
  `filled` / `cancelled` / `removed` / `errored`) plus a heartbeat (active count,
  keeper zkLTC balance, mUSD fees earned).

## Setup

```bash
cd keeper
cp .env.example .env        # then edit: set KEEPER_PRIVATE_KEY to a dedicated, zkLTC-funded account
node keeper.mjs             # node >= 20 (reads ../out for the ABI; run forge build first if out/ is missing)
```

The ABI is pulled from the Foundry build output (`../out`). Dependencies resolve
from the repo root `node_modules` (ethers v5 + the RedStone SDK), so no separate
install is needed when run inside the repo.

## Demo: let the keeper fill a request

Create a request **without** executing it, then run the keeper and watch it fill:

```bash
# from the project root, with .env loaded (set -a; source .env; set +a)
node keeper/scripts/create-request.mjs            # queues a market open long, prints the requestId
node keeper/scripts/create-request.mjs trigger    # queues a resting trigger-open (stays resting)

# in another shell, run the keeper:
node keeper/keeper.mjs
```

You'll see the keeper log `discovered` → `waiting-payload` → `executing` →
`filled (+0.5 mUSD fee)` for the market request, and `discovered` →
`not-met (TriggerNotMet…)` (still resting) for the trigger request.
