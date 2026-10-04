import "dotenv/config";
import http from "http";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import mongoose from "mongoose";

import { createIntentRouter } from "./routes/intents";
import { errorHandler, notFound } from "./middleware/errorHandler";
import { initWebSocketServer } from "./websocket/server";
import { EscrowService } from "./services/escrow";
import { IntentService } from "./services/intentService";

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 4000);
const MONGO_URI =
  process.env.MONGODB_URI ?? process.env.MONGO_URI ?? "mongodb://localhost:27017/intentswap";
const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const CONTRACT_ADDRESS =
  process.env.CONTRACT_ADDRESS ?? "0x0000000000000000000000000000000000000000";
const FRONTEND_URL = process.env.FRONTEND_URL ?? process.env.CORS_ORIGIN ?? "*";

// ─── App setup ────────────────────────────────────────────────────────────────

const app = express();

// Security
app.use(helmet());
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, server-to-server)
      if (!origin) return callback(null, true);
      // Allow localhost on any port in development
      if (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")) {
        return callback(null, true);
      }
      if (FRONTEND_URL === "*" || origin === FRONTEND_URL) {
        return callback(null, true);
      }
      callback(null, true); // Permissive in dev mode
    },
    methods: ["GET", "POST"],
  })
);

// Rate limiting
app.use(
  "/api",
  rateLimit({
    windowMs: 60_000, // 1 minute
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." },
  })
);

app.use(express.json({ limit: "50kb" }));

// ─── Health check ─────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    mongo: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    chain: RPC_URL,
    contract: CONTRACT_ADDRESS,
    timestamp: new Date().toISOString(),
  });
});

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap() {
  // 1. Connect to MongoDB with event listeners for reconnection
  mongoose.connection.on("disconnected", () => {
    console.warn("[DB] MongoDB disconnected! Attempting reconnect...");
  });
  mongoose.connection.on("reconnected", () => {
    console.log("[DB] MongoDB reconnected successfully.");
  });
  mongoose.connection.on("error", (err) => {
    console.error("[DB] MongoDB connection error:", err);
  });

  await mongoose.connect(MONGO_URI);
  console.log("[DB] MongoDB connected:", MONGO_URI);

  // 2. Connect to chain
  const escrow = new EscrowService(RPC_URL, CONTRACT_ADDRESS);
  await escrow.connect();

  // 3. Wire services
  const intentService = new IntentService(escrow);

  // 4. Mount routes
  app.use("/api/intents", createIntentRouter(intentService));
  app.use(notFound);
  app.use(errorHandler);

  // 5. Start HTTP server
  const server = http.createServer(app);
  initWebSocketServer(server);

  // 6. Periodic expiry sweep (every 60s)
  setInterval(async () => {
    const count = await intentService.sweepExpiredIntents();
    if (count > 0) console.log(`[Sweep] Marked ${count} intents as expired`);
  }, 60_000);

  server.listen(PORT, () => {
    console.log(`[Server] HTTP + WS listening on http://localhost:${PORT}`);
    console.log(`[Server] WebSocket endpoint: ws://localhost:${PORT}/ws?user=0x...`);
  });

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    console.log("[Server] SIGTERM received, shutting down...");
    server.close();
    await mongoose.disconnect();
    process.exit(0);
  });
}

bootstrap().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
