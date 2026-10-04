const API_BASE = "http://localhost:4000/api";
const WS_BASE = "ws://localhost:4000/ws";

// State
let userAddress = "0x71C7656EC7ab88b098defB751B7401B5f6d89F3A";
let ws = null;
let currentIntentPayload = null;

// DOM Elements
const wsStatusDot = document.getElementById("wsStatusDot");
const wsStatusText = document.getElementById("wsStatusText");
const walletText = document.getElementById("walletText");
const amountInInput = document.getElementById("amountInInput");
const amountOutInput = document.getElementById("amountOutInput");
const swapBtn = document.getElementById("swapBtn");
const consoleBox = document.getElementById("consoleBox");
const intentsTableBody = document.getElementById("intentsTableBody");
const signModal = document.getElementById("signModal");
const typedDataJson = document.getElementById("typedDataJson");
const confirmSignBtn = document.getElementById("confirmSignBtn");
const cancelSignBtn = document.getElementById("cancelSignBtn");
const refreshTableBtn = document.getElementById("refreshTableBtn");

// Initialize
window.addEventListener("DOMContentLoaded", () => {
  walletText.textContent = `${userAddress.slice(0, 6)}...${userAddress.slice(-4)}`;
  logConsole("Initializing WebSocket connection to backend...", "info");
  initWebSocket();
  fetchIntentHistory();

  amountInInput.addEventListener("input", updateExpectedOut);
  swapBtn.addEventListener("click", openSignModal);
  confirmSignBtn.addEventListener("click", handleConfirmSign);
  cancelSignBtn.addEventListener("click", () => signModal.classList.remove("active"));
  refreshTableBtn.addEventListener("click", fetchIntentHistory);
});

function updateExpectedOut() {
  const val = parseFloat(amountInInput.value) || 0;
  amountOutInput.value = (val * 0.95).toFixed(2);
}

// WebSocket setup
function initWebSocket() {
  try {
    ws = new WebSocket(`${WS_BASE}?user=${userAddress}`);

    ws.onopen = () => {
      wsStatusDot.classList.add("connected");
      wsStatusText.textContent = "Backend Connected (Port 4000)";
      logConsole("[WS] Connected to ws://localhost:4000/ws", "success");
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        logConsole(`[WS Event] ${msg.type}: ${JSON.stringify(msg.data || msg)}`, "info");
        if (msg.type === "INTENT_QUOTED") {
          highlightWinnerSolver(msg.data.winnerSolverId);
          fetchIntentHistory();
        }
      } catch (e) {
        console.error("WS message parse error:", e);
      }
    };

    ws.onclose = () => {
      wsStatusDot.classList.remove("connected");
      wsStatusText.textContent = "Reconnecting...";
      logConsole("[WS] Disconnected. Reconnecting in 3s...", "warn");
      setTimeout(initWebSocket, 3000);
    };

    ws.onerror = (err) => {
      logConsole("[WS] Connection error", "warn");
    };
  } catch (err) {
    logConsole(`[WS] Error: ${err.message}`, "warn");
  }
}

// Open EIP-712 modal
function openSignModal() {
  const amountIn = (parseFloat(amountInInput.value) * 1e18).toString();
  const minAmountOut = (parseFloat(amountOutInput.value) * 1e18).toString();
  const deadline = Math.floor(Date.now() / 1000) + 86400; // 24 hours
  const nonce = Math.floor(Math.random() * 10000);

  const intent = {
    user: userAddress,
    tokenIn: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
    tokenOut: "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
    amountIn,
    minAmountOut,
    deadline,
    nonce,
    sourceChainId: 31337,
    destChainId: 31337,
  };

  const typedData = {
    domain: {
      name: "IntentSwap",
      version: "1",
      chainId: 31337,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    },
    types: {
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
    },
    primaryType: "Intent",
    message: intent,
  };

  currentIntentPayload = {
    intent,
    signature: {
      v: 27,
      r: "0x1111111111111111111111111111111111111111111111111111111111111111",
      s: "0x2222222222222222222222222222222222222222222222222222222222222222",
      full: "0x111111111111111111111111111111111111111111111111111111111111111122222222222222222222222222222222222222222222222222222222222222221b",
    },
  };

  typedDataJson.textContent = JSON.stringify(typedData, null, 2);
  signModal.classList.add("active");
}

// Submit intent to API
async function handleConfirmSign() {
  signModal.classList.remove("active");
  swapBtn.disabled = true;
  swapBtn.textContent = "⏳ Running Solver Auction...";
  logConsole("[Intent] Signature generated off-chain. Submitting to /api/intents...", "info");

  // Reset winner UI
  document.querySelectorAll(".solver-card").forEach(c => c.classList.remove("winner"));

  try {
    const res = await fetch(`${API_BASE}/intents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentIntentPayload),
    });

    const data = await res.json();
    if (res.ok && data.success) {
      const intentData = data.data;
      logConsole(`[Auction Complete] Winner: ${intentData.winnerSolverId}! Hash: ${intentData.intentHash.slice(0, 10)}...`, "success");
      highlightWinnerSolver(intentData.winnerSolverId);
      fetchIntentHistory();
    } else {
      logConsole(`[API Error] ${data.error || "Failed to submit intent"}`, "warn");
    }
  } catch (err) {
    logConsole(`[Error] Request failed: ${err.message}`, "warn");
  } finally {
    swapBtn.disabled = false;
    swapBtn.innerHTML = "<span>⚡ Sign Intent & Swap</span>";
  }
}

// Fetch intent history
async function fetchIntentHistory() {
  try {
    const res = await fetch(`${API_BASE}/intents?user=${userAddress}&limit=10`);
    if (!res.ok) return;
    const json = await res.json();
    if (!json.success || !Array.isArray(json.data)) return;

    renderTable(json.data);
  } catch (err) {
    // console.log(err);
  }
}

function renderTable(intents) {
  if (intents.length === 0) {
    intentsTableBody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 20px;">
          No intents submitted yet. Click "Sign Intent & Swap" to test!
        </td>
      </tr>`;
    return;
  }

  intentsTableBody.innerHTML = intents.map(item => {
    const hashShort = item.intentHash ? item.intentHash.slice(0, 8) + "..." + item.intentHash.slice(-6) : "N/A";
    const amountInEth = (parseFloat(item.intent.amountIn) / 1e18).toFixed(2);
    const minOutEth = (parseFloat(item.intent.minAmountOut) / 1e18).toFixed(2);
    const winnerOutEth = item.winnerQuote ? (parseFloat(item.winnerQuote.amountOut) / 1e18).toFixed(2) : "-";

    return `
      <tr>
        <td style="font-family: var(--font-mono); color: #a5b4fc;">${hashShort}</td>
        <td>USDC ➔ USDT (${amountInEth})</td>
        <td>${minOutEth} USDT</td>
        <td style="color: var(--accent-green); font-weight: 700;">${winnerOutEth} USDT</td>
        <td><span class="status-badge ${item.status}">${item.status}</span></td>
      </tr>
    `;
  }).join("");
}

function highlightWinnerSolver(solverId) {
  document.querySelectorAll(".solver-card").forEach(c => c.classList.remove("winner"));
  let elementId = "";
  if (solverId === "alpha-bot") elementId = "solver-alpha";
  else if (solverId === "beta-bot") elementId = "solver-beta";
  else if (solverId === "gamma-bot") elementId = "solver-gamma";

  if (elementId) {
    const el = document.getElementById(elementId);
    if (el) el.classList.add("winner");
  }
}

function logConsole(msg, type = "info") {
  const entry = document.createElement("div");
  entry.className = `log-entry ${type}`;
  const time = new Date().toLocaleTimeString();
  entry.textContent = `[${time}] ${msg}`;
  consoleBox.appendChild(entry);
  consoleBox.scrollTop = consoleBox.scrollHeight;
}
