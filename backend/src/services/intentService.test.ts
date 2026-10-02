/**
 * Unit tests for IntentService
 *
 * All external dependencies (EscrowService, MongoDB, WebSocket) are mocked
 * so no live infrastructure is required.
 */

import { IntentService } from "../services/intentService";
import { EscrowService } from "../services/escrow";
import { IntentModel } from "../db/models/Intent";
import * as engine from "../solvers/engine";
import * as wsServer from "../websocket/server";
import { SignedIntent, Quote } from "../types";

// ─── Mock heavy deps ──────────────────────────────────────────────────────────

jest.mock("../db/models/Intent");
jest.mock("../solvers/engine");
jest.mock("../websocket/server");
jest.mock("../services/escrow");

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MOCK_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const MOCK_TOKEN_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MOCK_TOKEN_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MOCK_HASH =
  "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

function makeSignedIntent(overrides: Partial<SignedIntent["intent"]> = {}): SignedIntent {
  return {
    intent: {
      user: MOCK_ADDRESS,
      tokenIn: MOCK_TOKEN_A,
      tokenOut: MOCK_TOKEN_B,
      amountIn: "1000000000000000000",
      minAmountOut: "900000000000000000",
      deadline: Math.floor(Date.now() / 1000) + 3600,
      nonce: 0,
      sourceChainId: 31337,
      destChainId: 31337,
      ...overrides,
    },
    signature: {
      v: 28,
      r: "0x" + "a".repeat(64),
      s: "0x" + "b".repeat(64),
      full: "0x" + "c".repeat(130),
    },
  };
}

function makeQuote(overrides: Partial<Quote> = {}): Quote {
  return {
    solverId: "gamma-bot",
    amountOut: "960000000000000000",
    fee: "1000000000000000",
    estimatedGas: "42000000000000",
    latencyMs: 310,
    ...overrides,
  };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

let service: IntentService;
let mockEscrow: jest.Mocked<EscrowService>;

beforeEach(() => {
  jest.clearAllMocks();

  mockEscrow = new EscrowService("", "") as jest.Mocked<EscrowService>;
  mockEscrow.verifySignature = jest.fn().mockResolvedValue(MOCK_ADDRESS);
  mockEscrow.hashIntent = jest.fn().mockResolvedValue(MOCK_HASH);
  mockEscrow.isUsed = jest.fn().mockResolvedValue(false);

  service = new IntentService(mockEscrow);

  // Default: no existing record
  (IntentModel.findOne as jest.Mock).mockResolvedValue(null);

  // Default auction result
  const winner = makeQuote();
  (engine.runSolverAuction as jest.Mock).mockResolvedValue({
    winner,
    allQuotes: [winner],
    results: [{ solverId: "gamma-bot", quote: winner }],
  });

  // IntentModel.create returns a doc with toObject()
  const fakeRecord = {
    intentHash: MOCK_HASH,
    status: "pending",
    winnerSolverId: "gamma-bot",
    winnerQuote: makeQuote(),
    allQuotes: [makeQuote()],
    toObject: () => ({
      intentHash: MOCK_HASH,
      status: "pending",
      winnerSolverId: "gamma-bot",
      winnerQuote: makeQuote(),
      allQuotes: [makeQuote()],
    }),
  };
  (IntentModel.create as jest.Mock).mockResolvedValue(fakeRecord);

  (wsServer.broadcastToSubscribers as jest.Mock).mockImplementation(() => {});
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("IntentService.processIntent", () => {
  it("verifies the signature and calls the auction", async () => {
    const signedIntent = makeSignedIntent();
    await service.processIntent(signedIntent);

    expect(mockEscrow.verifySignature).toHaveBeenCalledWith(signedIntent);
    expect(engine.runSolverAuction).toHaveBeenCalledWith(signedIntent.intent);
  });

  it("throws if signature signer doesn't match intent.user", async () => {
    mockEscrow.verifySignature = jest
      .fn()
      .mockResolvedValue("0xDeadBeef0000000000000000000000000000DEAD");

    await expect(
      service.processIntent(makeSignedIntent())
    ).rejects.toThrow(/Signature mismatch/);
  });

  it("throws if deadline has passed", async () => {
    const expired = makeSignedIntent({ deadline: Math.floor(Date.now() / 1000) - 10 });

    await expect(service.processIntent(expired)).rejects.toThrow(
      /deadline/i
    );
  });

  it("throws if intent already used on-chain", async () => {
    mockEscrow.isUsed = jest.fn().mockResolvedValue(true);

    await expect(
      service.processIntent(makeSignedIntent())
    ).rejects.toThrow(/already been used/);
  });

  it("returns existing record without running auction on duplicate", async () => {
    const existing = { intentHash: MOCK_HASH, status: "pending", toObject: () => ({ intentHash: MOCK_HASH, status: "pending" }) };
    (IntentModel.findOne as jest.Mock).mockResolvedValue(existing);

    const result = await service.processIntent(makeSignedIntent());

    expect(result.intentHash).toBe(MOCK_HASH);
    expect(engine.runSolverAuction).not.toHaveBeenCalled();
  });

  it("broadcasts a WebSocket message after successful processing", async () => {
    await service.processIntent(makeSignedIntent());

    expect(wsServer.broadcastToSubscribers).toHaveBeenCalledWith(
      MOCK_ADDRESS.toLowerCase(),
      expect.objectContaining({ type: "INTENT_QUOTED" })
    );
  });

  it("returns status=expired when no solver can fill", async () => {
    (engine.runSolverAuction as jest.Mock).mockResolvedValue({
      winner: null,
      allQuotes: [],
      results: [],
    });

    // Update mock to capture passed status
    let capturedStatus: string | undefined;
    (IntentModel.create as jest.Mock).mockImplementation(async (doc) => {
      capturedStatus = doc.status;
      return {
        ...doc,
        toObject: () => ({ ...doc }),
      };
    });

    await service.processIntent(makeSignedIntent());
    expect(capturedStatus).toBe("expired");
  });

  it("persists the record with correct intentHash", async () => {
    await service.processIntent(makeSignedIntent());

    expect(IntentModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ intentHash: MOCK_HASH })
    );
  });
});

describe("IntentService.getIntent", () => {
  it("returns null for unknown hash", async () => {
    (IntentModel.findOne as jest.Mock).mockResolvedValue(null);
    const result = await service.getIntent("0xunknown");
    expect(result).toBeNull();
  });

  it("returns plain object for known hash", async () => {
    const fakeDoc = {
      intentHash: MOCK_HASH,
      toObject: () => ({ intentHash: MOCK_HASH }),
    };
    (IntentModel.findOne as jest.Mock).mockResolvedValue(fakeDoc);

    const result = await service.getIntent(MOCK_HASH);
    expect(result?.intentHash).toBe(MOCK_HASH);
  });
});

describe("IntentService.sweepExpiredIntents", () => {
  it("calls updateMany with correct filter", async () => {
    (IntentModel.updateMany as jest.Mock).mockResolvedValue({ modifiedCount: 3 });

    const count = await service.sweepExpiredIntents();
    expect(count).toBe(3);
    expect(IntentModel.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ status: "pending" }),
      expect.objectContaining({ $set: { status: "expired" } })
    );
  });
});
