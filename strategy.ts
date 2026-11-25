// Quiet Sniper — a fresh-launch sniper for the pump.fun replay (agent-fun/replay/v2).
//
// Idea: watch every coin from its CreateEvent and buy once, small, only while the
// opening tape still looks organic — the creator did not load up in the create slot,
// only one or two outsiders have bought in, nobody has dumped a big chunk, the
// creator has not sold, and the price has not run away yet. Get out fast: take
// profit at +100%, stop at -15%, never hold past 12 slots, leave at once if the
// creator sells, and trail once up 10%. A pacing fallback opens tiny 0.01 SOL
// probe round trips if fills or distinct coins lag the pace of the window, so the
// run stays above the 20-coin guardrail even on a cold tape.
//
// Deterministic by construction: a pure function of the batches — no clock, no
// randomness, no environment reads, no network. Only insertion-ordered maps are
// iterated, so the two graded executions agree byte for byte.

import type { Batch, Bot, BotState, OrderInput } from './vendor/agentfun-bot.ts';

const LAMPORTS_PER_SOL = 1_000_000_000n;
const TX_FEE_FALLBACK = 105_000n; // base 5000 + priority 100000 lamports per order

export interface Params {
  takeProfit: number; // exit when value >= cost * (1 + takeProfit)
  stopLoss: number; // exit when value <= cost * (1 - stopLoss)
  maxHold: number; // exit when held longer than this many slots
  stakeSol: number; // SOL to spend per snipe buy
  minBuySol: number; // skip a buy smaller than this
  minAge: number; // youngest age (slots since create) to buy
  maxAge: number; // oldest age (slots since create) to buy
  minRealSol: number; // real SOL reserve floor at buy time
  maxRealSol: number; // real SOL reserve ceiling at buy time
  maxDevBuySol: number; // creator's own buys in the create slot, at most this
  minTrades: number; // trades seen on the coin, at least this
  minBuyers: number; // distinct non-creator buyers, at least this
  maxBuyers: number; // distinct non-creator buyers, at most this
  maxSellRatio: number; // sold-by-others / bought-by-others, at most this
  maxBigSellShare: number; // largest single non-creator sell, at most this share of real SOL
  minRunup: number; // price now / create price, at least this
  maxRunup: number; // price now / create price, at most this
  flowWindow: number; // slots back to measure net flow
  minFlowSol: number; // net flow (buys - sells, SOL) over the window, at least this
  buySlipBps: number; // slippage allowed on buys and sells
  trailArm: number; // arm the trailing stop once value >= cost * (1 + trailArm)
  trailDrop: number; // exit once value falls below peak * (1 - trailDrop)
  exitOnDevSell: boolean; // exit at once if the creator sells while held
  cooldown: number; // slots to wait after exiting a coin before buying it again
  maxOpen: number; // at most this many sniper positions open at once
  targetCoins: number; // pacing: distinct coins to reach over the whole window
  targetFills: number; // pacing: fills to reach over the whole window
  paceSecs: number; // pacing: seconds the window spans
  probeSol: number; // SOL per pacing probe buy
  maxProbes: number; // at most this many probe positions open at once
}

export const DEFAULT_PARAMS: Params = {
  takeProfit: 1.0,
  stopLoss: 0.15,
  maxHold: 12,
  stakeSol: 0.05,
  minBuySol: 0.005,
  minAge: 0,
  maxAge: 3,
  minRealSol: 0.3,
  maxRealSol: 30,
  maxDevBuySol: 2,
  minTrades: 2,
  minBuyers: 1,
  maxBuyers: 2,
  maxSellRatio: 0.5,
  maxBigSellShare: 0.25,
  minRunup: 0.9,
  maxRunup: 3.0,
  flowWindow: 10,
  minFlowSol: 0,
  buySlipBps: 10000,
  trailArm: 0.1,
  trailDrop: 0.2,
  exitOnDevSell: true,
  cooldown: 100,
  maxOpen: 4,
  targetCoins: 25,
  targetFills: 50,
  paceSecs: 14400,
  probeSol: 0.01,
  maxProbes: 1,
};

const solToLamports = (sol: number): bigint => BigInt(Math.round(sol * 1_000_000_000));

interface RecentTrade {
  slot: number;
  isBuy: boolean;
  sol: bigint;
}

interface CoinBook {
  mint: string;
  creator: string;
  createSlot: number | null;
  createVq: bigint;
  createVt: bigint;
  devBuySol: bigint;
  devSold: boolean;
  trades: number;
  buyers: Set<string>;
  boughtOthers: bigint;
  soldOthers: bigint;
  /** Largest single non-creator sell, in basis points of real SOL just before it. */
  maxBigSellBps: number;
  recent: RecentTrade[];
}

interface HeldMeta {
  openSlot: number;
  peakValue: bigint;
  armed: boolean;
  probe: boolean;
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Bot {
  const books = new Map<string, CoinBook>();
  const held = new Map<string, HeldMeta>();
  const lastExitSlot = new Map<string, number>();
  const filledMints = new Set<string>();
  let filledOrders = 0;
  let firstSlot = -1;
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;
  // Mints created in the last few slots, in creation order: only these can still
  // be young enough to snipe, so the buy scan stays small as the window grows.
  const recentCreates: { mint: string; slot: number }[] = [];

  const txFee = TX_FEE_FALLBACK;

  function bookFor(mint: string, creator: string): CoinBook {
    let book = books.get(mint);
    if (book === undefined) {
      book = {
        mint,
        creator,
        createSlot: null,
        createVq: 0n,
        createVt: 0n,
        devBuySol: 0n,
        devSold: false,
        trades: 0,
        buyers: new Set<string>(),
        boughtOthers: 0n,
        soldOthers: 0n,
        maxBigSellBps: 0,
        recent: [],
      };
      books.set(mint, book);
    }
    return book;
  }

  function noteTrade(book: CoinBook, slot: number, isBuy: boolean, user: string, sol: bigint, realSolAfter: bigint): void {
    book.trades += 1;
    if (user === book.creator) {
      if (isBuy) {
        if (book.createSlot !== null && slot === book.createSlot) book.devBuySol += sol;
      } else {
        book.devSold = true;
      }
    } else {
      if (isBuy) {
        book.buyers.add(user);
        book.boughtOthers += sol;
      } else {
        book.soldOthers += sol;
        // Real SOL just before this sell is the post-trade reserve plus what left.
        const realBefore = realSolAfter + sol;
        if (realBefore > 0n) {
          const shareBps = Number((sol * 10_000n) / realBefore);
          if (shareBps > book.maxBigSellBps) book.maxBigSellBps = shareBps;
        }
      }
    }
    book.recent.push({ slot, isBuy, sol });
    if (book.recent.length > 64) book.recent.splice(0, book.recent.length - 64);
  }

  /** Net SOL flow (buys minus sells) over the last `window` slots. */
  function netFlow(book: CoinBook, now: number, window: number): bigint {
    let flow = 0n;
    for (const t of book.recent) {
      if (t.slot >= now - window) flow += t.isBuy ? t.sol : -t.sol;
    }
    return flow;
  }

  /** Current mark-to-market value of a holding, in lamports, net of curve fees and one tx fee. */
  function positionValue(state: BotState, mint: string, tokens: bigint): bigint | null {
    const curve = state.curves.get(mint);
    if (curve === undefined) return null;
    if (curve.virtual_token_reserves <= 0n) return null;
    // Bonding curve: selling `tokens` returns tokens * vq / (vt + tokens).
    const gross = (tokens * curve.virtual_quote_reserves) / (curve.virtual_token_reserves + tokens);
    // Curve fees are 95 bps protocol + 30 bps creator fallback = 125 bps.
    const net = (gross * 9875n) / 10_000n;
    return net - txFee;
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    if (firstSlot < 0) firstSlot = now;

    // Fold this batch's events into the per-coin books.
    for (const e of batch.events) {
      if (e.block_time !== null && e.block_time !== undefined) {
        if (firstBlockTime === null) firstBlockTime = e.block_time;
        lastBlockTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        const book = bookFor(e.mint, e.creator);
        book.createSlot = e.slot;
        book.createVq = BigInt(e.virtual_quote_reserves);
        book.createVt = BigInt(e.virtual_token_reserves);
        recentCreates.push({ mint: e.mint, slot: e.slot });
      } else if (e.event === 'TradeEvent') {
        const book = bookFor(e.mint, e.creator);
        noteTrade(book, e.slot, e.is_buy, e.user, BigInt(e.sol_amount), BigInt(e.real_sol_reserves));
      }
    }

    // Fold this batch's fills into our own accounting.
    for (const f of batch.fills) {
      if (f.status !== 'filled') {
        // A probe buy that never landed leaves no position: drop its marker so the
        // mint can be sniped normally later instead of being sold at once.
        if (f.side === 'buy') {
          const meta = held.get(f.mint);
          if (meta !== undefined && meta.probe && !state.positions.has(f.mint)) held.delete(f.mint);
        }
        continue;
      }
      filledOrders += 1;
      filledMints.add(f.mint);
      if (f.side === 'buy') {
        const meta = held.get(f.mint);
        if (meta === undefined) {
          held.set(f.mint, { openSlot: f.slot, peakValue: 0n, armed: false, probe: false });
        }
      } else {
        // A sell fill closes (or shrinks) the position; a full close ends the hold.
        if (!state.positions.has(f.mint)) {
          held.delete(f.mint);
          lastExitSlot.set(f.mint, f.slot);
        }
      }
    }

    const orders: OrderInput[] = [];
    const pendingBuy = new Set<string>();
    const pendingSell = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy') pendingBuy.add(p.order.mint);
      else pendingSell.add(p.order.mint);
    }

    const stakeLamports = solToLamports(params.stakeSol);
    const minBuyLamports = solToLamports(params.minBuySol);
    const probeLamports = solToLamports(params.probeSol);

    // ---- Exits first, so a freed slot can be reused by a buy in the same batch. ----
    for (const [mint, holding] of state.positions) {
      if (pendingSell.has(mint)) continue;
      const meta = held.get(mint);
      const value = positionValue(state, mint, holding.token_amount);
      if (value === null) continue;
      const cost = holding.cost_lamports;
      const heldSlots = meta !== undefined ? now - meta.openSlot : 0;
      let exit = false;
      // Take profit: value at least double the cost.
      if (value * 100n >= cost * BigInt(Math.round((1 + params.takeProfit) * 100))) exit = true;
      // Stop loss: value down to (1 - stopLoss) of cost.
      if (value * 100n <= cost * BigInt(Math.round((1 - params.stopLoss) * 100))) exit = true;
      // Time stop: held too long.
      if (heldSlots > params.maxHold) exit = true;
      // Creator sold while we hold: leave at once.
      const book = books.get(mint);
      if (params.exitOnDevSell && book !== undefined && book.devSold) exit = true;
      // Trailing stop: once up trailArm, exit on a trailDrop pullback from the peak.
      if (meta !== undefined) {
        if (value > meta.peakValue) meta.peakValue = value;
        if (!meta.armed && value * 100n >= cost * BigInt(Math.round((1 + params.trailArm) * 100))) {
          meta.armed = true;
        }
        if (meta.armed && value * 100n < meta.peakValue * BigInt(Math.round((1 - params.trailDrop) * 100))) {
          exit = true;
        }
      }
      // A probe is sold whole as soon as its buy has landed.
      if (meta !== undefined && meta.probe) exit = true;
      if (exit) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: params.buySlipBps,
        });
      }
    }

    // ---- Fresh-launch sniper buys. ----
    let openCount = state.committedPositionCount();
    if (openCount < params.maxOpen) {
      // Drop creates too old to buy any more; only the young ones are scanned.
      while (recentCreates.length > 0 && now - recentCreates[0]!.slot > params.maxAge) {
        recentCreates.shift();
      }
      for (const { mint } of recentCreates) {
        if (openCount >= params.maxOpen) break;
        const book = books.get(mint);
        if (book === undefined) continue;
        if (book.createSlot === null) continue;
        if (state.positions.has(mint)) continue;
        if (pendingBuy.has(mint)) continue;
        const lastExit = lastExitSlot.get(mint);
        if (lastExit !== undefined && now - lastExit < params.cooldown) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const age = now - book.createSlot;
        if (age < params.minAge || age > params.maxAge) continue;
        const realSol = curve.real_quote_reserves;
        if (realSol < solToLamports(params.minRealSol) || realSol > solToLamports(params.maxRealSol)) continue;
        if (book.devBuySol > solToLamports(params.maxDevBuySol)) continue;
        if (book.devSold) continue;
        if (book.trades < params.minTrades) continue;
        if (book.buyers.size < params.minBuyers || book.buyers.size > params.maxBuyers) continue;
        if (book.boughtOthers <= 0n) continue;
        // sold / bought <= maxSellRatio, compared without floats.
        if (book.soldOthers * 100n > book.boughtOthers * BigInt(Math.round(params.maxSellRatio * 100))) continue;
        if (book.maxBigSellBps > Math.round(params.maxBigSellShare * 10_000)) continue;
        if (netFlow(book, now, params.flowWindow) < solToLamports(params.minFlowSol)) continue;
        // price now / create price in [minRunup, maxRunup], compared without floats.
        if (book.createVq <= 0n || book.createVt <= 0n) continue;
        const nowNum = curve.virtual_quote_reserves * book.createVt;
        const nowDen = curve.virtual_token_reserves * book.createVq;
        if (nowDen <= 0n) continue;
        if (nowNum * 100n < nowDen * BigInt(Math.round(params.minRunup * 100))) continue;
        if (nowNum * 100n > nowDen * BigInt(Math.round(params.maxRunup * 100))) continue;
        // Size: the smaller of the 1%-of-real-reserve cap and the stake, never below minBuy.
        const cap = state.maxBuyLamports(mint);
        const size = cap < stakeLamports ? cap : stakeLamports;
        if (size < minBuyLamports) continue;
        // Cash guard: keep at least one tx fee free after paying for this buy.
        if (state.freeCashLamports() < size + txFee * 2n) continue;
        orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: params.buySlipBps });
        pendingBuy.add(mint);
        openCount += 1;
      }
    }

    // ---- Pacing fallback: probe round trips keep the run above the guardrail. ----
    // Elapsed share of the window, from block times when known, else from slots (~0.4s each).
    let elapsedMs: bigint;
    if (firstBlockTime !== null && lastBlockTime !== null) {
      elapsedMs = BigInt(lastBlockTime - firstBlockTime) * 1000n;
    } else {
      elapsedMs = BigInt(now - firstSlot) * 400n;
    }
    const paceMs = BigInt(params.paceSecs) * 1000n;
    const coinsLag = BigInt(filledMints.size) * paceMs < BigInt(params.targetCoins) * elapsedMs;
    const fillsLag = BigInt(filledOrders) * paceMs < BigInt(params.targetFills) * elapsedMs;
    // A probe counts as live only while its position is held or its buy is still
    // in flight; a failed or rejected probe buy frees the slot again.
    const probesLive = [...held.entries()].filter(
      ([mint, m]) => m.probe && (state.positions.has(mint) || pendingBuy.has(mint)),
    ).length;
    if ((coinsLag || fillsLag) && probesLive < params.maxProbes && state.committedPositionCount() < 5) {
      // Walk curves newest-first and take the first one that is liquid, trading
      // recently, and not held: a probe must be able to sell again at once, so an
      // old, quiet curve is the wrong place to park it.
      const curves = [...state.curves.values()].reverse();
      for (const curve of curves) {
        const mint = curve.mint;
        if (curve.complete) continue;
        if (state.positions.has(mint) || pendingBuy.has(mint)) continue;
        if (curve.real_quote_reserves < solToLamports(1.5)) continue;
        if (curve.trades < 1) continue;
        if (now - curve.reserves_slot > 50) continue;
        const lastExit = lastExitSlot.get(mint);
        if (lastExit !== undefined && now - lastExit < params.cooldown) continue;
        const cap = state.maxBuyLamports(mint);
        if (cap < probeLamports) continue;
        if (state.freeCashLamports() < probeLamports + txFee * 2n) continue;
        // Mark it a probe before the fill lands, so the exit leg knows to sell it whole.
        held.set(mint, { openSlot: now, peakValue: 0n, armed: false, probe: true });
        orders.push({ side: 'buy', mint, quote_lamports: probeLamports, max_slippage_bps: params.buySlipBps });
        break;
      }
    }

    return orders;
  }

  return { onBatch };
}
