import mongoose, { Schema, Document } from "mongoose";
import { IntentRecord } from "../../types";

export type IntentDocument = IntentRecord & Document;

const QuoteSchema = new Schema(
  {
    solverId: { type: String, required: true },
    amountOut: { type: String, required: true },
    fee: { type: String, required: true },
    estimatedGas: { type: String, required: true },
    latencyMs: { type: Number, required: true },
  },
  { _id: false }
);

const SignatureSchema = new Schema(
  {
    v: { type: Number, required: true },
    r: { type: String, required: true },
    s: { type: String, required: true },
  },
  { _id: false }
);

const IntentSchema = new Schema(
  {
    user: { type: String, required: true, lowercase: true },
    tokenIn: { type: String, required: true, lowercase: true },
    tokenOut: { type: String, required: true, lowercase: true },
    amountIn: { type: String, required: true },
    minAmountOut: { type: String, required: true },
    deadline: { type: Number, required: true },
    nonce: { type: Number, required: true },
    sourceChainId: { type: Number, required: true },
    destChainId: { type: Number, required: true },
  },
  { _id: false }
);

const IntentRecordSchema = new Schema<IntentDocument>(
  {
    intentHash: { type: String, required: true, unique: true, index: true },
    intent: { type: IntentSchema, required: true },
    signature: { type: SignatureSchema, required: true },
    status: {
      type: String,
      enum: ["pending", "filled", "cancelled", "expired"],
      default: "pending",
      index: true,
    },
    winnerSolverId: { type: String },
    winnerQuote: { type: QuoteSchema },
    allQuotes: { type: [QuoteSchema], default: [] },
    txHash: { type: String },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Compound index for efficient user queries
IntentRecordSchema.index({ "intent.user": 1, createdAt: -1 });
IntentRecordSchema.index({ status: 1, "intent.deadline": 1 });

export const IntentModel = mongoose.model<IntentDocument>(
  "Intent",
  IntentRecordSchema
);
