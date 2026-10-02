/**
 * Unit tests for the Solver Auction Engine
 *
 * These tests exercise runSolverAuction() using a mocked intent.
 * No MongoDB or blockchain required.
 */

import { runSolverAuction } from "../solvers/engine";
import { Intent } from "../types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeIntent(overrides: Partial<Intent> = {}): Intent {
  return {
    user: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    tokenIn: "0xTokenA",
    tokenOut: "0xTokenB",
    amountIn: "1000000000000000000", // 1e18
    minAmountOut: "900000000000000000", // 0.9e18
    deadline: Math.floor(Date.now() / 1000) + 3600,
    nonce: 0,
    sourceChainId: 31337,
    destChainId: 31337,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("runSolverAuction", () => {
  it("returns a winner and allQuotes array", async () => {
    const intent = makeIntent();
    const result = await runSolverAuction(intent);

    expect(result).toHaveProperty("winner");
    expect(result).toHaveProperty("allQuotes");
    expect(result).toHaveProperty("results");

    // At least some solvers should respond
    expect(result.results.length).toBeGreaterThan(0);
  });

  it("winner has the highest amountOut among eligible quotes", async () => {
    const intent = makeIntent();
    const { winner, allQuotes } = await runSolverAuction(intent);

    if (winner === null) {
      // All solvers failed — valid but rare; skip assertion
      return;
    }

    const minOut = BigInt(intent.minAmountOut);
    const eligible = allQuotes.filter((q) => BigInt(q.amountOut) >= minOut);

    for (const q of eligible) {
      expect(BigInt(winner.amountOut)).toBeGreaterThanOrEqual(
        BigInt(q.amountOut)
      );
    }
  });

  it("returns null winner when minAmountOut is impossibly high", async () => {
    const intent = makeIntent({
      // 10× the amountIn — no solver can match this
      minAmountOut: (BigInt("1000000000000000000") * 10n).toString(),
    });

    const { winner, allQuotes } = await runSolverAuction(intent);

    expect(winner).toBeNull();
    // allQuotes still contains raw valid quotes (before slippage filter)
    expect(Array.isArray(allQuotes)).toBe(true);
  });

  it("each quote has required fields", async () => {
    const intent = makeIntent({
      minAmountOut: "0", // accept anything so quotes always eligible
    });

    const { allQuotes } = await runSolverAuction(intent);

    for (const q of allQuotes) {
      expect(q).toHaveProperty("solverId");
      expect(q).toHaveProperty("amountOut");
      expect(q).toHaveProperty("fee");
      expect(q).toHaveProperty("estimatedGas");
      expect(q).toHaveProperty("latencyMs");
      expect(typeof q.latencyMs).toBe("number");
      expect(BigInt(q.amountOut)).toBeGreaterThan(0n);
    }
  });

  it("winner amountOut is >= minAmountOut", async () => {
    const intent = makeIntent();
    const { winner } = await runSolverAuction(intent);

    if (winner) {
      expect(BigInt(winner.amountOut)).toBeGreaterThanOrEqual(
        BigInt(intent.minAmountOut)
      );
    }
  });

  it("ties broken by lowest fee", async () => {
    const intent = makeIntent({ minAmountOut: "0" });
    const { allQuotes, winner } = await runSolverAuction(intent);

    if (!winner || allQuotes.length < 2) return;

    // Find quotes with same amountOut as winner
    const tied = allQuotes.filter(
      (q) => q.amountOut === winner.amountOut
    );
    for (const t of tied) {
      expect(BigInt(winner.fee)).toBeLessThanOrEqual(BigInt(t.fee));
    }
  });
});
