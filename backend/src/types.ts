// Shared types used across the backend

export interface Intent {
  user: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;        // bigint as string
  minAmountOut: string;    // bigint as string
  deadline: number;        // unix timestamp
  nonce: number;
  sourceChainId: number;
  destChainId: number;
}

export interface SignedIntent {
  intent: Intent;
  signature: {
    v: number;
    r: string;
    s: string;
    full: string;
  };
}

export interface Quote {
  solverId: string;
  amountOut: string;       // bigint as string
  fee: string;             // solver fee in tokenIn (bigint as string)
  estimatedGas: string;
  latencyMs: number;
}

export interface SolverResult {
  solverId: string;
  quote: Quote | null;
  error?: string;
}

export interface IntentRecord {
  intentHash: string;
  intent: Intent;
  signature: {
    v: number;
    r: string;
    s: string;
  };
  status: "pending" | "filled" | "cancelled" | "expired";
  winnerSolverId?: string;
  winnerQuote?: Quote;
  allQuotes: Quote[];
  txHash?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type IntentStatus = IntentRecord["status"];
