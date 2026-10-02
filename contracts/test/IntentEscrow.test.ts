import { ethers } from "hardhat";
import { expect } from "chai";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { IntentEscrow, MockERC20 } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// ─── EIP-712 helpers ─────────────────────────────────────────────────────────

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

interface IntentData {
  user: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minAmountOut: bigint;
  deadline: bigint;
  nonce: bigint;
  sourceChainId: bigint;
  destChainId: bigint;
}

async function signIntent(
  signer: HardhatEthersSigner,
  escrow: IntentEscrow,
  intent: IntentData
) {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const domain = {
    name: "IntentSwap",
    version: "1",
    chainId,
    verifyingContract: await escrow.getAddress(),
  };
  const sig = await signer.signTypedData(domain, INTENT_TYPES, intent);
  return ethers.Signature.from(sig);
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe("IntentEscrow", function () {
  let escrow: IntentEscrow;
  let tokenIn: MockERC20;
  let tokenOut: MockERC20;
  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let solver: HardhatEthersSigner;
  let chainId: bigint;

  const AMOUNT_IN = ethers.parseEther("100");
  const AMOUNT_OUT = ethers.parseEther("95");
  const MIN_AMOUNT_OUT = ethers.parseEther("90");
  const FEE_BPS = 30n; // 0.30%

  beforeEach(async () => {
    [owner, user, solver] = await ethers.getSigners();
    chainId = (await ethers.provider.getNetwork()).chainId;

    // Deploy tokens
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    tokenIn = (await MockERC20Factory.deploy("TokenA", "TKA")) as MockERC20;
    tokenOut = (await MockERC20Factory.deploy("TokenB", "TKB")) as MockERC20;

    // Deploy escrow
    const EscrowFactory = await ethers.getContractFactory("IntentEscrow");
    escrow = (await EscrowFactory.deploy(FEE_BPS)) as IntentEscrow;

    // Fund user with tokenIn
    await tokenIn.mint(user.address, AMOUNT_IN);
    await tokenIn.connect(user).approve(await escrow.getAddress(), AMOUNT_IN);

    // Fund solver with tokenOut
    await tokenOut.mint(solver.address, AMOUNT_OUT);
    await tokenOut.connect(solver).approve(await escrow.getAddress(), AMOUNT_OUT);
  });

  function makeIntent(overrides: Partial<IntentData> = {}): IntentData {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    return {
      user: user.address,
      tokenIn: tokenIn.target as string,
      tokenOut: tokenOut.target as string,
      amountIn: AMOUNT_IN,
      minAmountOut: MIN_AMOUNT_OUT,
      deadline,
      nonce: 0n,
      sourceChainId: chainId,
      destChainId: chainId,
      ...overrides,
    };
  }

  // ── Happy path ──────────────────────────────────────────────────────────────

  describe("fulfillIntent", () => {
    it("transfers tokenIn to solver (minus fee) and tokenOut to user", async () => {
      const intent = makeIntent();
      const sig = await signIntent(user, escrow, intent);

      const userOutBefore = await tokenOut.balanceOf(user.address);
      const solverInBefore = await tokenIn.balanceOf(solver.address);

      await escrow.connect(solver).fulfillIntent(intent, sig.v, sig.r, sig.s, AMOUNT_OUT);

      const fee = (AMOUNT_IN * FEE_BPS) / 10_000n;
      expect(await tokenIn.balanceOf(solver.address)).to.equal(
        solverInBefore + AMOUNT_IN - fee
      );
      expect(await tokenOut.balanceOf(user.address)).to.equal(
        userOutBefore + AMOUNT_OUT
      );
      expect(await escrow.feeReserves(await tokenIn.getAddress())).to.equal(fee);
    });

    it("emits IntentFulfilled event", async () => {
      const intent = makeIntent();
      const sig = await signIntent(user, escrow, intent);
      const intentHash = await escrow.hashIntent(intent);

      await expect(
        escrow.connect(solver).fulfillIntent(intent, sig.v, sig.r, sig.s, AMOUNT_OUT)
      )
        .to.emit(escrow, "IntentFulfilled")
        .withArgs(
          intentHash,
          user.address,
          solver.address,
          await tokenIn.getAddress(),
          await tokenOut.getAddress(),
          AMOUNT_IN,
          AMOUNT_OUT
        );
    });

    it("marks intent as used after fulfillment", async () => {
      const intent = makeIntent();
      const sig = await signIntent(user, escrow, intent);
      const intentHash = await escrow.hashIntent(intent);

      await escrow.connect(solver).fulfillIntent(intent, sig.v, sig.r, sig.s, AMOUNT_OUT);
      expect(await escrow.isUsed(intentHash)).to.be.true;
    });
  });

  // ── Replay protection ───────────────────────────────────────────────────────

  describe("replay protection", () => {
    it("reverts on double-spend of same intent", async () => {
      const intent = makeIntent();
      const sig = await signIntent(user, escrow, intent);

      // Fund solver for second attempt
      await tokenOut.mint(solver.address, AMOUNT_OUT);
      await tokenOut.connect(solver).approve(await escrow.getAddress(), AMOUNT_OUT * 2n);
      await tokenIn.mint(user.address, AMOUNT_IN);
      await tokenIn.connect(user).approve(await escrow.getAddress(), AMOUNT_IN * 2n);

      await escrow.connect(solver).fulfillIntent(intent, sig.v, sig.r, sig.s, AMOUNT_OUT);

      await expect(
        escrow.connect(solver).fulfillIntent(intent, sig.v, sig.r, sig.s, AMOUNT_OUT)
      ).to.be.revertedWithCustomError(escrow, "IntentAlreadyUsed");
    });
  });

  // ── Signature validation ────────────────────────────────────────────────────

  describe("signature validation", () => {
    it("reverts if signed by wrong account", async () => {
      const intent = makeIntent();
      // solver signs instead of user
      const sig = await signIntent(solver, escrow, intent);

      await expect(
        escrow.connect(solver).fulfillIntent(intent, sig.v, sig.r, sig.s, AMOUNT_OUT)
      ).to.be.revertedWithCustomError(escrow, "InvalidSignature");
    });
  });

  // ── Deadline ────────────────────────────────────────────────────────────────

  describe("deadline", () => {
    it("reverts if intent is expired", async () => {
      const pastDeadline = BigInt(Math.floor(Date.now() / 1000) - 1);
      const intent = makeIntent({ deadline: pastDeadline });
      const sig = await signIntent(user, escrow, intent);

      await expect(
        escrow.connect(solver).fulfillIntent(intent, sig.v, sig.r, sig.s, AMOUNT_OUT)
      ).to.be.revertedWithCustomError(escrow, "IntentExpired");
    });

    it("reverts after time.increase past deadline", async () => {
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 60); // 60s from now
      const intent = makeIntent({ deadline });
      const sig = await signIntent(user, escrow, intent);

      await time.increase(120); // fast-forward 2 minutes

      await expect(
        escrow.connect(solver).fulfillIntent(intent, sig.v, sig.r, sig.s, AMOUNT_OUT)
      ).to.be.revertedWithCustomError(escrow, "IntentExpired");
    });
  });

  // ── Slippage ────────────────────────────────────────────────────────────────

  describe("slippage", () => {
    it("reverts if amountOut < minAmountOut", async () => {
      const intent = makeIntent();
      const sig = await signIntent(user, escrow, intent);
      const tooLow = MIN_AMOUNT_OUT - 1n;

      await expect(
        escrow.connect(solver).fulfillIntent(intent, sig.v, sig.r, sig.s, tooLow)
      ).to.be.revertedWithCustomError(escrow, "SlippageExceeded");
    });
  });

  // ── Chain ID guard ──────────────────────────────────────────────────────────

  describe("chain guard", () => {
    it("reverts if sourceChainId doesn't match block.chainid", async () => {
      const intent = makeIntent({ sourceChainId: 999n });
      const sig = await signIntent(user, escrow, intent);

      await expect(
        escrow.connect(solver).fulfillIntent(intent, sig.v, sig.r, sig.s, AMOUNT_OUT)
      ).to.be.revertedWithCustomError(escrow, "WrongChain");
    });
  });

  // ── Cancel ──────────────────────────────────────────────────────────────────

  describe("cancelIntent", () => {
    it("marks intent as used and increments nonce", async () => {
      const intent = makeIntent();
      const intentHash = await escrow.hashIntent(intent);

      await escrow.connect(user).cancelIntent(intent);

      expect(await escrow.isUsed(intentHash)).to.be.true;
      expect(await escrow.nonces(user.address)).to.equal(1n);
    });

    it("prevents solver from fulfilling a cancelled intent", async () => {
      const intent = makeIntent();
      await escrow.connect(user).cancelIntent(intent);
      const sig = await signIntent(user, escrow, intent);

      await expect(
        escrow.connect(solver).fulfillIntent(intent, sig.v, sig.r, sig.s, AMOUNT_OUT)
      ).to.be.revertedWithCustomError(escrow, "IntentAlreadyUsed");
    });
  });

  // ── Admin ───────────────────────────────────────────────────────────────────

  describe("admin", () => {
    it("owner can update feeBps", async () => {
      await escrow.connect(owner).setFeeBps(50n);
      expect(await escrow.feeBps()).to.equal(50n);
    });

    it("reverts setFeeBps if bps > 1000", async () => {
      await expect(
        escrow.connect(owner).setFeeBps(1001n)
      ).to.be.revertedWithCustomError(escrow, "FeeTooHigh");
    });

    it("owner can withdraw accumulated fees", async () => {
      const intent = makeIntent();
      const sig = await signIntent(user, escrow, intent);
      await escrow.connect(solver).fulfillIntent(intent, sig.v, sig.r, sig.s, AMOUNT_OUT);

      const fee = (AMOUNT_IN * FEE_BPS) / 10_000n;
      const ownerBefore = await tokenIn.balanceOf(owner.address);

      await escrow.connect(owner).withdrawFees(await tokenIn.getAddress(), owner.address);

      expect(await tokenIn.balanceOf(owner.address)).to.equal(ownerBefore + fee);
      expect(await escrow.feeReserves(await tokenIn.getAddress())).to.equal(0n);
    });
  });
});
