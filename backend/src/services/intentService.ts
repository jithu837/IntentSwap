/**
 * Intent processing service — orchestrates the full lifecycle:
 *   submit → verify sig → run solver auction → store → settle on-chain → broadcast
 */

import { IntentModel } from "../db/models/Intent";
import { runSolverAuction } from "../solvers/engine";
import { EscrowService } from "./escrow";
import { SignedIntent, IntentRecord, Quote } from "../types";
import { broadcastToSubscribers } from "../websocket/server";

export class IntentService {
  constructor(private escrow: EscrowService) {}

  /**
   * Process a submitted intent end-to-end:
   * 1. Verify EIP-712 signature
   * 2. Check deadline & on-chain state
   * 3. Run solver auction (parallel)
   * 4. Persist to DB
   * 5. Attempt on-chain settlement (if SOLVER_PRIVATE_KEY is set)
   * 6. Broadcast result via WebSocket
   */
  async processIntent(signedIntent: SignedIntent): Promise<IntentRecord> {
    const { intent, signature } = signedIntent;

    // ── 1. Verify signature ─────────────────────────────────────────────────
    const recoveredSigner = await this.escrow.verifySignature(signedIntent);
    if (recoveredSigner.toLowerCase() !== intent.user.toLowerCase()) {
      throw new Error(
        `Signature mismatch: expected ${intent.user}, got ${recoveredSigner}`
      );
    }

    // ── 2. Check deadline ───────────────────────────────────────────────────
    if (Math.floor(Date.now() / 1000) > intent.deadline) {
      throw new Error("Intent deadline has already passed");
    }

    // ── 3. Compute hash & check on-chain ────────────────────────────────────
    const intentHash = await this.escrow.hashIntent(intent);
    const alreadyUsed = await this.escrow.isUsed(intentHash);
    if (alreadyUsed) {
      throw new Error("Intent has already been used or cancelled on-chain");
    }

    // Check DB for duplicate (idempotency)
    const existing = await IntentModel.findOne({ intentHash });
    if (existing) {
      return existing.toObject() as unknown as IntentRecord;
    }

    // ── 4. Run solver auction ────────────────────────────────────────────────
    const { winner, allQuotes } = await runSolverAuction(intent);

    const status =
      winner === null
        ? "expired" // no solver could fill
        : "pending"; // winner selected, attempting settlement

    // ── 5. Persist initial record ────────────────────────────────────────────
    const record = await IntentModel.create({
      intentHash,
      intent,
      signature: { v: signature.v, r: signature.r, s: signature.s },
      status,
      winnerSolverId: winner?.solverId,
      winnerQuote: winner ?? undefined,
      allQuotes,
    });

    let plain = record.toObject() as unknown as IntentRecord;

    // ── 6. Attempt on-chain settlement ──────────────────────────────────────
    if (winner && process.env.SOLVER_PRIVATE_KEY) {
      try {
        const amountOut = BigInt(winner.amountOut);
        const txHash = await this.escrow.fulfillIntent(
          signedIntent,
          amountOut,
          process.env.SOLVER_PRIVATE_KEY
        );

        // Update DB with tx hash and filled status
        await IntentModel.findOneAndUpdate(
          { intentHash },
          { $set: { status: "filled", txHash } }
        );

        plain = { ...plain, status: "filled", txHash } as IntentRecord;
        console.log(
          `[IntentService] On-chain settlement successful. txHash: ${txHash}`
        );
      } catch (settlementErr: any) {
        // Settlement is best-effort — don't fail the whole request
        console.warn(
          `[IntentService] On-chain settlement skipped (offline/demo mode): ${
            settlementErr.message ?? settlementErr
          }`
        );
      }
    } else if (winner && !process.env.SOLVER_PRIVATE_KEY) {
      console.log(
        "[IntentService] SOLVER_PRIVATE_KEY not set — skipping on-chain settlement (demo mode)"
      );
    }

    // ── 7. Broadcast via WebSocket ───────────────────────────────────────────
    broadcastToSubscribers(intent.user.toLowerCase(), {
      type: "INTENT_QUOTED",
      intentHash,
      status: plain.status,
      winner,
      allQuotes,
      txHash: (plain as any).txHash,
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
