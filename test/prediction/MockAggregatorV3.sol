// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAggregatorV3} from "../../src/prediction/IAggregatorV3.sol";

/**
 * @title MockAggregatorV3
 * @notice Test-only AggregatorV3 feed that can be forced into ANY price / round
 *         state on command, so {SafeAggregatorReader} can be exercised against
 *         every failure mode from design §3.
 * @dev    Lives under `test/` — never compiled into the deployable `src` tree.
 *         Beyond the normal settable tuple it can also simulate a hostile feed:
 *         a hard revert, or short / empty returndata (garbage) that would break a
 *         naive ABI decode. The reader must fail safe against all of these.
 */
contract MockAggregatorV3 is IAggregatorV3 {
    /// How `latestRoundData` behaves. `Normal` returns the stored tuple.
    enum Mode {
        Normal, // return the stored (roundId, answer, startedAt, updatedAt, answeredInRound)
        Revert, // revert like a dead / paused feed
        ShortReturn, // return < 160 bytes of returndata (malformed)
        EmptyReturn // return 0 bytes of returndata (malformed)
    }

    uint8 private _decimals;

    uint80 public roundId;
    int256 public answer;
    uint256 public startedAt;
    uint256 public updatedAt;
    uint80 public answeredInRound;

    Mode public mode;

    constructor(uint8 dec) {
        _decimals = dec;
    }

    // --- IAggregatorV3 ---

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        if (mode == Mode.Revert) {
            revert("MockAggregatorV3: feed down");
        }
        if (mode == Mode.ShortReturn) {
            // One 32-byte word only (< 160) => garbage the reader must reject.
            assembly {
                mstore(0x00, 1)
                return(0x00, 0x20)
            }
        }
        if (mode == Mode.EmptyReturn) {
            // Zero-length returndata (e.g. wrong address / non-contract).
            assembly {
                return(0x00, 0x00)
            }
        }
        return (roundId, answer, startedAt, updatedAt, answeredInRound);
    }

    // --- test controls ---

    function setDecimals(uint8 dec) external {
        _decimals = dec;
    }

    function setMode(Mode m) external {
        mode = m;
    }

    /// @notice Force the full round tuple explicitly (leaves `mode == Normal`).
    function setRound(uint80 _roundId, int256 _answer, uint256 _startedAt, uint256 _updatedAt, uint80 _answeredInRound)
        external
    {
        roundId = _roundId;
        answer = _answer;
        startedAt = _startedAt;
        updatedAt = _updatedAt;
        answeredInRound = _answeredInRound;
        mode = Mode.Normal;
    }

    /// @notice Convenience: a healthy, complete round at `_answer` stamped `_updatedAt`.
    function setHealthy(int256 _answer, uint256 _updatedAt) external {
        roundId = 1;
        answer = _answer;
        startedAt = _updatedAt;
        updatedAt = _updatedAt;
        answeredInRound = 1;
        mode = Mode.Normal;
    }
}
