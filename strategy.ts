// Dart — fast launch scalper for pump.fun bonding curves (agent-fun/replay/v2).
//
// Idea: most new pump.fun coins either rug in their first minute or run hard on genuine early
// buy pressure. Dart only buys launches where the opening tape looks organic — several distinct
// non-creator buyers, buys dominating sells, the creator not selling and not loading up — and
// then gets out fast: a small partial take-profit early, a tight stop, a short trailing stop,
// and a hard time cap. Stakes are small (0.08 SOL) so a rug costs little; winners get one add
// and a trailing ride. Tiny probe round trips keep the run above the guardrail (a round trip
// of at least 0.01 SOL on at least 20 coins) when real entries are scarce.
//
// Everything is a pure function of the batches the harness sends: no clock, no randomness, no
// I/O, so the two graded executions produce byte-identical action logs. Money is tracked in
// lamports (bigint); prices are virtual-quote / virtual-token ratios.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Lamports per coin in total (each reply is still capped at 1% of real SOL). */
  stakeLamports: bigint;
  /** Smallest single buy worth paying the tx fee for. */
  minBuyLamports: bigint;
  /** Lamports for the single add-on buy. */
  addLamports: bigint;
  /** Add needs the price this far above the last buy's decision price (bps). */
  addStepBps: number;
  /** Add only within this many slots of the first buy. */
  addWindow: number;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: bigint;
  maxRealSol: bigint;
  /** Creator's own buys in the create slot: at most this (lamports). */
  maxDevBuy: bigint;
  /** Trades seen and distinct (non-creator) buyers seen before entry, at least. */
  minTrades: number;
  minBuyers: number;
  /** Lamports sold by others / lamports bought, as bps, at most. */
  maxSellRatioBps: number;
  /** Largest single non-creator sell, as bps of the real SOL reserve before it, at most. */
  maxBigSellBps: number;
  /** Price now over the create price, as bps: at most (skip coins that already ran). */
  maxRunupBps: number;
  /** Recent-flow window (slots) and what it must show. */
  flowWindow: number;
  minFlowLamports: bigint;
  minRecentBuys: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** Sell half the position once it is worth this much over its cost (bps). */
  tp1Bps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: number;
  /** Exit when it is worth this much under its cost (bps). */
  slBps: number;
  /** Trailing stop: once up at least trailArmBps, exit on a fall of trailBps from the best value. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Guardrail pacing: target fills / coins over windowSeconds of block time. */
  fillTarget: number;
  coinTarget: number;
  windowSeconds: number;
  probeLamports: bigint;
  maxProbes: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
}

// Settings chosen on the kit's dev window (see NOTES.md): the strict organic-launch filter
// plus a mid-length hold with a 10% stop, an 8% trailing stop, a 25% first take-profit (half)
// and a 50% full take-profit. The probe targets are deliberately small — just enough to hold
// the 20-coin guardrail in a quiet window — because probe round trips cost fees and drag PnL.
export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 40,
  stakeLamports: 80_000_000n,
  minBuyLamports: 5_000_000n,
  addLamports: 80_000_000n,
  addStepBps: 800,
  addWindow: 30,
  minRealSol: 300_000_000n,
  maxRealSol: 30_000_000_000n,
  maxDevBuy: 2_000_000_000n,
  minTrades: 6,
  minBuyers: 6,
  maxSellRatioBps: 2_000,
  maxBigSellBps: 2_000,
  maxRunupBps: 13_000,
  flowWindow: 10,
  minFlowLamports: 50_000_000n,
  minRecentBuys: 3,
  skipDevSold: true,
  buySlippageBps: 1_000,
  tp1Bps: 2_500,
  tpBps: 5_000,
  slBps: 1_000,
  trailArmBps: 800,
  trailBps: 800,
  maxHold: 300,
  exitOnDevSell: true,
  staleSlots: 200,
  fillTarget: 60,
  coinTarget: 22,
  windowSeconds: 21_600,
  probeLamports: 10_000_000n,
  maxProbes: 1,
  maxExposureSol: 1,
};

const BPS = 10_000n;
const FEE_BPS = 125n; // protocol 95 + creator 30
const LAMPORTS = 1_000_000_000n;

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** The create-time reserves: the price run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  /** Trades of the last flowWindow slots (older ones dropped as new ones come). */
  recent: Tick[];
  buysSent: number;
  spentSent: bigint;
  /** Decision price (vq/vt as a pair) of the last buy sent. */
  lastBuyVq: bigint;
  lastBuyVt: bigint;
  lastBuySlot: number;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
  tookTp1: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();
  const probes = new Map<Pubkey, boolean>();
  let firstTime: number | null = null;
  let nowTime = 0;
  let myFills = 0;
  const myCoins = new Set<Pubkey>();

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          trades: 0,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          bigSellBps: 0n,
          devSold: false,
          lastTradeSlot: e.slot,
          recent: [],
          buysSent: 0,
          spentSent: 0n,
          lastBuyVq: 0n,
          lastBuyVt: 1n,
          lastBuySlot: 0,
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        if (c.recent.length > 60) c.recent.splice(0, c.recent.length - 60);
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
          const rqBefore = BigInt(e.real_quote_reserves) + sol;
          if (rqBefore > 0n) {
            const bps = (sol * BPS) / rqBefore;
            if (bps > c.bigSellBps) c.bigSellBps = bps;
          }
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  /** Net lamports bought minus sold and buy count, over the last flowWindow slots. */
  function flow(c: Coin, slot: number): { net: bigint; buys: number } {
    const from = slot - p.flowWindow;
    let net = 0n;
    let buys = 0;
    for (let i = c.recent.length - 1; i >= 0; i--) {
      const t = c.recent[i]!;
      if (t.slot <= from) break;
      if (t.isBuy) {
        net += t.sol;
        buys++;
      } else net -= t.sol;
    }
    return { net, buys };
  }

  function hasPending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
    for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === side) return true;
    return false;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      readEvents(batch);
      for (const e of batch.events) {
        if (e.block_time === null) continue;
        if (firstTime === null) firstTime = e.block_time;
        if (e.block_time > nowTime) nowTime = e.block_time;
      }
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      // Fills: track our own fills/coins and drop closed positions.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          probes.delete(f.mint);
          continue;
        }
        if (f.status === 'filled') {
          myFills++;
          myCoins.add(f.mint);
        }
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          held.set(f.mint, { openedSlot: f.slot, txPaid: BigInt(f.tx_fee_lamports), best: 0n, tookTp1: false });
        }
      }
      for (const mint of [...selling]) if (!hasPending(state, mint, 'sell')) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPending(state, mint, 'buy')) held.delete(mint);
      }

      // 1. Exits first.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, best: 0n, tookTp1: false };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          if (!h.tookTp1 && value * BPS >= basis * (BPS + BigInt(p.tp1Bps))) {
            const part = pos.token_amount / 2n;
            if (part > 0n && part < pos.token_amount) {
              orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
              selling.add(mint);
              h.tookTp1 = true;
              h.best = 0n;
              continue;
            }
          }
          if (value * BPS >= basis * (BPS + BigInt(p.tpBps))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(p.slBps))) exit = true;
          if (h.best * BPS >= basis * (BPS + BigInt(p.trailArmBps)) && value * BPS <= h.best * (BPS - BigInt(p.trailBps))) exit = true;
        }
        if (state.slot - h.openedSlot >= p.maxHold) exit = true;
        if (c !== undefined) {
          if (p.exitOnDevSell && c.devSold) exit = true;
          if (state.slot - c.lastTradeSlot >= p.staleSlots) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // 2. Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, sellingProbe] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!hasPending(state, mint, 'buy') && !hasPending(state, mint, 'sell')) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || hasPending(state, mint, 'buy') || hasPending(state, mint, 'sell')) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!sellingProbe) probes.set(mint, true);
      }

      // 3. Entries and the single add.
      let free = state.freeCashLamports();
      let open = state.committedPositionCount();
      let exposure = 0n;
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        exposure += pos !== undefined ? pos.cost_lamports : BigInt(0);
        void h;
      }
      const traded = new Set<Pubkey>();
      for (const e of batch.events) if (e.event === 'TradeEvent') traded.add(e.mint);
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        if (!traded.has(c.mint) && c.buysSent === 0) continue;
        const age = state.slot - c.createSlot;
        const isAdd = c.buysSent > 0;
        if (!isAdd && age > p.maxAge) {
          c.done = true;
          continue;
        }
        if (age < p.minAge) continue;
        if (isAdd) {
          if (c.buysSent > 1) continue;
          if (!state.positions.has(c.mint) || selling.has(c.mint) || hasPending(state, c.mint, 'buy')) continue;
          if (state.slot - c.lastBuySlot > p.addWindow) continue;
          const curve = state.curves.get(c.mint);
          if (curve === undefined || curve.complete) continue;
          const vq = curve.virtual_quote_reserves;
          const vt = curve.virtual_token_reserves;
          if (vq * c.lastBuyVt * BPS < c.lastBuyVq * vt * BigInt(10_000 + p.addStepBps)) continue;
          if (flow(c, state.slot).net < 0n) continue;
          const maxAdd = state.maxBuyLamports(c.mint);
          const amount = p.addLamports < maxAdd ? p.addLamports : maxAdd;
          if (amount < p.minBuyLamports || free < amount + tx) continue;
          if (exposure + amount > BigInt(p.maxExposureSol) * LAMPORTS) continue;
          orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
          free -= amount + tx;
          exposure += amount;
          c.buysSent += 1;
          c.spentSent += amount;
          c.lastBuyVq = vq;
          c.lastBuyVt = vt;
          c.lastBuySlot = state.slot;
          continue;
        }
        if (open >= state.hello.caps.max_open_positions) continue;
        if (probes.has(c.mint) || hasPending(state, c.mint, 'buy')) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devSold && p.skipDevSold) {
          c.done = true;
          continue;
        }
        const rq = curve.real_quote_reserves;
        if (rq < p.minRealSol || rq > p.maxRealSol) continue;
        if (c.devBuy > p.maxDevBuy) continue;
        if (c.trades < p.minTrades || c.buyers.size < p.minBuyers) continue;
        if (c.bought > 0n && c.soldByOthers * BPS > c.bought * BigInt(p.maxSellRatioBps)) continue;
        if (c.bigSellBps > BigInt(p.maxBigSellBps)) continue;
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        const runup = (vq * c.vt0 * BPS) / (vt * c.vq0);
        if (runup > BigInt(p.maxRunupBps)) continue;
        const fl = flow(c, state.slot);
        if (fl.net < p.minFlowLamports || fl.buys < p.minRecentBuys) continue;
        const room = p.stakeLamports - c.spentSent;
        if (room < p.minBuyLamports) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = room < maxBuy ? room : maxBuy;
        if (amount < p.minBuyLamports) continue;
        if (free < amount + tx) continue;
        if (exposure + amount > BigInt(p.maxExposureSol) * LAMPORTS) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        free -= amount + tx;
        exposure += amount;
        c.buysSent += 1;
        c.spentSent += amount;
        c.lastBuyVq = vq;
        c.lastBuyVt = vt;
        c.lastBuySlot = state.slot;
        open += 1;
      }

      // 4. Guardrail pacing: open a probe when fills or coins lag the pace.
      if (probes.size < p.maxProbes && firstTime !== null) {
        const pace = Math.min(1, (nowTime - firstTime) / p.windowSeconds);
        const needCoins = myCoins.size < Math.ceil(p.coinTarget * pace);
        const needFills = myFills < Math.ceil(p.fillTarget * pace);
        if ((needCoins || needFills) && open < state.hello.caps.max_open_positions) {
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || hasPending(state, mint, 'buy') || hasPending(state, mint, 'sell') || state.positions.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (curve.real_quote_reserves < (p.probeLamports * 100n) / 3n) continue;
            if (free < p.probeLamports + 2n * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: p.probeLamports, max_slippage_bps: p.buySlippageBps });
            probes.set(mint, false);
            free -= p.probeLamports + tx;
            open += 1;
          }
        }
      }
      return orders;
    },
  };
}
