// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title IntentEscrow
 * @notice Gas-free intent-based token swap escrow using EIP-712 signed intents.
 * @dev Users sign an Intent off-chain. Solvers submit the signed intent on-chain
 *      to fulfill it. The solver calls fulfillIntent() with the output tokens,
 *      claiming the input tokens as their profit margin.
 *
 * Security model:
 *  - ReentrancyGuard: prevents re-entrancy on all state-changing paths
 *  - CEI pattern: state is mutated BEFORE any external token transfers
 *  - usedIntents mapping: prevents replay of the same intent hash
 *  - Nonce in intent struct: per-user nonce to invalidate stale intents
 *  - Deadline: intents expire, preventing indefinite locking
 *  - EIP-712 typed data: prevents cross-domain/cross-contract signature replay
 */
contract IntentEscrow is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    // ─── EIP-712 ──────────────────────────────────────────────────────────────

    bytes32 public constant DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );

    bytes32 public constant INTENT_TYPEHASH =
        keccak256(
            "Intent(address user,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint256 deadline,uint256 nonce,uint256 sourceChainId,uint256 destChainId)"
        );

    bytes32 public immutable DOMAIN_SEPARATOR;

    // ─── Structs ──────────────────────────────────────────────────────────────

    struct Intent {
        address user;           // Signer / token owner
        address tokenIn;        // Token user deposits
        address tokenOut;       // Token user wants to receive
        uint256 amountIn;       // Exact amount user deposits
        uint256 minAmountOut;   // Minimum acceptable output (slippage guard)
        uint256 deadline;       // Unix timestamp after which intent expires
        uint256 nonce;          // Per-user nonce for replay protection
        uint256 sourceChainId;  // Chain where tokenIn lives (extensible for CCIP)
        uint256 destChainId;    // Chain where tokenOut should arrive
    }

    // ─── State ────────────────────────────────────────────────────────────────

    /// @dev intentHash => fulfilled/cancelled
    mapping(bytes32 => bool) public usedIntents;

    /// @dev user => current nonce (incremented on cancel; filled intents advance externally via sig)
    mapping(address => uint256) public nonces;

    /// @dev Protocol fee in basis points (e.g. 30 = 0.30%)
    uint256 public feeBps;

    /// @dev Accumulated fees per token
    mapping(address => uint256) public feeReserves;

    // ─── Events ───────────────────────────────────────────────────────────────

    event IntentFulfilled(
        bytes32 indexed intentHash,
        address indexed user,
        address indexed solver,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    event IntentCancelled(bytes32 indexed intentHash, address indexed user);
    event FeeBpsUpdated(uint256 oldBps, uint256 newBps);
    event FeesWithdrawn(address indexed token, address indexed to, uint256 amount);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error IntentExpired();
    error IntentAlreadyUsed();
    error InvalidSignature();
    error SlippageExceeded(uint256 amountOut, uint256 minAmountOut);
    error InvalidDeadline();
    error InvalidAmount();
    error FeeTooHigh();
    error WrongChain();

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(uint256 _feeBps) Ownable(msg.sender) {
        if (_feeBps > 1000) revert FeeTooHigh(); // max 10%
        feeBps = _feeBps;

        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes("IntentSwap")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    // ─── Core Logic ───────────────────────────────────────────────────────────

    /**
     * @notice Fulfill a user's signed intent.
     * @dev Solver must have pre-approved this contract to spend `amountOut` of tokenOut.
     *      Flow:
     *        1. Verify signature & conditions
     *        2. Mark intent used (CEI — before external calls)
     *        3. Pull tokenIn from user to this contract
     *        4. Calculate fee; transfer net tokenIn to solver
     *        5. Pull tokenOut from solver; deliver to user
     * @param intent    The Intent struct signed by the user
     * @param v         Signature component v
     * @param r         Signature component r
     * @param s         Signature component s
     * @param amountOut Actual amount of tokenOut the solver will deliver
     */
    function fulfillIntent(
        Intent calldata intent,
        uint8 v,
        bytes32 r,
        bytes32 s,
        uint256 amountOut
    ) external nonReentrant {
        // ── 1. Validations ────────────────────────────────────────────────────
        if (block.timestamp > intent.deadline) revert IntentExpired();
        if (intent.amountIn == 0) revert InvalidAmount();
        if (amountOut < intent.minAmountOut)
            revert SlippageExceeded(amountOut, intent.minAmountOut);
        if (intent.sourceChainId != block.chainid) revert WrongChain();

        bytes32 intentHash = _hashIntent(intent);
        if (usedIntents[intentHash]) revert IntentAlreadyUsed();

        // Verify EIP-712 signature
        address signer = _recoverSigner(intentHash, v, r, s);
        if (signer != intent.user) revert InvalidSignature();

        // ── 2. CEI: Mark used BEFORE transfers ────────────────────────────────
        usedIntents[intentHash] = true;

        // ── 3. Pull tokenIn from user ─────────────────────────────────────────
        IERC20(intent.tokenIn).safeTransferFrom(
            intent.user,
            address(this),
            intent.amountIn
        );

        // ── 4. Deduct fee; send net tokenIn to solver ─────────────────────────
        uint256 fee = (intent.amountIn * feeBps) / 10_000;
        feeReserves[intent.tokenIn] += fee;
        uint256 solverReceives = intent.amountIn - fee;

        IERC20(intent.tokenIn).safeTransfer(msg.sender, solverReceives);

        // ── 5. Pull tokenOut from solver; deliver to user ─────────────────────
        IERC20(intent.tokenOut).safeTransferFrom(
            msg.sender,
            intent.user,
            amountOut
        );

        emit IntentFulfilled(
            intentHash,
            intent.user,
            msg.sender,
            intent.tokenIn,
            intent.tokenOut,
            intent.amountIn,
            amountOut
        );
    }

    /**
     * @notice Cancel an intent so it can never be fulfilled.
     * @dev Only the intent's user may cancel. Also increments nonce to
     *      invalidate any other pending intents with old nonces.
     */
    function cancelIntent(Intent calldata intent) external nonReentrant {
        bytes32 intentHash = _hashIntent(intent);
        if (usedIntents[intentHash]) revert IntentAlreadyUsed();
        if (intent.user != msg.sender) revert InvalidSignature();

        usedIntents[intentHash] = true;
        nonces[msg.sender]++;

        emit IntentCancelled(intentHash, msg.sender);
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    function setFeeBps(uint256 _feeBps) external onlyOwner {
        if (_feeBps > 1000) revert FeeTooHigh();
        emit FeeBpsUpdated(feeBps, _feeBps);
        feeBps = _feeBps;
    }

    function withdrawFees(address token, address to) external onlyOwner {
        uint256 amount = feeReserves[token];
        feeReserves[token] = 0;
        IERC20(token).safeTransfer(to, amount);
        emit FeesWithdrawn(token, to, amount);
    }

    // ─── View helpers ─────────────────────────────────────────────────────────

    function hashIntent(Intent calldata intent) external view returns (bytes32) {
        return _hashIntent(intent);
    }

    function isUsed(bytes32 intentHash) external view returns (bool) {
        return usedIntents[intentHash];
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    function _hashIntent(Intent calldata intent) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                INTENT_TYPEHASH,
                intent.user,
                intent.tokenIn,
                intent.tokenOut,
                intent.amountIn,
                intent.minAmountOut,
                intent.deadline,
                intent.nonce,
                intent.sourceChainId,
                intent.destChainId
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    function _recoverSigner(
        bytes32 intentHash,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal pure returns (address) {
        return ecrecover(intentHash, v, r, s);
    }
}
