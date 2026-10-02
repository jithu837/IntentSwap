# IntentSwap — Gas-Free Intent-Based Cross-Chain Swap

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.24-blue)](https://soliditylang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green)](https://nodejs.org/)

IntentSwap lets users **sign an intent** (what they want) instead of submitting a transaction. Competing **solver bots** race to provide the best quote. The winning solver settles everything on-chain — **the user never pays gas to create a swap order**.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  User (Browser / dApp)                                          │
│  signs EIP-712 intent off-chain                                 │
└───────────────────────┬─────────────────────────────────────────┘
                        │ POST /api/intents
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│  Backend (Express + TypeScript)                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  IntentService                                           │   │
│  │  1. Verify EIP-712 signature                            │   │
│  │  2. Check deadline & on-chain state                     │   │
│  │  3. Run Solver Auction (Promise.allSettled)             │   │
│  │     ├─ AlphaBot (fast, ~95% rate)                      │   │
│  │     ├─ BetaBot  (medium, ~95.2% rate)                  │   │
│  │     └─ GammaBot (slow, ~96% rate)                      │   │
│  │  4. Best quote → MongoDB                               │   │
│  │  5. Broadcast via WebSocket                            │   │
│  └─────────────────────────────────────────────────────────┘   │
└───────────────────────┬─────────────────────────────────────────┘
                        │ fulfillIntent()
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│  IntentEscrow.sol (Solidity 0.8.24)                             │
│  • EIP-712 typed-data verification                              │
│  • usedIntents mapping (replay protection)                      │
│  • ReentrancyGuard + CEI pattern                                │
│  • Fee collection (configurable bps)                            │
│  • SafeERC20 transfers                                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Monorepo Structure

```
intentswap/
├── contracts/          # Solidity contracts + Hardhat
│   ├── contracts/
│   │   ├── IntentEscrow.sol    ← main contract
│   │   └── MockERC20.sol       ← test helper
│   ├── scripts/deploy.ts
│   ├── test/IntentEscrow.test.ts
│   └── hardhat.config.ts
├── backend/            # Express REST API + WebSocket
│   └── src/
│       ├── index.ts            ← entry point
│       ├── types.ts
│       ├── db/models/Intent.ts
│       ├── solvers/engine.ts   ← solver auction
│       ├── services/
│       │   ├── escrow.ts       ← ethers.js wrapper
│       │   └── intentService.ts
│       ├── routes/intents.ts
│       ├── websocket/server.ts
│       └── middleware/errorHandler.ts
├── sdk/                # intentswap-sdk npm package
│   └── src/index.ts
├── render.yaml         # Render.com deployment
├── package.json        # npm workspaces root
└── README.md
```

---

## Quick Start

### Prerequisites
- Node.js ≥ 20
- MongoDB (local or Atlas M0 free tier)

### 1. Install

```bash
npm install
```

### 2. Contracts — compile & test

```bash
cd contracts
cp .env.example .env          # fill in if deploying to testnet
npm run compile
npm run test                  # runs full Hardhat test suite
```

**Start a local chain + deploy:**

```bash
npm run node                  # terminal 1
npm run deploy:localhost       # terminal 2
```

Copy the printed contract address into `backend/.env`.

### 3. Backend

```bash
cd backend
cp .env.example .env          # set MONGO_URI, CONTRACT_ADDRESS
npm run dev
```

Server starts at `http://localhost:4000`.

### 4. SDK usage

```ts
import { IntentSwapSDK } from "intentswap-sdk";
import { ethers } from "ethers";

const provider = new ethers.BrowserProvider(window.ethereum);
const signer = await provider.getSigner();

const sdk = new IntentSwapSDK({
  apiUrl: "http://localhost:4000",
  contractAddress: "0xYOUR_CONTRACT",
  signer,
});

// 1. Create & sign an intent (gas-free)
const signedIntent = await sdk.createIntent({
  tokenIn:  "0xTOKEN_A",
  tokenOut: "0xTOKEN_B",
  amountIn: ethers.parseEther("100"),
  minAmountOut: ethers.parseEther("90"),
});

// 2. Submit to backend → triggers solver auction
const result = await sdk.submitIntent(signedIntent);
console.log("Winner:", result.winnerQuote);

// 3. Subscribe to live updates
const unsubscribe = sdk.subscribeToUpdates(signer.address, (msg) => {
  console.log("Update:", msg);
});
```

---

## API Reference

### `POST /api/intents`
Submit a signed intent. Triggers the solver auction.

**Body:**
```json
{
  "intent": {
    "user": "0x...",
    "tokenIn": "0x...",
    "tokenOut": "0x...",
    "amountIn": "100000000000000000000",
    "minAmountOut": "90000000000000000000",
    "deadline": 1700000000,
    "nonce": 0,
    "sourceChainId": 31337,
    "destChainId": 31337
  },
  "signature": {
    "v": 28,
    "r": "0x...",
    "s": "0x...",
    "full": "0x..."
  }
}
```

**Response `201`:**
```json
{
  "success": true,
  "data": {
    "intentHash": "0x...",
    "status": "pending",
    "winnerSolverId": "gamma-bot",
    "winnerQuote": { "amountOut": "96000000000000000000", ... },
    "allQuotes": [...]
  }
}
```

### `GET /api/intents/:hash`
Get an intent by its EIP-712 hash.

### `GET /api/intents?user=0x...&limit=20&skip=0`
List intents for a user.

### `GET /health`
Health check — returns MongoDB and chain connection status.

### WebSocket `ws://host/ws?user=0x...`
Subscribe to real-time intent updates. Messages:
| type | description |
|---|---|
| `CONNECTED` | Subscription confirmed |
| `INTENT_QUOTED` | Solver auction complete, winner announced |
| `PONG` | Reply to PING heartbeat |

---

## Security Model

| Concern | Mitigation |
|---|---|
| Replay attacks | `usedIntents[hash]` mapping; per-user nonce in struct |
| Cross-contract replays | EIP-712 domain separator includes `chainId` + `verifyingContract` |
| Re-entrancy | `ReentrancyGuard` + CEI pattern (state mutated before transfers) |
| Slippage | `minAmountOut` enforced on-chain |
| Expired intents | `deadline` checked on-chain |
| Wrong chain | `sourceChainId == block.chainid` guard |
| Fee abuse | Fee capped at 10% (`feeBps ≤ 1000`) |
| Centralized solver | Multiple competing solvers; extensible to permissionless registry |

---

## Trade-offs & Production Notes

- **Same-chain only (PoC):** `sourceChainId` and `destChainId` fields are present in the struct but the current contract only enforces `sourceChainId == block.chainid`. True cross-chain settlement requires CCIP, LayerZero, or IBC.
- **Centralized solver selection:** The backend operates the solver for MVP. In production, replace with a permissionless solver registry + Dutch auction (like UniswapX).
- **No front-running protection:** Add a commit-reveal scheme or private mempool (Flashbots) for production.
- **MongoDB for state:** Suitable for PoC. In production, consider Redis for quote caching.

---

## Deployment (Render.com)

1. Push repo to GitHub
2. Create a new Render **Web Service** → connect GitHub repo
3. Render detects `render.yaml` automatically
4. Set secret env vars in the Render dashboard: `MONGO_URI`, `RPC_URL`, `CONTRACT_ADDRESS`, `SOLVER_PRIVATE_KEY`
5. Deploy 🚀

---

## License

MIT
