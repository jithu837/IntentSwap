/**
 * Intent processing service — orchestrates the full lifecycle:
 *   submit → verify sig → run solver auction → store → (optionally) settle on-chain
 */

import { IntentModel } from "../db/models/Intent";
import { runSolverAuction } from "../solvers/engine";
import { EscrowService } from "./escrow";
import { SignedIntent, IntentRecord, Quote } from "../types";
import { broadcastToSubscribers } from "../websocket/server";

export class IntentService {
  constructor(private escrow: EscrowService) {}

  /**
   * Process a submitted intent:
   * 1. Verify signature
   * 2. Check not already used on-chain
   * 3. Run solver auction
   * 4. Persist to DB
   * 5. Broadcast result via WebSocket
   */
  async processIntent(signedIntent: SignedIntent): Promise<IntentRecord> {
    const { intent, signature } = signedIntent;

    // ── 1. Verify signature ───────────────────────────────────────────────────
    const recoveredSigner = await this.escrow.verifySignature(signedIntent);
    if (recoveredSigner.toLowerCase() !== intent.user.toLowerCase()) {
      throw new Error(
        `Signature mismatch: expected ${intent.user}, got ${recoveredSigner}`
      );
    }

    // ── 2. Check deadline ─────────────────────────────────────────────────────
    if (Math.floor(Date.now() / 1000) > intent.deadline) {
      throw new Error("Intent deadline has already passed");
    }

    // ── 3. Compute hash & check on-chain ─────────────────────────────────────
    const intentHash = await this.escrow.hashIntent(intent);
    const alreadyUsed = await this.escrow.isUsed(intentHash);
    if (alreadyUsed) {
      throw new Error("Intent has already been used or cancelled on-chain");
    }

    // Check DB for duplicate
    const existing = await IntentModel.findOne({ intentHash });
    if (existing) {
      return existing.toObject() as unknown as IntentRecord;
    }

    // ── 4. Run solver auction ─────────────────────────────────────────────────
    const { winner, allQuotes } = await runSolverAuction(intent);

    const status =
      winner === null
        ? "expired" // no solver could fill
        : "pending"; // winner selected, awaiting on-chain settlement

    // ── 5. Persist ────────────────────────────────────────────────────────────
    const record = await IntentModel.create({
      intentHash,
      intent,
      signature: { v: signature.v, r: signature.r, s: signature.s },
      status,
      winnerSolverId: winner?.solverId,
      winnerQuote: winner ?? undefined,
      allQuotes,
    });

    const plain = record.toObject() as unknown as IntentRecord;

    // ── 6. Broadcast via WebSocket ────────────────────────────────────────────
    broadcastToSubscribers(intent.user.toLowerCase(), {
      type: "INTENT_QUOTED",
      intentHash,
      status,
      winner,
      allQuotes,
    });

    return plain;
  }

  async getIntent(intentHash: string): Promise<IntentRecord | null> {
    const doc = await IntentModel.findOne({ intentHash });
    return doc ? (doc.toObject() as unknown as IntentRecord) : null;
  }

  async getIntentsByUser(
    user: string,
    limit = 20,
    skip = 0
  ): Promise<IntentRecord[]> {
    const docs = await IntentModel.find({ "intent.user": user.toLowerCase() })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);
    return docs.map((d) => d.toObject() as unknown as IntentRecord);
  }

  /**
   * Mark expired intents in the DB (run periodically).
   */
  async sweepExpiredIntents(): Promise<number> {
    const nowSec = Math.floor(Date.now() / 1000);
    const result = await IntentModel.updateMany(
      { status: "pending", "intent.deadline": { $lt: nowSec } },
      { $set: { status: "expired" } }
    );
    return result.modifiedCount;
  }
}
