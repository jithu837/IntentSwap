import { ethers } from "ethers";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IntentParams {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minAmountOut: bigint;
  deadlineSeconds?: number; // defaults to 30 minutes
  sourceChainId?: number;   // defaults to current chain
  destChainId?: number;     // defaults to current chain
}

export interface Intent {
  user: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  minAmountOut: string;
  deadline: number;
  nonce: number;
  sourceChainId: number;
  destChainId: number;
}

export interface Signature {
  v: number;
  r: string;
  s: string;
  full: string;
}

export interface SignedIntent {
  intent: Intent;
  signature: Signature;
}

export interface IntentStatus {
  intentHash: string;
  status: "pending" | "filled" | "cancelled" | "expired";
  winnerSolverId?: string;
  winnerQuote?: {
    solverId: string;
    amountOut: string;
    fee: string;
    estimatedGas: string;
    latencyMs: number;
  };
  allQuotes: unknown[];
  txHash?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── EIP-712 domain & types ───────────────────────────────────────────────────

const INTENT_TYPES = {
  Intent: [
    { name: "user", type: "address" },
    { name: "tokenIn", type: "address" },
    { name: "tokenOut", type: "address" },
    { name: "amountIn", type: "uint256" },
    { name: "minAmountOut", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "sourceChainId", type: "uint256" },
    { name: "destChainId", type: "uint256" },
  ],
};

// ─── SDK class ────────────────────────────────────────────────────────────────

/**
 * IntentSwapSDK
 *
 * @example
 * ```ts
 * const sdk = new IntentSwapSDK({
 *   apiUrl: "https://api.intentswap.xyz",
 *   contractAddress: "0x...",
 *   signer: walletClient, // ethers v6 Signer
 * });
 *
 * const { signedIntent } = await sdk.createIntent({
 *   tokenIn: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",  // USDC
 *   tokenOut: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
 *   amountIn: parseUnits("1000", 6),
 *   minAmountOut: parseEther("0.35"),
 * });
 *
 * const result = await sdk.submitIntent(signedIntent);
 * ```
 */
export class IntentSwapSDK {
  private apiUrl: string;
  private contractAddress: string;
  private signer: ethers.Signer;
  private chainId?: number;

  constructor(options: {
    apiUrl: string;
    contractAddress: string;
    signer: ethers.Signer;
  }) {
    this.apiUrl = options.apiUrl.replace(/\/$/, "");
    this.contractAddress = options.contractAddress;
    this.signer = options.signer;
  }

  /**
   * Build and sign an intent locally (no network call).
   */
  async createIntent(params: IntentParams): Promise<SignedIntent> {
    const signer = this.signer;
    const userAddress = await signer.getAddress();

    // Resolve chain id
    if (!this.chainId) {
      const provider = signer.provider;
      if (!provider) throw new Error("Signer has no provider attached");
      const network = await provider.getNetwork();
      this.chainId = Number(network.chainId);
    }

    const chainId = this.chainId;
    const deadline =
      Math.floor(Date.now() / 1000) + (params.deadlineSeconds ?? 1800);

    // Fetch current nonce from API (or default to 0 for first intent)
    let nonce = 0;
    try {
      const res = await fetch(
        `${this.apiUrl}/api/intents?user=${userAddress}&limit=1`
      );
      if (res.ok) {
        const data = await res.json() as { data: { intent: { nonce: number } }[] };
        if (data.data.length > 0) {
          nonce = (data.data[0].intent.nonce ?? 0) + 1;
        }
      }
    } catch {
      // non-fatal: use nonce 0
    }

    const intent: Intent = {
      user: userAddress,
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      amountIn: params.amountIn.toString(),
      minAmountOut: params.minAmountOut.toString(),
      deadline,
      nonce,
      sourceChainId: params.sourceChainId ?? chainId,
      destChainId: params.destChainId ?? chainId,
    };

    // EIP-712 sign
    const domain = {
      name: "IntentSwap",
      version: "1",
      chainId,
      verifyingContract: this.contractAddress,
    };

    const typedDataSigner = signer as ethers.AbstractSigner & {
      signTypedData: typeof ethers.AbstractSigner.prototype.signTypedData;
    };

    const fullSig = await typedDataSigner.signTypedData(
      domain,
      INTENT_TYPES,
      {
        ...intent,
        amountIn: BigInt(intent.amountIn),
        minAmountOut: BigInt(intent.minAmountOut),
        deadline: BigInt(intent.deadline),
        nonce: BigInt(intent.nonce),
        sourceChainId: BigInt(intent.sourceChainId),
        destChainId: BigInt(intent.destChainId),
      }
    );

    const sig = ethers.Signature.from(fullSig);
    const signature: Signature = {
      v: sig.v,
      r: sig.r,
      s: sig.s,
      full: fullSig,
    };

    return { intent, signature };
  }

  /**
   * Submit a signed intent to the backend API.
   * The backend will run the solver auction and return quotes.
   */
  async submitIntent(signedIntent: SignedIntent): Promise<IntentStatus> {
    const res = await fetch(`${this.apiUrl}/api/intents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(signedIntent),
    });

    if (!res.ok) {
      const err = await res.json() as { error?: string };
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }

    const data = await res.json() as { data: IntentStatus };
    return data.data;
  }

  /**
   * Poll for the status of a submitted intent.
   */
  async getStatus(intentHash: string): Promise<IntentStatus | null> {
    const res = await fetch(`${this.apiUrl}/api/intents/${intentHash}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as { data: IntentStatus };
    return data.data;
  }

  /**
   * Subscribe to live intent updates via WebSocket.
   * Returns an unsubscribe function.
   */
  subscribeToUpdates(
    userAddress: string,
    onMessage: (msg: unknown) => void
  ): () => void {
    const wsUrl = this.apiUrl
      .replace(/^https/, "wss")
      .replace(/^http/, "ws");

    const ws = new WebSocket(`${wsUrl}/ws?user=${userAddress}`);

    ws.onmessage = (event) => {
      try {
        onMessage(JSON.parse(event.data as string));
      } catch {
        // ignore
      }
    };

    ws.onerror = (err) => {
      console.error("[IntentSwapSDK] WebSocket error:", err);
    };

    // Heartbeat
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "PING" }));
      }
    }, 30_000);

    return () => {
      clearInterval(pingInterval);
      ws.close();
    };
  }
}

// Re-export ethers utils that are commonly needed
export { ethers };
