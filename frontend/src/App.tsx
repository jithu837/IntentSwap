import React, { useState, useEffect, useRef } from 'react';
import { useAccount, useConnect, useDisconnect, useSignTypedData, useChainId } from 'wagmi';
import { Zap, Wallet, ShieldCheck, Activity, RefreshCw, Layers, ArrowDown, CheckCircle, XCircle, Clock } from 'lucide-react';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000';
const WS_BASE = import.meta.env.VITE_WS_URL || 'ws://localhost:4000';

// EIP-712 typed data definition
const INTENT_TYPES = {
  Intent: [
    { name: 'user', type: 'address' },
    { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'minAmountOut', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'sourceChainId', type: 'uint256' },
    { name: 'destChainId', type: 'uint256' },
  ],
} as const;

// Token registry
const TOKENS: Record<string, { name: string; symbol: string; address: string; icon: string; decimals: number }> = {
  USDC: {
    name: 'USD Coin',
    symbol: 'USDC',
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    icon: '💵',
    decimals: 6,
  },
  USDT: {
    name: 'Tether USD',
    symbol: 'USDT',
    address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    icon: '💎',
    decimals: 6,
  },
  WETH: {
    name: 'Wrapped Ether',
    symbol: 'WETH',
    address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    icon: '⚡',
    decimals: 18,
  },
  DAI: {
    name: 'Dai Stablecoin',
    symbol: 'DAI',
    address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    icon: '🟡',
    decimals: 18,
  },
};

interface IntentItem {
  intentHash: string;
  status: 'pending' | 'filled' | 'cancelled' | 'expired';
  intent: {
    user: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    minAmountOut: string;
  };
  winnerSolverId?: string;
  winnerQuote?: {
    amountOut: string;
    solverId: string;
    latencyMs?: number;
    fee?: string;
  };
  allQuotes?: Array<{
    solverId: string;
    amountOut: string;
    latencyMs?: number;
    fee?: string;
  }>;
  txHash?: string;
  createdAt: string;
}

type SolverState = 'idle' | 'racing' | 'won' | 'lost' | 'failed';

interface SolverCard {
  id: string;
  name: string;
  icon: string;
  color: string;
  speed: string;
  rate: string;
  fee: string;
  state: SolverState;
  quote?: string;
  latency?: number;
}

const INITIAL_SOLVERS: SolverCard[] = [
  { id: 'alpha-bot', name: 'AlphaBot', icon: '🤖', color: 'indigo', speed: '~20ms', rate: '~94.8%', fee: '0.30%', state: 'idle' },
  { id: 'beta-bot', name: 'BetaBot', icon: '⚡', color: 'purple', speed: '~45ms', rate: '~95.4%', fee: '0.25%', state: 'idle' },
  { id: 'gamma-bot', name: 'GammaBot', icon: '🚀', color: 'pink', speed: '~80ms', rate: '~96.1%', fee: '0.15%', state: 'idle' },
  { id: 'delta-bot', name: 'DeltaBot', icon: '⚗️', color: 'emerald', speed: '~110ms', rate: '~95.8%', fee: '0.20%', state: 'idle' },
];

export function App() {
  const { address, isConnected } = useAccount();
  const { connectors, connect } = useConnect();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const { signTypedDataAsync } = useSignTypedData();

  const [tokenInKey, setTokenInKey] = useState('USDC');
  const [tokenOutKey, setTokenOutKey] = useState('USDT');
  const [amountIn, setAmountIn] = useState('100');
  const [slippage] = useState(5); // 5% default slippage
  const [wsConnected, setWsConnected] = useState(false);
  const [logs, setLogs] = useState<string[]>(['[System] IntentSwap initialized — connect your wallet to begin']);
  const [intents, setIntents] = useState<IntentItem[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [solvers, setSolvers] = useState<SolverCard[]>(INITIAL_SOLVERS);
  const [lastResult, setLastResult] = useState<IntentItem | null>(null);
  const [activeTab, setActiveTab] = useState<'swap' | 'history'>('swap');
  const wsRef = useRef<WebSocket | null>(null);

  const activeAddress = address || '0x71C7656EC7ab88b098defB751B7401B5f6d89F3A';
  const tokenIn = TOKENS[tokenInKey];
  const tokenOut = TOKENS[tokenOutKey];
  const minAmountOut = (parseFloat(amountIn || '0') * (1 - slippage / 100)).toFixed(2);

  // ── WebSocket connection ──────────────────────────────────────────────────
  useEffect(() => {
    let ws: WebSocket;
    let retryTimeout: ReturnType<typeof setTimeout>;

    const connect = () => {
      try {
        ws = new WebSocket(`${WS_BASE}/ws?user=${activeAddress}`);
        wsRef.current = ws;

        ws.onopen = () => {
          setWsConnected(true);
          addLog(`[WS] Connected to ${WS_BASE}`);
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'INTENT_QUOTED') {
              addLog(`[WS] Auction result: winner=${data.winner?.solverId ?? 'none'}`);
              fetchHistory();
            }
          } catch { /* ignore */ }
        };

        ws.onclose = () => {
          setWsConnected(false);
          wsRef.current = null;
          retryTimeout = setTimeout(connect, 3000);
        };

        ws.onerror = () => setWsConnected(false);
      } catch {
        setWsConnected(false);
        retryTimeout = setTimeout(connect, 5000);
      }
    };

    connect();
    return () => {
      clearTimeout(retryTimeout);
      ws?.close();
    };
  }, [activeAddress]);

  const addLog = (msg: string, type: 'info' | 'success' | 'warn' | 'error' = 'info') => {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev.slice(-30), `[${time}] ${msg}`]);
  };

  const fetchHistory = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/intents?user=${activeAddress}&limit=10`);
      if (res.ok) {
        const json = await res.json();
        if (json.success && Array.isArray(json.data)) {
          setIntents(json.data);
        }
      }
    } catch { /* ignore */ }
  };

  useEffect(() => { fetchHistory(); }, [activeAddress]);

  // ── Solver animation helpers ───────────────────────────────────────────────
  const startSolverRace = () => {
    setSolvers(INITIAL_SOLVERS.map(s => ({ ...s, state: 'racing', quote: undefined, latency: undefined })));
  };

  const updateSolverResult = (quotes: IntentItem['allQuotes'], winner: IntentItem['winnerSolverId']) => {
    setSolvers(prev => prev.map(s => {
      const q = quotes?.find(q => q.solverId === s.id);
      if (!q) return { ...s, state: 'failed' };
      const amountOutEth = (parseFloat(q.amountOut) / 1e18).toFixed(4);
      return {
        ...s,
        state: s.id === winner ? 'won' : 'lost',
        quote: `${amountOutEth} ${tokenOutKey}`,
        latency: q.latencyMs,
      };
    }));
  };

  // ── Main swap handler ──────────────────────────────────────────────────────
  const handleSwap = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setLastResult(null);
    startSolverRace();

    const amountInWei = BigInt(Math.floor(parseFloat(amountIn) * Math.pow(10, tokenIn.decimals)));
    const minAmountOutWei = BigInt(Math.floor(parseFloat(minAmountOut) * Math.pow(10, tokenOut.decimals)));
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800); // 30 min
    const nonce = BigInt(Math.floor(Math.random() * 10000));
    const effectiveChainId = BigInt(chainId || 31337);

    const intentData = {
      user: activeAddress as `0x${string}`,
      tokenIn: tokenIn.address as `0x${string}`,
      tokenOut: tokenOut.address as `0x${string}`,
      amountIn: amountInWei,
      minAmountOut: minAmountOutWei,
      deadline,
      nonce,
      sourceChainId: effectiveChainId,
      destChainId: effectiveChainId,
    };

    let fullSig: string;
    let sigComponents: { v: number; r: string; s: string; full: string };

    try {
      if (isConnected && address) {
        // Real EIP-712 wallet signature via MetaMask/injected wallet
        addLog(`[EIP-712] Requesting signature from ${address.slice(0, 6)}...${address.slice(-4)}`);
        fullSig = await signTypedDataAsync({
          domain: {
            name: 'IntentSwap',
            version: '1',
            chainId: chainId || 31337,
            verifyingContract: '0x0000000000000000000000000000000000000000',
          },
          types: INTENT_TYPES,
          primaryType: 'Intent',
          message: intentData,
        });
        addLog(`[EIP-712] Signature obtained: ${fullSig.slice(0, 12)}...`, 'success');

        // Parse sig components
        const r = fullSig.slice(0, 66);
        const s = '0x' + fullSig.slice(66, 130);
        const vHex = fullSig.slice(130);
        const v = parseInt(vHex, 16);
        sigComponents = { v: v < 27 ? v + 27 : v, r, s, full: fullSig };
      } else {
        // Demo mode: mock signature (accepted by backend in offline mode)
        addLog(`[Demo Mode] Using mock signature (no wallet connected)`);
        sigComponents = {
          v: 27,
          r: '0x1111111111111111111111111111111111111111111111111111111111111111',
          s: '0x2222222222222222222222222222222222222222222222222222222222222222',
          full: '0x111111111111111111111111111111111111111111111111111111111111111122222222222222222222222222222222222222222222222222222222222222221b',
        };
      }
    } catch (err: any) {
      addLog(`[Error] Signature rejected: ${err.message}`, 'warn');
      setSolvers(INITIAL_SOLVERS.map(s => ({ ...s, state: 'idle' })));
      setIsSubmitting(false);
      return;
    }

    // Build payload with string-serialized bigints (JSON safe)
    const payload = {
      intent: {
        user: activeAddress,
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        amountIn: amountInWei.toString(),
        minAmountOut: minAmountOutWei.toString(),
        deadline: Number(deadline),
        nonce: Number(nonce),
        sourceChainId: Number(effectiveChainId),
        destChainId: Number(effectiveChainId),
      },
      signature: sigComponents,
    };

    addLog(`[API] Submitting to /api/intents — triggering solver auction...`);

    try {
      const res = await fetch(`${API_BASE}/api/intents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const json = await res.json();

      if (res.ok && json.success) {
        const data: IntentItem = json.data;
        setLastResult(data);
        updateSolverResult(data.allQuotes, data.winnerSolverId);

        if (data.winnerSolverId) {
          addLog(`[Auction] ✅ Winner: ${data.winnerSolverId} | Hash: ${data.intentHash.slice(0, 10)}...`, 'success');
          if (data.txHash) {
            addLog(`[On-Chain] Settlement tx: ${data.txHash.slice(0, 10)}...`, 'success');
          }
        } else {
          addLog(`[Auction] No solver could fill this intent`, 'warn');
        }
        fetchHistory();
      } else {
        addLog(`[API Error] ${json.error || 'Unknown error'}`, 'warn');
        setSolvers(INITIAL_SOLVERS.map(s => ({ ...s, state: 'idle' })));
      }
    } catch (err: any) {
      addLog(`[Error] ${err.message}`, 'warn');
      setSolvers(INITIAL_SOLVERS.map(s => ({ ...s, state: 'idle' })));
    } finally {
      setIsSubmitting(false);
    }
  };

  const swapTokens = () => {
    setTokenInKey(tokenOutKey);
    setTokenOutKey(tokenInKey);
  };

  // ── Render helpers ─────────────────────────────────────────────────────────
  const getSolverBorderClass = (state: SolverState) => {
    switch (state) {
      case 'won': return 'border-emerald-500/70 bg-emerald-500/10 shadow-lg shadow-emerald-500/20';
      case 'lost': return 'border-white/10 bg-[#080b11] opacity-60';
      case 'racing': return 'border-indigo-500/50 bg-indigo-500/5 animate-pulse';
      case 'failed': return 'border-red-500/30 bg-red-500/5 opacity-50';
      default: return 'border-white/10 bg-[#080b11]';
    }
  };

  const getStatusBadge = (status: IntentItem['status']) => {
    const styles: Record<string, string> = {
      pending: 'bg-amber-500/20 text-amber-400',
      filled: 'bg-emerald-500/20 text-emerald-400',
      cancelled: 'bg-slate-500/20 text-slate-400',
      expired: 'bg-red-500/20 text-red-400',
    };
    return styles[status] ?? 'bg-slate-500/20 text-slate-400';
  };

  const StatusIcon = ({ status }: { status: IntentItem['status'] }) => {
    if (status === 'filled') return <CheckCircle className="w-3.5 h-3.5 inline mr-1" />;
    if (status === 'expired' || status === 'cancelled') return <XCircle className="w-3.5 h-3.5 inline mr-1" />;
    return <Clock className="w-3.5 h-3.5 inline mr-1" />;
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#0a0d14] text-slate-100 font-sans">
      {/* ── Header ── */}
      <header className="sticky top-0 z-50 flex items-center justify-between px-6 md:px-10 py-4 bg-[#0a0d14]/80 backdrop-blur-md border-b border-white/10">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-500 via-purple-500 to-pink-500 flex items-center justify-center shadow-lg shadow-indigo-500/30">
            <Zap className="w-5 h-5 text-white" />
          </div>
          <span className="text-xl font-extrabold bg-gradient-to-r from-indigo-400 to-pink-400 bg-clip-text text-transparent">
            IntentSwap
          </span>
          <span className="hidden sm:inline text-xs font-bold px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
            Gas-Free
          </span>
        </div>

        <div className="flex items-center gap-3">
          {/* WS status pill */}
          <div className="hidden sm:flex items-center gap-2 text-xs px-3.5 py-1.5 rounded-full bg-white/5 border border-white/10">
            <span className={`w-2 h-2 rounded-full transition-colors ${wsConnected ? 'bg-emerald-400 shadow-[0_0_8px_#10b981]' : 'bg-slate-500'}`} />
            <span className="text-slate-300">{wsConnected ? 'Live' : 'Connecting'}</span>
          </div>

          {isConnected ? (
            <button
              onClick={() => disconnect()}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-sm font-semibold transition-all"
            >
              <Wallet className="w-4 h-4 text-purple-400" />
              {address!.slice(0, 6)}...{address!.slice(-4)}
            </button>
          ) : (
            <button
              onClick={() => connect({ connector: connectors[0] })}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-sm font-bold shadow-lg shadow-indigo-500/25 transition-all"
            >
              <Wallet className="w-4 h-4" />
              Connect Wallet
            </button>
          )}
        </div>
      </header>

      {/* ── Main ── */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 md:p-8 grid grid-cols-1 lg:grid-cols-12 gap-6">

        {/* ── Left: Swap panel ── */}
        <div className="lg:col-span-5 space-y-4">
          <div className="glass-panel p-6 shadow-2xl relative overflow-hidden">
            {/* Gradient accent bar */}
            <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500" />

            <div className="flex items-center justify-between mb-6">
              <h2 className="text-base font-bold">Gas-Free Swap</h2>
              <span className="text-xs text-slate-400 bg-white/5 px-2.5 py-1 rounded-md border border-white/10 font-mono">
                EIP-712
              </span>
            </div>

            {/* Token In */}
            <div className="p-4 rounded-xl bg-[#080b11] border border-white/10 focus-within:border-indigo-500/50 focus-within:shadow-[0_0_20px_rgba(99,102,241,0.1)] transition-all mb-2">
              <div className="flex justify-between text-xs text-slate-400 mb-2">
                <span>You Pay</span>
                <span className="text-emerald-400 font-bold">$0.00 gas</span>
              </div>
              <div className="flex items-center gap-3">
                <input
                  id="amountInInput"
                  type="number"
                  value={amountIn}
                  min="0"
                  onChange={(e) => setAmountIn(e.target.value)}
                  className="w-full bg-transparent text-2xl font-bold outline-none text-white font-mono"
                  placeholder="0.00"
                />
                <button className="flex items-center gap-2 px-3 py-1.5 bg-white/10 hover:bg-white/15 rounded-full font-bold text-sm border border-white/10 transition-colors whitespace-nowrap">
                  {tokenIn.icon} {tokenIn.symbol}
                </button>
              </div>
            </div>

            {/* Swap direction arrow */}
            <div className="flex justify-center my-1 relative z-10">
              <button
                onClick={swapTokens}
                className="w-9 h-9 rounded-full bg-[#0a0d14] border border-white/15 hover:border-indigo-500/50 flex items-center justify-center transition-all hover:rotate-180 duration-300"
              >
                <ArrowDown className="w-4 h-4 text-slate-400" />
              </button>
            </div>

            {/* Token Out */}
            <div className="p-4 rounded-xl bg-[#080b11] border border-white/10 mb-5">
              <div className="flex justify-between text-xs text-slate-400 mb-2">
                <span>You Receive (min)</span>
                <span>{slippage}% slippage</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-full text-2xl font-bold text-emerald-400 font-mono">
                  {minAmountOut || '0.00'}
                </div>
                <button className="flex items-center gap-2 px-3 py-1.5 bg-white/10 hover:bg-white/15 rounded-full font-bold text-sm border border-white/10 transition-colors whitespace-nowrap">
                  {tokenOut.icon} {tokenOut.symbol}
                </button>
              </div>
            </div>

            {/* Details row */}
            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 space-y-1.5 text-xs text-slate-400 mb-5">
              <div className="flex justify-between">
                <span>Routing Engine</span>
                <span className="text-slate-200">3 Competing Solvers</span>
              </div>
              <div className="flex justify-between">
                <span>Signing Method</span>
                <span className="text-slate-200 font-mono">{isConnected ? 'eth_signTypedData_v4' : 'Demo (mock)'}</span>
              </div>
              <div className="flex justify-between">
                <span>User Gas Cost</span>
                <span className="text-emerald-400 font-bold">$0.00</span>
              </div>
            </div>

            {/* Swap CTA */}
            <button
              id="swapBtn"
              onClick={handleSwap}
              disabled={isSubmitting || !amountIn || parseFloat(amountIn) <= 0}
              className="w-full py-4 rounded-xl bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 hover:from-indigo-500 hover:to-pink-500 text-white font-bold text-sm shadow-xl shadow-indigo-500/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 group"
            >
              <Zap className={`w-4 h-4 ${isSubmitting ? 'animate-bounce' : 'group-hover:scale-110 transition-transform'}`} />
              {isSubmitting ? 'Running Solver Auction...' : isConnected ? 'Sign Intent & Swap' : 'Sign Intent (Demo Mode)'}
            </button>

            {!isConnected && (
              <p className="text-xs text-slate-500 text-center mt-3">
                Connect wallet for real EIP-712 signing via MetaMask
              </p>
            )}
          </div>

          {/* Result card */}
          {lastResult && (
            <div className={`glass-panel p-4 border transition-all ${lastResult.winnerSolverId ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-red-500/30'}`}>
              <div className="text-xs font-bold text-slate-400 mb-2 flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                Latest Intent Result
              </div>
              <div className="font-mono text-xs space-y-1">
                <div className="flex justify-between">
                  <span className="text-slate-400">Hash</span>
                  <span className="text-indigo-300">{lastResult.intentHash.slice(0, 10)}...{lastResult.intentHash.slice(-6)}</span>
                </div>
                {lastResult.winnerSolverId && (
                  <div className="flex justify-between">
                    <span className="text-slate-400">Winner</span>
                    <span className="text-emerald-400 font-bold">{lastResult.winnerSolverId}</span>
                  </div>
                )}
                {lastResult.winnerQuote && (
                  <div className="flex justify-between">
                    <span className="text-slate-400">Amount Out</span>
                    <span className="text-emerald-400 font-bold">
                      {(parseFloat(lastResult.winnerQuote.amountOut) / 1e18).toFixed(4)} {tokenOutKey}
                    </span>
                  </div>
                )}
                {lastResult.txHash && (
                  <div className="flex justify-between">
                    <span className="text-slate-400">Tx Hash</span>
                    <span className="text-blue-400">{lastResult.txHash.slice(0, 10)}...</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── Right: Dashboard ── */}
        <div className="lg:col-span-7 space-y-5">

          {/* Solver Auction Panel */}
          <div className="glass-panel p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-bold flex items-center gap-2">
                <Activity className="w-4 h-4 text-indigo-400" />
                Live Solver Auction Engine
              </h3>
              <span className="text-xs bg-white/5 text-slate-400 px-2.5 py-1 rounded-md border border-white/10">
                Promise.allSettled
              </span>
            </div>

            <div className="space-y-2.5">
              {solvers.map((solver) => (
                <div
                  key={solver.id}
                  id={`solver-${solver.id}`}
                  className={`p-3.5 rounded-xl border transition-all duration-500 flex items-center justify-between ${getSolverBorderClass(solver.state)}`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center text-lg bg-${solver.color}-500/20`}>
                      {solver.icon}
                    </div>
                    <div>
                      <div className="font-bold text-sm flex items-center gap-2">
                        {solver.name}
                        {solver.state === 'won' && <span className="text-[10px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded-full font-bold">WINNER</span>}
                        {solver.state === 'racing' && <span className="text-[10px] bg-indigo-500/20 text-indigo-400 px-1.5 py-0.5 rounded-full font-bold animate-pulse">BIDDING...</span>}
                        {solver.state === 'failed' && <span className="text-[10px] bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded-full font-bold">FAILED</span>}
                      </div>
                      <div className="text-xs text-slate-400">
                        {solver.speed} • {solver.rate} rate • {solver.fee} fee
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    {solver.quote ? (
                      <>
                        <div className="font-mono font-bold text-emerald-400 text-sm">{solver.quote}</div>
                        {solver.latency && <div className="text-xs text-slate-400">{solver.latency}ms</div>}
                      </>
                    ) : solver.state === 'racing' ? (
                      <div className="font-mono text-indigo-400 text-sm animate-pulse">—</div>
                    ) : (
                      <div className="font-mono text-slate-500 text-sm">—</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Tab bar for history */}
          <div className="glass-panel overflow-hidden">
            <div className="flex border-b border-white/10">
              <button
                onClick={() => setActiveTab('swap')}
                className={`flex-1 py-3 text-xs font-bold flex items-center justify-center gap-1.5 transition-colors ${activeTab === 'swap' ? 'text-indigo-400 border-b-2 border-indigo-400' : 'text-slate-400 hover:text-slate-200'}`}
              >
                <Layers className="w-3.5 h-3.5" /> Intent History
              </button>
              <button
                onClick={() => { setActiveTab('history'); fetchHistory(); }}
                className={`flex-1 py-3 text-xs font-bold flex items-center justify-center gap-1.5 transition-colors ${activeTab === 'history' ? 'text-indigo-400 border-b-2 border-indigo-400' : 'text-slate-400 hover:text-slate-200'}`}
              >
                <RefreshCw className="w-3.5 h-3.5" /> Live Feed
              </button>
            </div>

            <div className="p-4">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs text-slate-300">
                  <thead className="border-b border-white/10 text-slate-400 uppercase text-[10px]">
                    <tr>
                      <th className="py-2.5 pr-4">Hash</th>
                      <th className="py-2.5 pr-4">Pair</th>
                      <th className="py-2.5 pr-4">Winner Quote</th>
                      <th className="py-2.5 pr-4">Solver</th>
                      <th className="py-2.5">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5 font-mono">
                    {intents.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-8 text-center text-slate-500 font-sans">
                          No intents submitted yet. Click "Sign Intent & Swap" to test!
                        </td>
                      </tr>
                    ) : (
                      intents.map((item) => (
                        <tr key={item.intentHash} className="hover:bg-white/[0.02] transition-colors">
                          <td className="py-3 pr-4 text-indigo-400">
                            {item.intentHash.slice(0, 8)}...{item.intentHash.slice(-4)}
                          </td>
                          <td className="pr-4 text-slate-300">
                            {Object.values(TOKENS).find(t => t.address.toLowerCase() === item.intent.tokenIn.toLowerCase())?.symbol ?? 'TKA'}
                            {' ➔ '}
                            {Object.values(TOKENS).find(t => t.address.toLowerCase() === item.intent.tokenOut.toLowerCase())?.symbol ?? 'TKB'}
                          </td>
                          <td className="pr-4 text-emerald-400 font-bold">
                            {item.winnerQuote
                              ? `${(parseFloat(item.winnerQuote.amountOut) / 1e18).toFixed(4)}`
                              : '—'}
                          </td>
                          <td className="pr-4 text-slate-300">
                            {item.winnerSolverId ?? '—'}
                          </td>
                          <td>
                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold capitalize inline-flex items-center ${getStatusBadge(item.status)}`}>
                              <StatusIcon status={item.status} />
                              {item.status}
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Telemetry Console */}
          <div className="glass-panel p-4 space-y-2">
            <div className="text-xs font-bold text-slate-400 flex items-center justify-between">
              <span className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                Real-Time Telemetry
              </span>
              <button onClick={() => setLogs([])} className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors">
                Clear
              </button>
            </div>
            <div
              id="consoleBox"
              className="bg-[#05070c] rounded-xl p-3 font-mono text-[10px] h-32 overflow-y-auto space-y-0.5 border border-white/5"
            >
              {logs.map((log, i) => {
                const isSuccess = log.includes('✅') || log.includes('[Auction]') && log.includes('Winner');
                const isWarn = log.includes('[Error]') || log.includes('mock') || log.includes('Demo');
                const color = isSuccess ? 'text-emerald-400' : isWarn ? 'text-amber-400' : 'text-slate-400';
                return <div key={i} className={color}>{log}</div>;
              })}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
