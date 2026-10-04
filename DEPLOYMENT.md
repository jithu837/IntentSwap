# IntentSwap — Deployment & Operation Guide

This guide covers deploying **IntentSwap** to production using **Render.com** (backend API + frontend static site) and **MongoDB Atlas** (M0 free tier database), plus local deployment of smart contracts to the **Ethereum Sepolia Testnet**.

---

## 📋 Table of Contents
1. [MongoDB Atlas Setup](#1-mongodb-atlas-setup)
2. [Smart Contract Deployment (Sepolia)](#2-smart-contract-deployment-sepolia)
3. [Render.com Setup (render.yaml Blueprint)](#3-rendercom-setup-renderyaml-blueprint)
4. [Environment Variables Reference](#4-environment-variables-reference)
5. [Verification & Live Testing](#5-verification--live-testing)

---

## 1. MongoDB Atlas Setup

1. Sign up or log into [MongoDB Atlas](https://www.mongodb.com/cloud/atlas).
2. Create a **Shared M0 Cluster** (Free tier).
3. Under **Database Access**:
   - Create a database user (e.g., `intentswap_admin`) with password.
4. Under **Network Access**:
   - Add IP Access List entry: `0.0.0.0/0` (Allows Render backend services to connect).
5. Obtain the Connection String:
   ```
   mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/intentswap?retryWrites=true&w=majority
   ```

---

## 2. Smart Contract Deployment (Sepolia)

Smart contracts are compiled and deployed from your local environment to Sepolia via Hardhat.

1. Navigate to the `contracts` package:
   ```bash
   cd contracts
   ```
2. Create `contracts/.env` from template:
   ```bash
   cp .env.example .env
   ```
3. Populate `contracts/.env`:
   ```env
   SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_ALCHEMY_KEY
   PRIVATE_KEY=YOUR_DEPLOYER_PRIVATE_KEY_HEX
   ETHERSCAN_API_KEY=YOUR_ETHERSCAN_KEY
   FEE_BPS=30
   ```
4. Compile & Deploy:
   ```bash
   npm run compile
   npm run deploy:sepolia
   ```
5. Copy the printed contract address (e.g., `0x1234...5678`) for backend & frontend configuration.

---

## 3. Render.com Setup (render.yaml Blueprint)

IntentSwap uses Render Blueprint (`render.yaml`) to auto-provision both the Backend Web Service and Frontend Static Site.

1. Push your repository to GitHub.
2. Log into [Render Dashboard](https://dashboard.render.com).
3. Click **New +** → **Blueprints**.
4. Connect your GitHub repository `IntentSwap`.
5. Render will automatically parse `render.yaml` and configure two services:
   - **`intentswap-backend`** (Web Service, Node.js environment)
   - **`intentswap-frontend`** (Static Site, React + Vite environment)

---

## 4. Environment Variables Reference

### Backend (`intentswap-backend`)
| Variable | Value / Example | Required |
|---|---|---|
| `NODE_ENV` | `production` | Yes |
| `PORT` | `4000` | Yes |
| `MONGODB_URI` | `mongodb+srv://user:pass@cluster0...` | Yes |
| `RPC_URL` | `https://eth-sepolia.g.alchemy.com/v2/...` | Yes |
| `CONTRACT_ADDRESS` | `0xDeployedIntentEscrowAddress` | Yes |
| `SOLVER_PRIVATE_KEY` | Hex private key for solver fulfillment wallet | Yes |
| `FRONTEND_URL` | `https://intentswap-frontend.onrender.com` | Yes |
| `CORS_ORIGIN` | `https://intentswap-frontend.onrender.com` | Yes |

### Frontend (`intentswap-frontend`)
| Variable | Value / Example | Required |
|---|---|---|
| `VITE_API_URL` | `https://intentswap-backend.onrender.com` | Yes |
| `VITE_WS_URL` | `wss://intentswap-backend.onrender.com` | Yes |

---

## 5. Verification & Live Testing

1. **Health Check**:
   Visit `https://intentswap-backend.onrender.com/health` in your browser.
   Expected response:
   ```json
   {
     "status": "ok",
     "mongo": "connected",
     "chain": "https://eth-sepolia.g.alchemy.com/v2/...",
     "contract": "0x1234...",
     "timestamp": "2026-10-02T16:00:00.000Z"
   }
   ```
2. **Frontend UI**:
   Open `https://intentswap-frontend.onrender.com`.
   - Connect MetaMask / Web3 Wallet.
   - Enter swap amount and click **Sign Intent & Swap**.
   - Confirm the EIP-712 signature popup in MetaMask (0 ETH gas cost).
   - Observe live solver quotes, winning solver selection (`GammaBot`), and order status transition to `fulfilled`.
