// The prediction factory address must FAIL LOUDLY when unconfigured rather than fall back
// to a hardcoded one. A stale fallback is the dangerous case: a superseded factory stays
// immutable and answers every call, so a mis-pointed build renders a healthy-looking board
// of markets nobody trades. These tests pin the "no silent default" contract.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateFactoryAddress,
  requirePredictionFactoryAddress,
} from "../../src/lib/prediction/predictionConfig.js";

const LIVE = "0x7dd9e01fD4f96F9b1F875351eaccb5cA6C84c512";

test("accepts a well-formed address and preserves its casing", () => {
  assert.equal(validateFactoryAddress(LIVE), LIVE);
});

test("trims surrounding whitespace (a .env value can carry a stray space)", () => {
  assert.equal(validateFactoryAddress(`  ${LIVE}\n`), LIVE);
});

for (const [label, raw] of [
  ["undefined", undefined],
  ["null", null],
  ["empty string", ""],
  ["whitespace only", "   "],
]) {
  test(`throws on ${label} instead of substituting a default`, () => {
    assert.throws(() => validateFactoryAddress(raw), /not configured/);
  });
}

for (const [label, raw] of [
  ["missing 0x prefix", "7dd9e01fD4f96F9b1F875351eaccb5cA6C84c512"],
  ["too short", "0x7dd9e01f"],
  ["non-hex characters", "0xZZd9e01fD4f96F9b1F875351eaccb5cA6C84c512"],
  ["a placeholder", "your-address-here"],
]) {
  test(`rejects a malformed address (${label})`, () => {
    assert.throws(() => validateFactoryAddress(raw), /not a valid address/);
  });
}

// The message is the whole point of failing loudly: it has to name the variable and say
// that a rebuild is required, because VITE_* values are inlined at build time.
test("the error names the env var and the rebuild requirement", () => {
  assert.throws(() => validateFactoryAddress(""), (e) => {
    assert.match(e.message, /VITE_PREDICTION_FACTORY_ADDRESS/);
    assert.match(e.message, /rebuild/i);
    return true;
  });
});

// Under `node --test` there is no import.meta.env, so the module resolves to unset — which
// is exactly the env-less build this guard exists for. It must throw, not return anything.
test("the accessor throws when no env is present at all", () => {
  assert.throws(() => requirePredictionFactoryAddress(), /VITE_PREDICTION_FACTORY_ADDRESS/);
});
