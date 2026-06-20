// RedStone mock-payload generator for Foundry tests (invoked via `vm.ffi`).
//
// Prints, to stdout, the hex-encoded RedStone payload that a test appends to a
// contract call's calldata so that `getOracleNumericValueFromTxMsg` can verify
// and extract prices. The payload is signed by RedStone's deterministic mock
// signers (the same Anvil/Hardhat default keys baked into
// `AuthorisedMockSignersBase`), so no network access or live data service is
// needed — the test is fully offline and deterministic.
//
// Usage:
//   node test/ffi/redstone-mock-payload.js <timestampMs> <FEED:value> [FEED:value ...]
//
// Example (BTC = 67000.0, ETH = 3500.0, package timestamp 1700000000000ms):
//   node test/ffi/redstone-mock-payload.js 1700000000000 BTC:67000 ETH:3500
//
// Notes:
//  * Values use RedStone's default numeric precision (8 decimals), so the
//    on-chain value for `BTC:67000` is 67000 * 1e8.
//  * `mockSignersCount` is 3 to match the PRODUCTION base
//    (`PrimaryProdDataServiceConsumerBase`) unique-signers threshold of 3; the
//    test harness authorises mock signer indices 0..N via its
//    `getAuthorisedSignerIndex` override (see the *Harness contracts). Three
//    distinct mock signers (indices 0,1,2) clear the threshold and remain valid
//    for the demo-based PriceReader too (its threshold of 1 is <= 3).
//  * The Foundry test must `vm.warp(timestampMs / 1000)` so the package passes
//    the inherited staleness check.

const { SimpleNumericMockWrapper } = require("@redstone-finance/evm-connector");

async function main() {
  const [timestampArg, ...feedArgs] = process.argv.slice(2);

  if (!timestampArg || feedArgs.length === 0) {
    console.error(
      "usage: node redstone-mock-payload.js <timestampMs> <FEED:value> [FEED:value ...]"
    );
    process.exit(1);
  }

  const timestampMilliseconds = Number(timestampArg);
  const dataPoints = feedArgs.map((arg) => {
    const [dataFeedId, value] = arg.split(":");
    return { dataFeedId, value: Number(value) };
  });

  const wrapper = new SimpleNumericMockWrapper({
    mockSignersCount: 3,
    timestampMilliseconds,
    dataPoints,
  });

  // Raw payload bytes (hex, 0x-prefixed) to append to the wrapped call's calldata.
  const payloadHex = await wrapper.getBytesDataForAppending();
  process.stdout.write(payloadHex);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
