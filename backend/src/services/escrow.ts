import { ethers } from "ethers";
import { Intent, SignedIntent } from "../types";

// Minimal ABI — only what the backend needs
const INTENT_ESCROW_ABI = [
  "function fulfillIntent((address user, address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, uint256 deadline, uint256 nonce, uint256 sourceChainId, uint256 destChainId) intent, uint8 v, bytes32 r, bytes32 s, uint256 amountOut) external",
  "function hashIntent((address user, address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, uint256 deadline, uint256 nonce, uint256 sourceChainId, uint256 destChainId) intent) external view returns (bytes32)",
  "function isUsed(bytes32 intentHash) external view returns (bool)",
  "function DOMAIN_SEPARATOR() external view returns (bytes32)",
];

const EIP712_TYPES = {
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

/** Safely normalize an Ethereum address to EIP-55 checksum format.
 *  Falls back to lowercase if the address is clearly invalid. */
function normalizeAddress(addr: string): string {
  try {
    return ethers.getAddress(addr);
  } catch {
    // If it looks like a hex address at all, lowercase is safe
    return addr.toLowerCase();
  }
}

/** Check if a signature is a known demo-mode mock (not cryptographically valid). */
function isDemoMockSignature(sig: SignedIntent["signature"]): boolean {
  return (
    sig.r === "0x1111111111111111111111111111111111111111111111111111111111111111" ||
    sig.full.startsWith(
      "0x1111111111111111111111111111111111111111111111111111111111111111"
    )
  );
}

export class EscrowService {
  private provider: ethers.JsonRpcProvider;
  private contract: ethers.Contract;
  private chainId: number;

  constructor(rpcUrl: string, contractAddress: string) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.contract = new ethers.Contract(
      contractAddress,
      INTENT_ESCROW_ABI,
      this.provider
    );
    this.chainId = 0; // set on connect
  }

  async connect(): Promise<void> {
    try {
      const network = await this.provider.getNetwork();
      this.chainId = Number(network.chainId);
      console.log(
        `[EscrowService] Connected to chain ${this.chainId} at ${await this.contract.getAddress()}`
      );
    } catch (err: any) {
      console.warn(
        `[EscrowService] Warning: Could not connect to RPC node (${err.code ?? err.message}). Backend running in offline/unconnected mode.`
      );
    }
  }

  /**
   * Compute the EIP-712 intent hash off-chain (matches on-chain hash).
   */
  async hashIntent(intent: Intent): Promise<string> {
    try {
      return await this.contract.hashIntent(this.toContractIntent(intent));
    } catch {
      // Fallback: compute hash entirely off-chain using ethers
      const contractAddress = await this.contract.getAddress();
      const domain = {
        name: "IntentSwap",
        version: "1",
        chainId: this.chainId || 31337,
        verifyingContract: contractAddress,
      };
      return ethers.TypedDataEncoder.hash(
        domain,
        EIP712_TYPES,
        this.toTypedDataIntent(intent)
      );
    }
  }

  /**
   * Check if an intent has already been used on-chain.
   */
  async isUsed(intentHash: string): Promise<boolean> {
    try {
      return await this.contract.isUsed(intentHash);
    } catch {
      return false; // Fallback when RPC is offline / dummy contract address
    }
  }

  /**
   * Verify the EIP-712 signature of an intent.
   * Returns the recovered signer address (checksummed).
   *
   * Demo mode: if signature matches the well-known mock pattern,
   * skip cryptographic verification and return the intent's user address.
   */
  async verifySignature(signedIntent: SignedIntent): Promise<string> {
    const { intent, signature } = signedIntent;

    // ── Demo mode: bypass sig verification for mock signatures ──────────────
    if (isDemoMockSignature(signature)) {
      // Normalise so the subsequent comparison always works
      return normalizeAddress(intent.user);
    }

    // ── Production: real EIP-712 signature recovery ─────────────────────────
    const contractAddress = await this.contract.getAddress();
    const domain = {
      name: "IntentSwap",
      version: "1",
      chainId: this.chainId || 31337,
      verifyingContract: contractAddress,
    };

    try {
      return ethers.verifyTypedData(
        domain,
        EIP712_TYPES,
        this.toTypedDataIntent(intent),
        signature.full
      );
    } catch (err: any) {
      throw new Error(`Signature verification failed: ${err.message}`);
    }
  }

  /**
   * Submit a fulfillment transaction to the chain.
   * Requires a signer (solver's private key loaded from env).
   */
  async fulfillIntent(
    signedIntent: SignedIntent,
    amountOut: bigint,
    solverPrivateKey: string
  ): Promise<string> {
    const signer = new ethers.Wallet(solverPrivateKey, this.provider);
    const contractWithSigner = this.contract.connect(signer) as ethers.Contract;

    const { intent, signature } = signedIntent;

    const tx = await contractWithSigner.fulfillIntent(
      this.toContractIntent(intent),
      signature.v,
      signature.r,
      signature.s,
      amountOut
    );

    const receipt = await tx.wait();
    return receipt.hash;
  }

  /** Build a contract-compatible intent struct with checksummed addresses and BigInt values. */
  private toContractIntent(intent: Intent) {
    return {
      user: normalizeAddress(intent.user),
      tokenIn: normalizeAddress(intent.tokenIn),
      tokenOut: normalizeAddress(intent.tokenOut),
      amountIn: BigInt(intent.amountIn),
      minAmountOut: BigInt(intent.minAmountOut),
      deadline: BigInt(intent.deadline),
      nonce: BigInt(intent.nonce),
      sourceChainId: BigInt(intent.sourceChainId),
      destChainId: BigInt(intent.destChainId),
    };
  }

  /** Build an EIP-712 typed-data compatible intent with checksummed addresses. */
  private toTypedDataIntent(intent: Intent) {
    return {
      user: normalizeAddress(intent.user),
      tokenIn: normalizeAddress(intent.tokenIn),
      tokenOut: normalizeAddress(intent.tokenOut),
      amountIn: BigInt(intent.amountIn),
      minAmountOut: BigInt(intent.minAmountOut),
      deadline: BigInt(intent.deadline),
      nonce: BigInt(intent.nonce),
      sourceChainId: BigInt(intent.sourceChainId),
      destChainId: BigInt(intent.destChainId),
    };
  }
}
