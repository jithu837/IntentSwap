import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage, Server } from "http";

// user address (lowercase) → Set of active WebSocket connections
const subscriptions = new Map<string, Set<WebSocket>>();

let wss: WebSocketServer;

export function initWebSocketServer(server: Server): void {
  wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    // Expect: ws://host/ws?user=0x...
    const url = new URL(req.url ?? "", `http://${req.headers.host}`);
    const user = url.searchParams.get("user")?.toLowerCase();

    if (!user || !user.startsWith("0x")) {
      ws.close(1008, "Missing or invalid user query param");
      return;
    }

    // Register subscription
    if (!subscriptions.has(user)) {
      subscriptions.set(user, new Set());
    }
    subscriptions.get(user)!.add(ws);
    console.log(`[WS] ${user} connected. Total: ${wss.clients.size}`);

    // Send welcome
    ws.send(JSON.stringify({ type: "CONNECTED", user }));

    ws.on("close", () => {
      subscriptions.get(user)?.delete(ws);
      if (subscriptions.get(user)?.size === 0) {
        subscriptions.delete(user);
      }
      console.log(`[WS] ${user} disconnected. Total: ${wss.clients.size}`);
    });

    ws.on("error", (err) => {
      console.error(`[WS] Error for ${user}:`, err.message);
    });

    // Heartbeat
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "PING") ws.send(JSON.stringify({ type: "PONG" }));
      } catch {
        // ignore malformed messages
      }
    });
  });

  console.log("[WS] WebSocket server initialized at /ws");
}

export function broadcastToSubscribers(user: string, payload: object): void {
  const sockets = subscriptions.get(user.toLowerCase());
  if (!sockets || sockets.size === 0) return;

  const message = JSON.stringify(payload);
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

export function getConnectedCount(): number {
  return wss?.clients.size ?? 0;
}
