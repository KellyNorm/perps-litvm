// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title Governance
 * @notice Lean, external control surface for the perps DEX. The
 *         {PositionManager} and {LiquidityPool} hold this contract as an
 *         `immutable` and READ it; they never write to it. It carries three
 *         orthogonal, deliberately tiny responsibilities:
 *
 *         1. Ownership — a two-step ({Ownable2Step}) owner that is the single
 *            authority over the pause flag and the parameter store. The owner is
 *            set at construction.
 *         2. Global pause — a single boolean the consumers consult to gate
 *            new-risk entry points (opening/increasing leverage, LP deposits)
 *            while leaving every risk-reducing or fund-returning path
 *            (close/decrease/cancel/liquidate, LP withdraw) always available.
 *         3. Generic parameter store — a `bytes32 => uint256` map with
 *            per-key governable bounds. It is FAIL-CLOSED: a key cannot be set
 *            until its bounds are configured, and every write is range-checked.
 *
 * @dev    Design constraints (per project constitution):
 *         - Minimal & not upgradeable: no proxy, no upgrade hooks, no admin
 *           power beyond the owner-only mutators below. Low bug surface by
 *           construction — the consumers' existing per-contract admin checks are
 *           intentionally left untouched and are NOT routed through here.
 *         - No concrete params are seeded; this is the substrate future PRs will
 *           use for caps/fees/signer sets. Until bounds are set for a key,
 *           {setParam} reverts, so a mis-typed or not-yet-governed key can never
 *           silently take effect.
 */
contract Governance is Ownable2Step {
    /// @dev Per-key governable bounds for the parameter store. `set` distinguishes
    ///      an explicitly-configured `[0, 0]` bound from an unconfigured key
    ///      (fail-closed: an unconfigured key rejects every {setParam}).
    struct Bounds {
        uint256 min;
        uint256 max;
        bool set;
    }

    /// @dev Global pause flag; see {paused}.
    bool private _paused;

    /// @dev Generic governed parameters; see {getParam}/{setParam}.
    mapping(bytes32 => uint256) private _params;

    /// @dev Bounds gating each parameter; see {setParamBounds}.
    mapping(bytes32 => Bounds) private _bounds;

    /// @dev {setParam} called for a key with no bounds configured (fail-closed).
    error ParamUnbounded(bytes32 key);

    /// @dev {setParam} value falls outside the key's configured `[min, max]`.
    error ParamOutOfBounds(bytes32 key, uint256 value, uint256 min, uint256 max);

    /// @dev {setParamBounds} called with `min > max`.
    error InvalidBounds(uint256 min, uint256 max);

    /// @notice Emitted when the global pause is engaged.
    event Paused(address indexed account);

    /// @notice Emitted when the global pause is lifted.
    event Unpaused(address indexed account);

    /// @notice Emitted when a parameter's bounds are (re)configured.
    event ParamBoundsSet(bytes32 indexed key, uint256 min, uint256 max);

    /// @notice Emitted when a parameter value is set within its bounds.
    event ParamSet(bytes32 indexed key, uint256 value);

    /**
     * @param initialOwner The account granted ownership (pause + param authority).
     *                     Two-step thereafter via {transferOwnership}/{acceptOwnership}.
     */
    constructor(address initialOwner) Ownable(initialOwner) {}

    // --- pause ------------------------------------------------------------

    /// @notice True while the global pause is engaged. Consumers gate their
    ///         new-risk entry points on this; it never blocks risk-reducing or
    ///         fund-returning actions.
    function paused() external view returns (bool) {
        return _paused;
    }

    /// @notice Engage the global pause. Owner-only. Idempotent.
    function pause() external onlyOwner {
        _paused = true;
        emit Paused(msg.sender);
    }

    /// @notice Lift the global pause. Owner-only. Idempotent.
    function unpause() external onlyOwner {
        _paused = false;
        emit Unpaused(msg.sender);
    }

    // --- generic parameter store -----------------------------------------

    /// @notice Current value of a governed parameter (0 if never set).
    function getParam(bytes32 key) external view returns (uint256) {
        return _params[key];
    }

    /// @notice Configured bounds for a parameter key.
    /// @return min    Lower bound (inclusive).
    /// @return max    Upper bound (inclusive).
    /// @return isSet  True once {setParamBounds} has configured this key.
    function getParamBounds(bytes32 key) external view returns (uint256 min, uint256 max, bool isSet) {
        Bounds memory b = _bounds[key];
        return (b.min, b.max, b.set);
    }

    /**
     * @notice Configure (or re-configure) the inclusive `[min, max]` range a
     *         parameter may take. Owner-only. The bounds themselves are
     *         governable; tightening them does not retroactively invalidate an
     *         already-stored value.
     */
    function setParamBounds(bytes32 key, uint256 min, uint256 max) external onlyOwner {
        if (min > max) revert InvalidBounds(min, max);
        _bounds[key] = Bounds({min: min, max: max, set: true});
        emit ParamBoundsSet(key, min, max);
    }

    /**
     * @notice Set a governed parameter. Owner-only and FAIL-CLOSED: reverts if no
     *         bounds are configured for `key`, or if `value` falls outside the
     *         configured `[min, max]`.
     */
    function setParam(bytes32 key, uint256 value) external onlyOwner {
        Bounds memory b = _bounds[key];
        if (!b.set) revert ParamUnbounded(key);
        if (value < b.min || value > b.max) revert ParamOutOfBounds(key, value, b.min, b.max);
        _params[key] = value;
        emit ParamSet(key, value);
    }
}
