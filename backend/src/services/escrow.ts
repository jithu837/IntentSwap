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
    const network = await this.provider.getNetwork();
    this.chainId = Number(network.chainId);
    console.log(
      `[EscrowService] Connected to chain ${this.chainId} at ${await this.contract.getAddress()}`
    );
  }

  /**
   * Compute the EIP-712 intent hash off-chain (matches on-chain hash).
   */
  async hashIntent(intent: Intent): Promise<string> {
    return this.contract.hashIntent(this.toContractIntent(intent));
  }

  /**
   * Check if an intent has already been used on-chain.
   */
  async isUsed(intentHash: string): Promise<boolean> {
    return this.contract.isUsed(intentHash);
  }

  /**
   * Verify the EIP-712 signature of an intent.
   * Returns the recovered signer address.
   */
  async verifySignature(signedIntent: SignedIntent): Promise<string> {
    const { intent, signature } = signedIntent;
    const contractAddress = await this.contract.getAddress();

    const domain = {
      name: "IntentSwap",
      version: "1",
      chainId: this.chainId,
      verifyingContract: contractAddress,
    };

    const recovered = ethers.verifyTypedData(
      domain,
      EIP712_TYPES,
      this.toTypedDataIntent(intent),
      signature.full
    );

    return recovered;
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

  private toContractIntent(intent: Intent) {
    return {
      user: intent.user,
      tokenIn: intent.tokenIn,
      tokenOut: intent.tokenOut,
      amountIn: BigInt(intent.amountIn),
      minAmountOut: BigInt(intent.minAmountOut),
      deadline: BigInt(intent.deadline),
      nonce: BigInt(intent.nonce),
      sourceChainId: BigInt(intent.sourceChainId),
      destChainId: BigInt(intent.destChainId),
    };
  }

  private toTypedDataIntent(intent: Intent) {
    return {
      user: intent.user,
      tokenIn: intent.tokenIn,
      tokenOut: intent.tokenOut,
      amountIn: BigInt(intent.amountIn),
      minAmountOut: BigInt(intent.minAmountOut),
      deadline: BigInt(intent.deadline),
      nonce: BigInt(intent.nonce),
      sourceChainId: BigInt(intent.sourceChainId),
      destChainId: BigInt(intent.destChainId),
    };
  }
}
