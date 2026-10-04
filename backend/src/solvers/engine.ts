/**
 * Solver Engine — Simulates a competitive solver auction.
 *
 * In production these would be external services querying real DEX aggregators
 * (1inch, 0x, Paraswap, Uniswap) via gRPC/HTTP, or on-chain Dutch auctions.
 *
 * Each solver has distinct characteristics:
 *  - AlphaBot: Arbitrage-focused, fast, uses order book cross
 *  - BetaBot:  High-volume AMM aggregator, medium latency
 *  - GammaBot: MEV-aware optimal route finder, slower but best rates
 *  - DeltaBot: Flash loan specialist (high success, occasional spike)
 */

import { Intent, Quote, SolverResult } from "../types";

// ─── Solver definitions ───────────────────────────────────────────────────────

interface SolverConfig {
  id: string;
  displayName: string;
  strategy: string;
  /** Base rate applied to amountIn (simulates DEX price) */
  baseRate: number;
  /** ±spread adds realistic price variance */
  rateSpread: number;
  /** Simulated base latency in ms */
  baseLatencyMs: number;
  /** Random extra latency */
  latencySpreadMs: number;
  /** Probability [0,1] of a transient failure */
  failureProbability: number;
  /** Solver protocol fee in bps on amountIn */
  feeBps: number;
  /** Rough gas units consumed (for gas cost estimate) */
  estimatedGasUnits: number;
}

const SOLVERS: SolverConfig[] = [
  {
    id: "alpha-bot",
    displayName: "AlphaBot",
    strategy: "Arbitrage / Order Book Cross",
    baseRate: 0.948,
    rateSpread: 0.012,
    baseLatencyMs: 20,
    latencySpreadMs: 30,
    failureProbability: 0.04,
    feeBps: 30,
    estimatedGasUnits: 180_000,
  },
  {
    id: "beta-bot",
    displayName: "BetaBot",
    strategy: "AMM Aggregator (Uniswap + Curve)",
    baseRate: 0.954,
    rateSpread: 0.016,
    baseLatencyMs: 45,
    latencySpreadMs: 60,
    failureProbability: 0.06,
    feeBps: 25,
    estimatedGasUnits: 220_000,
  },
  {
    id: "gamma-bot",
    displayName: "GammaBot",
    strategy: "MEV-Aware Optimal Route",
    baseRate: 0.961,
    rateSpread: 0.02,
    baseLatencyMs: 80,
    latencySpreadMs: 120,
    failureProbability: 0.12,
    feeBps: 15,
    estimatedGasUnits: 260_000,
  },
  {
    id: "delta-bot",
    displayName: "DeltaBot",
    strategy: "Flash Loan Specialist",
    baseRate: 0.958,
    rateSpread: 0.025,
    baseLatencyMs: 110,
    latencySpreadMs: 90,
    failureProbability: 0.18,
    feeBps: 20,
    estimatedGasUnits: 350_000,
  },
];

// ─── Gas oracle simulation ────────────────────────────────────────────────────

/** Simulate a dynamic gas price (Gwei), mimicking real on-chain variance */
function simulateGasPrice(): bigint {
  // Ranges between 5–60 Gwei with occasional spikes
  const base = 10 + Math.random() * 30; // 10–40 Gwei typical
  const spike = Math.random() < 0.1 ? Math.random() * 20 : 0; // 10% spike chance
  return BigInt(Math.round((base + spike) * 1e9)); // in wei
}

// ─── Individual solver simulation ─────────────────────────────────────────────

function simulateSolver(config: SolverConfig, intent: Intent): Promise<SolverResult> {
  return new Promise((resolve) => {
    const latency = config.baseLatencyMs + Math.random() * config.latencySpreadMs;

    setTimeout(() => {
      // Transient failure simulation
      if (Math.random() < config.failureProbability) {
        const failureReasons = [
          "Insufficient liquidity in target pool",
          "Solver temporarily unavailable",
          "Route calculation timeout",
          "Gas price spike exceeded threshold",
        ];
        resolve({
          solverId: config.id,
          quote: null,
          error: failureReasons[Math.floor(Math.random() * failureReasons.length)],
        });
        return;
      }

      const amountIn = BigInt(intent.amountIn);

      // Realistic rate computation: base + random spread (-spread/2 to +spread/2)
      const rate = config.baseRate + (Math.random() - 0.5) * config.rateSpread;

      // Apply impact model: large trades get slightly worse rates (price impact)
      const amountInEth = Number(amountIn) / 1e18;
      const priceImpact = Math.min(amountInEth > 1000 ? (amountInEth - 1000) * 0.00005 : 0, 0.02);
      const effectiveRate = Math.max(rate - priceImpact, 0.5);

      const amountOut = BigInt(Math.floor(Number(amountIn) * effectiveRate));

      // Protocol fee deducted from amountIn
      const fee = (amountIn * BigInt(config.feeBps)) / 10_000n;

      // Gas cost estimate
      const gasPrice = simulateGasPrice();
      const gasUnits = BigInt(config.estimatedGasUnits);
      const estimatedGas = (gasPrice * gasUnits).toString();

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

// ─── Auction engine ───────────────────────────────────────────────────────────

/**
 * Run all solvers concurrently and return the best quote.
 *
 * Ranking criteria (in order):
 *   1. Highest `amountOut` (net user value)
 *   2. Lowest `fee` as tiebreaker
 *   3. Lowest `latencyMs` as final tiebreaker
 */
export async function runSolverAuction(intent: Intent): Promise<{
  winner: Quote | null;
  allQuotes: Quote[];
  results: SolverResult[];
}> {
  const start = Date.now();

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

  // Filter out quotes below minAmountOut (slippage guard)
  const minOut = BigInt(intent.minAmountOut);
  const eligibleQuotes = validQuotes.filter((q) => BigInt(q.amountOut) >= minOut);

  // Sort: highest amountOut → lowest fee → lowest latency
  eligibleQuotes.sort((a, b) => {
    const outDiff = BigInt(b.amountOut) - BigInt(a.amountOut);
    if (outDiff !== 0n) return outDiff > 0n ? 1 : -1;

    const feeDiff = BigInt(a.fee) - BigInt(b.fee);
    if (feeDiff !== 0n) return feeDiff > 0n ? 1 : -1;

    return (a.latencyMs ?? 0) - (b.latencyMs ?? 0);
  });

  const totalMs = Date.now() - start;
  const failedCount = results.filter((r) => r.quote === null).length;

  console.log(
    `[SolverAuction] Completed in ${totalMs}ms. ` +
      `${eligibleQuotes.length}/${SOLVERS.length} solvers eligible. ` +
      `${failedCount} failed.` +
      (eligibleQuotes[0]
        ? ` Winner: ${eligibleQuotes[0].solverId} @ ${(Number(eligibleQuotes[0].amountOut) / 1e18).toFixed(4)}`
        : " No winner.")
  );

  return {
    winner: eligibleQuotes[0] ?? null,
    allQuotes: validQuotes,
    results,
  };
}

export { SOLVERS };
