/**
 * Mock Solver Engine
 *
 * Simulates 3 competing solvers racing to provide the best quote.
 * Each solver has different characteristics:
 *  - AlphaBot: Fast, moderate rates
 *  - BetaBot: Slower, slightly better rates
 *  - GammaBot: Slowest, best rates but sometimes fails
 *
 * In production these would be external services called via gRPC/HTTP,
 * or on-chain Dutch auction mechanisms (e.g. UniswapX).
 */

import { Intent, Quote, SolverResult } from "../types";

// ─── Solver definitions ──────────────────────────────────────────────────────

interface SolverConfig {
  id: string;
  displayName: string;
  // Rate applied to amountIn to produce amountOut (simulates a price)
  baseRate: number;
  // Random spread on top of baseRate
  rateSpread: number;
  // Base latency in ms
  baseLatencyMs: number;
  // Extra random latency
  latencySpreadMs: number;
  // Probability [0,1] of this solver failing
  failureProbability: number;
  // Solver fee in basis points on amountIn
  feeBps: number;
}

const SOLVERS: SolverConfig[] = [
  {
    id: "alpha-bot",
    displayName: "AlphaBot",
    baseRate: 0.945,
    rateSpread: 0.01,
    baseLatencyMs: 80,
    latencySpreadMs: 40,
    failureProbability: 0.05,
    feeBps: 15,
  },
  {
    id: "beta-bot",
    displayName: "BetaBot",
    baseRate: 0.952,
    rateSpread: 0.015,
    baseLatencyMs: 150,
    latencySpreadMs: 80,
    failureProbability: 0.08,
    feeBps: 12,
  },
  {
    id: "gamma-bot",
    displayName: "GammaBot",
    baseRate: 0.96,
    rateSpread: 0.02,
    baseLatencyMs: 300,
    latencySpreadMs: 150,
    failureProbability: 0.15,
    feeBps: 10,
  },
];

// ─── Individual solver simulation ────────────────────────────────────────────

function simulateSolver(
  config: SolverConfig,
  intent: Intent
): Promise<SolverResult> {
  return new Promise((resolve) => {
    const latency =
      config.baseLatencyMs + Math.random() * config.latencySpreadMs;

    setTimeout(() => {
      // Simulate occasional failures
      if (Math.random() < config.failureProbability) {
        resolve({
          solverId: config.id,
          quote: null,
          error: "Solver temporarily unavailable",
        });
        return;
      }

      const amountIn = BigInt(intent.amountIn);
      const rate = config.baseRate + (Math.random() - 0.5) * config.rateSpread;

      // Calculate amountOut as scaled bigint
      const amountOutNum = Number(amountIn) * rate;
      const amountOut = BigInt(Math.floor(amountOutNum));

      // Solver fee in tokenIn
      const fee = (amountIn * BigInt(config.feeBps)) / 10_000n;

      // Rough gas estimate (gwei × gas units, returned as wei string)
      const estimatedGas = (21_000n * 2n * 1_000_000_000n).toString(); // ~42k gas @ 1 gwei

      const quote: Quote = {
        solverId: config.id,
        amountOut: amountOut.toString(),
        fee: fee.toString(),
        estimatedGas,
        latencyMs: Math.round(latency),
      };

      resolve({ solverId: config.id, quote });
    }, latency);
  });
}

// ─── Race all solvers ────────────────────────────────────────────────────────

/**
 * Run all solvers concurrently and return the best quote.
 * Tie-breaking: highest amountOut wins; on equal amountOut, lowest fee wins.
 */
export async function runSolverAuction(intent: Intent): Promise<{
  winner: Quote | null;
  allQuotes: Quote[];
  results: SolverResult[];
}> {
  const start = Date.now();

  // Promise.allSettled ensures we collect all results even if some throw
  const settled = await Promise.allSettled(
    SOLVERS.map((cfg) => simulateSolver(cfg, intent))
  );

  const results: SolverResult[] = settled.map((r) =>
    r.status === "fulfilled"
      ? r.value
      : { solverId: "unknown", quote: null, error: String(r.reason) }
  );

  const validQuotes: Quote[] = results
    .filter((r): r is SolverResult & { quote: Quote } => r.quote !== null)
    .map((r) => r.quote);

  // Filter out quotes below minAmountOut
  const minOut = BigInt(intent.minAmountOut);
  const eligibleQuotes = validQuotes.filter(
    (q) => BigInt(q.amountOut) >= minOut
  );

  // Sort: highest amountOut first, then lowest fee as tiebreaker
  eligibleQuotes.sort((a, b) => {
    const outDiff = BigInt(b.amountOut) - BigInt(a.amountOut);
    if (outDiff !== 0n) return outDiff > 0n ? 1 : -1;
    const feeDiff = BigInt(a.fee) - BigInt(b.fee);
    return feeDiff > 0n ? 1 : feeDiff < 0n ? -1 : 0;
  });

  const totalMs = Date.now() - start;
  console.log(
    `[SolverAuction] Completed in ${totalMs}ms. ` +
      `${eligibleQuotes.length}/${SOLVERS.length} solvers eligible.`
  );

  return {
    winner: eligibleQuotes[0] ?? null,
    allQuotes: validQuotes,
    results,
  };
}

export { SOLVERS };
