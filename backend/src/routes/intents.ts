import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { IntentService } from "../services/intentService";

// ─── Zod validation schemas ───────────────────────────────────────────────────

const IntentSchema = z.object({
  user: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Invalid Ethereum address"),
  tokenIn: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  tokenOut: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  amountIn: z.string().regex(/^\d+$/, "Must be a positive integer string"),
  minAmountOut: z.string().regex(/^\d+$/),
  deadline: z.number().int().positive(),
  nonce: z.number().int().min(0),
  sourceChainId: z.number().int().positive(),
  destChainId: z.number().int().positive(),
});

const SignatureSchema = z.object({
  v: z.number().int().min(27).max(28),
  r: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  s: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  full: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});

const SubmitIntentSchema = z.object({
  intent: IntentSchema,
  signature: SignatureSchema,
});

// ─── Router factory ───────────────────────────────────────────────────────────

export function createIntentRouter(intentService: IntentService): Router {
  const router = Router();

  /**
   * POST /api/intents
   * Submit a signed intent. Triggers solver auction immediately.
   */
  router.post(
    "/",
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const parsed = SubmitIntentSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: "Validation failed",
            details: parsed.error.flatten(),
          });
          return;
        }

        const record = await intentService.processIntent(parsed.data);
        res.status(201).json({ success: true, data: record });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Unknown error";
        // Signature errors → 400, everything else → 500
        const status = message.includes("Signature") || message.includes("deadline") || message.includes("used")
          ? 400
          : 500;
        res.status(status).json({ error: message });
      }
    }
  );

  /**
   * GET /api/intents/:hash
   * Get a specific intent by its EIP-712 hash.
   */
  router.get(
    "/:hash",
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const record = await intentService.getIntent(req.params.hash);
        if (!record) {
          res.status(404).json({ error: "Intent not found" });
          return;
        }
        res.json({ success: true, data: record });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * GET /api/intents?user=0x...&limit=20&skip=0
   * List intents for a specific user.
   */
  router.get(
    "/",
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const user = req.query.user as string;
        if (!user || !/^0x[0-9a-fA-F]{40}$/i.test(user)) {
          res.status(400).json({ error: "Invalid or missing user address" });
          return;
        }

        const limit = Math.min(Number(req.query.limit ?? 20), 100);
        const skip = Number(req.query.skip ?? 0);

        const records = await intentService.getIntentsByUser(user, limit, skip);
        res.json({ success: true, data: records, count: records.length });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
