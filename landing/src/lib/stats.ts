// Read-only, no-wallet chain reads for the landing stats strip.
//
// Sources (view functions inspected from the deployed ABIs / src in this repo):
//   Pool TVL        -> LiquidityPool.totalAssets()            (18-dp mUSD, ~1 USD each)
//   Live Markets    -> PositionManager.supportedMarkets(bytes32) for BTC & ETH (count true)
//   Open Interest   -> PositionManager.markets(bytes32) -> MarketState;
//                      sum(longSizeUsd[word0] + shortSizeUsd[word2]) over BTC & ETH (18-dp USD)
//
// Everything is a plain eth_call over JSON-RPC. No signing, no writes, no wallet libs.

const RPC = 'https://liteforge.rpc.caldera.xyz/infra-partner-http'

const LIQUIDITY_POOL = '0x4716a0c9c504f83918002a3086590f1ed192560b'
const POSITION_MANAGER = '0x9396d36f713302ff39e0ba5b38012656f8e4eacf'

// 4-byte selectors (from `cast sig`)
const SEL_TOTAL_ASSETS = '0x01e1d114' // totalAssets()
const SEL_MARKETS = '0x7564912b' // markets(bytes32)
const SEL_SUPPORTED = '0xb7094601' // supportedMarkets(bytes32)

// bytes32("BTC") / bytes32("ETH"), right-padded to 32 bytes
const BTC = '4254430000000000000000000000000000000000000000000000000000000000'
const ETH = '4554480000000000000000000000000000000000000000000000000000000000'

// mUSD uses 18 decimals and is treated as ~1 USD (see PositionManager price/decimal notes).
const ONE = 10n ** 18n

export type Stats = {
  tvl: number | null
  markets: number | null
  openInterest: number | null
}

type Call = { to: string; data: string }

function decodeUint(hex: string, wordIndex = 0): bigint {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex
  const start = wordIndex * 64
  const word = body.slice(start, start + 64)
  if (word.length < 64) throw new Error('short return data')
  return BigInt('0x' + word)
}

/**
 * Read the three live stats over RPC. Never throws: any slow/failed read yields
 * `null` for the affected stat so the caller can render the "—" fallback.
 * The whole batch is guarded by a hard timeout so first paint is never blocked.
 */
export async function readStats(timeoutMs = 5000): Promise<Stats> {
  const calls: Call[] = [
    { to: LIQUIDITY_POOL, data: SEL_TOTAL_ASSETS }, // 0: TVL
    { to: POSITION_MANAGER, data: SEL_SUPPORTED + BTC }, // 1: BTC supported
    { to: POSITION_MANAGER, data: SEL_SUPPORTED + ETH }, // 2: ETH supported
    { to: POSITION_MANAGER, data: SEL_MARKETS + BTC }, // 3: BTC market state
    { to: POSITION_MANAGER, data: SEL_MARKETS + ETH }, // 4: ETH market state
  ]

  const empty: Stats = { tvl: null, markets: null, openInterest: null }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let results: (string | null)[]
  try {
    const body = calls.map((c, i) => ({
      jsonrpc: '2.0',
      id: i,
      method: 'eth_call',
      params: [c, 'latest'],
    }))
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok) return empty
    const json = (await res.json()) as { id: number; result?: string; error?: unknown }[]
    if (!Array.isArray(json)) return empty
    results = calls.map((_, i) => {
      const entry = json.find((r) => r.id === i)
      return entry && !entry.error && typeof entry.result === 'string' ? entry.result : null
    })
  } catch {
    return empty
  } finally {
    clearTimeout(timer)
  }

  const out: Stats = { ...empty }

  // Pool TVL
  try {
    if (results[0]) out.tvl = Number(decodeUint(results[0]) / ONE)
  } catch {
    /* leave null -> "—" */
  }

  // Live markets: count of supported markets among BTC & ETH
  try {
    if (results[1] && results[2]) {
      const btc = decodeUint(results[1]) === 1n ? 1 : 0
      const eth = decodeUint(results[2]) === 1n ? 1 : 0
      out.markets = btc + eth
    }
  } catch {
    /* leave null -> "—" */
  }

  // Open interest: long + short notional across BTC & ETH
  try {
    if (results[3] && results[4]) {
      const oi =
        decodeUint(results[3], 0) +
        decodeUint(results[3], 2) +
        decodeUint(results[4], 0) +
        decodeUint(results[4], 2)
      out.openInterest = Number(oi / ONE)
    }
  } catch {
    /* leave null -> "—" */
  }

  return out
}
