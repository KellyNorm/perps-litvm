#!/usr/bin/env bash
# arm-breaker.sh — STEP 4 of the stack-redeploy track.
#
# Arms the oracle circuit-breaker (and optional exposure caps) on a FRESHLY
# DEPLOYED stack via Governance + PositionManager owner calls. ALL calls are
# owner-only and execute as DEPLOYER_PRIVATE_KEY (the Governance owner AND the
# PositionManager owner — both are set to the deployer at construction).
#
# DOES NOT DEPLOY. Run only AFTER DeployProdStack has produced new addresses and
# the env has been re-pointed (runbook steps 1-3).
#
# Locked values (docs/oracle-discovery.md):
#   BTC  CB_DEV_BPS=150  CB_SEC_MAXAGE=6600   DIA 0x7d0445782E383223c7B4B660bb96b87213e9b605
#   ETH  CB_DEV_BPS=200  CB_SEC_MAXAGE=6300   DIA 0xc760B46beF9eD3F9A3d2b825164324D6703F0185
#   CB_GATE_LIQ: LEFT UNSET (default 0) => liquidations stay OBSERVE-ONLY.
#
# Usage:
#   set -a; source .env; set +a        # exports LITVM_RPC_URL, DEPLOYER_PRIVATE_KEY,
#                                       # POSITION_MANAGER_ADDRESS, GOVERNANCE_ADDRESS
#   bash scripts/arm-breaker.sh                 # dry print only (default, safe)
#   ARM_BROADCAST=1 bash scripts/arm-breaker.sh # actually send the txs
set -euo pipefail

: "${LITVM_RPC_URL:?set LITVM_RPC_URL}"
: "${DEPLOYER_PRIVATE_KEY:?set DEPLOYER_PRIVATE_KEY}"
: "${POSITION_MANAGER_ADDRESS:?set POSITION_MANAGER_ADDRESS (new PM)}"
: "${GOVERNANCE_ADDRESS:?set GOVERNANCE_ADDRESS (new Governance)}"

RPC="$LITVM_RPC_URL"; PK="$DEPLOYER_PRIVATE_KEY"
PM="$POSITION_MANAGER_ADDRESS"; GOV="$GOVERNANCE_ADDRESS"

# --- DIA secondary feeds (4441) ---
DIA_BTC=0x7d0445782E383223c7B4B660bb96b87213e9b605
DIA_ETH=0xc760B46beF9eD3F9A3d2b825164324D6703F0185

# --- bytes32 market ids ---
BTC32=$(cast format-bytes32-string "BTC")          # 0x4254430000...00
ETH32=$(cast format-bytes32-string "ETH")          # 0x4554480000...00

# --- CB_PARAMS keys = keccak256(abi.encode("CB_PARAMS", market)) ---
K_BTC=$(cast keccak "$(cast abi-encode 'x(string,bytes32)' 'CB_PARAMS' "$BTC32")")
K_ETH=$(cast keccak "$(cast abi-encode 'x(string,bytes32)' 'CB_PARAMS' "$ETH32")")

# --- packed CB_PARAMS values = (stalenessSeconds << 128) | bandBps ---
V_BTC=2245863621678193858858272409049670195609750   # (6600<<128)|150
V_ETH=2143778911601912319819260026820139732173000   # (6300<<128)|200

# Bounds bracket the packed value. Use [0, uint256_max]: the value packs two
# uint128 fields so any 256-bit word is structurally valid; the bound is a
# typo-guard, not a semantic cap.
UMAX=115792089237316195423570985008687907853269984665640564039457584007913129639935

run() { # label, target, sig, args...
  local label="$1" target="$2" sig="$3"; shift 3
  echo ">>> $label"
  echo "    cast send $target \"$sig\" $* --rpc-url \$LITVM_RPC_URL --private-key \$DEPLOYER_PRIVATE_KEY"
  if [[ "${ARM_BROADCAST:-0}" == "1" ]]; then
    cast send "$target" "$sig" "$@" --rpc-url "$RPC" --private-key "$PK"
  fi
}

echo "=== ARM CIRCUIT-BREAKER (broadcast=${ARM_BROADCAST:-0}) ==="
echo "PM=$PM  GOV=$GOV"
echo

# 1) Wire the DIA secondary feed per market (PositionManager, owner-only).
run "setSecondaryFeed BTC -> DIA" "$PM" "setSecondaryFeed(bytes32,address)" "$BTC32" "$DIA_BTC"
run "setSecondaryFeed ETH -> DIA" "$PM" "setSecondaryFeed(bytes32,address)" "$ETH32" "$DIA_ETH"

# 2) Open the CB_PARAMS bounds (Governance, fail-closed: bounds BEFORE value).
run "setParamBounds CB_PARAMS BTC" "$GOV" "setParamBounds(bytes32,uint256,uint256)" "$K_BTC" 0 "$UMAX"
run "setParamBounds CB_PARAMS ETH" "$GOV" "setParamBounds(bytes32,uint256,uint256)" "$K_ETH" 0 "$UMAX"

# 3) Set the packed CB_PARAMS value (arms the band + staleness window).
run "setParam CB_PARAMS BTC (band 150 / age 6600)" "$GOV" "setParam(bytes32,uint256)" "$K_BTC" "$V_BTC"
run "setParam CB_PARAMS ETH (band 200 / age 6300)" "$GOV" "setParam(bytes32,uint256)" "$K_ETH" "$V_ETH"

echo
echo "CB_GATE_LIQ intentionally NOT set -> liquidations remain observe-only."
echo "=== done (broadcast=${ARM_BROADCAST:-0}) ==="

# ---------------------------------------------------------------------------
# OPTIONAL — per-market, per-side exposure caps (MAX_OI). NO value is locked in
# docs; leave UNSET to keep caps disabled (default 0), or fill CAP_* below with
# a sizeUsd figure (1e18) you have explicitly chosen, then set ARM_MAX_OI=1.
# key = keccak256(abi.encode("MAX_OI", market, isLong)); compared to
# longSizeUsd/shortSizeUsd at every OI-increasing fill (PositionManager.sol:2328).
# ---------------------------------------------------------------------------
if [[ "${ARM_MAX_OI:-0}" == "1" ]]; then
  CAP_BTC=${CAP_BTC:?set CAP_BTC (sizeUsd 1e18) before ARM_MAX_OI=1}
  CAP_ETH=${CAP_ETH:?set CAP_ETH (sizeUsd 1e18) before ARM_MAX_OI=1}
  for SIDE in true false; do
    OB=$(cast keccak "$(cast abi-encode 'x(string,bytes32,bool)' 'MAX_OI' "$BTC32" $SIDE)")
    OE=$(cast keccak "$(cast abi-encode 'x(string,bytes32,bool)' 'MAX_OI' "$ETH32" $SIDE)")
    run "setParamBounds MAX_OI BTC isLong=$SIDE" "$GOV" "setParamBounds(bytes32,uint256,uint256)" "$OB" 0 "$UMAX"
    run "setParamBounds MAX_OI ETH isLong=$SIDE" "$GOV" "setParamBounds(bytes32,uint256,uint256)" "$OE" 0 "$UMAX"
    run "setParam MAX_OI BTC isLong=$SIDE" "$GOV" "setParam(bytes32,uint256)" "$OB" "$CAP_BTC"
    run "setParam MAX_OI ETH isLong=$SIDE" "$GOV" "setParam(bytes32,uint256)" "$OE" "$CAP_ETH"
  done
fi
