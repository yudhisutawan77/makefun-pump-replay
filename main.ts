// Pump.fun Replay Sprint — Paper Bot (pumpfun-replay/v2, Node 22).
//
// Strategy: buy at launch with tight exits, on 10 SOL of paper money.
// The harness sends a hello first, then one batch per slot; this bot answers
// every batch with its orders for that slot. Everything here is deterministic:
// no clock, no environment, no Math.random — the same replay always produces
// the same action log, which the grader requires (two runs must match byte
// for byte).
//
// How it trades:
//  1. WATCH — every new curve is watched from its first sighting. Its opening
//     price is the virtual-quote / virtual-token reserve ratio at first sight.
//  2. BUY — buy at launch: once a coin has traded at least once and its
//     price has not dipped below its opening price, buy 0.05 SOL (or the
//     1%-of-real-reserve size cap when smaller, never below 0.02 SOL). One
//     buy per coin, at most 5 open positions at once. Buying at launch,
//     instead of chasing a rise, is what the dev window rewards: the kit's
//     own momentum pilot loses 9.5 SOL chasing rises, while buying early
//     and holding is near break-even.
//  3. SELL — a whole position is sold when its price reaches +100% over the
//     entry price (take profit — let a migrating coin run), falls to -40%
//     (stop loss), or 75,000 slots pass without either trigger (time exit,
//     so capital keeps cycling instead of sitting in dead coins).
//
// Costs per round trip: ~1.25% curve fees per leg plus 105,000 lamports of
// transaction fees per order, so a trade needs roughly a 3% move to break
// even. The +100% / -40% exits are set well clear of that. The 0.05 SOL stake
// and the 20-coin minimum bar (each round trip at least 0.01 SOL) are met by
// design: every buy is 0.02 SOL or more and the trigger is loose enough to
// fire on many fresh coins across a 24-hour window.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from "./vendor/makefun-bot.ts";

// --- Tunables (all in one place, so a sweep only touches these) ---------
const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 20n; // 0.05 SOL per buy
const MIN_STAKE_LAMPORTS = LAMPORTS_PER_SOL / 50n; // 0.02 SOL floor per buy
const MIN_TRADES = 1; // trades seen before a coin can trigger
const MIN_RISE_BPS = 0; // buy at launch unless the price already dipped
const MAX_RISE_BPS = 8_000; // +80%: do not chase a coin that already ran
const TAKE_PROFIT_BPS = 10_000; // +100% over entry price: let winners run
const STOP_LOSS_BPS = 4_000; // -40% under entry price
const MAX_HOLD_SLOTS = 75_000; // time exit, in slots (~8.3 hours)
const MAX_SLIPPAGE_BPS = 10_000; // wide open: never refuse on latency drift

// --- Price maths (bigint ratios, so no float rounding anywhere) ---------
//
// A price is virtual_quote_reserves / virtual_token_reserves. To test
// "priceNow is at least (10000 + bps)/10000 of priceRef" without division:
//   vqNow * vtRef * 10000 >= vqRef * vtNow * (10000 + bps)
interface Quote {
  vq: bigint;
  vt: bigint;
}

function atLeastRisen(now: Quote, ref: Quote, bps: number): boolean {
  const target = 10_000n + BigInt(bps);
  return now.vq * ref.vt * 10_000n >= ref.vq * now.vt * target;
}

function atLeastFallen(now: Quote, ref: Quote, bps: number): boolean {
  // priceNow <= priceRef * (10000 - bps) / 10000
  const target = 10_000n - BigInt(bps);
  return now.vq * ref.vt * 10_000n <= ref.vq * now.vt * target;
}

function curveQuote(state: BotState, mint: string): Quote | null {
  const curve = state.curves.get(mint);
  if (curve === undefined || curve.complete) return null;
  if (curve.virtual_token_reserves <= 0n) return null;
  return {
    vq: curve.virtual_quote_reserves,
    vt: curve.virtual_token_reserves,
  };
}

// --- Per-coin memory -----------------------------------------------------
//
// opening: price at first sighting, plus the slot it was first seen.
// decided: mints already bought or permanently skipped (one shot per coin).
// entries: entry price + decision slot for each open position, keyed by mint.
interface Entry {
  price: Quote;
  slot: number;
}

const opening = new Map<string, Quote>();
const decided = new Set<string>();
const entries = new Map<string, Entry>();
// Mints with a sell already in flight, so a batch never double-sells.
const selling = new Set<string>();

function noteOpenings(state: BotState, batch: Batch): void {
  for (const event of batch.events) {
    if (event.event === "CompleteEvent") {
      opening.delete(event.mint);
      entries.delete(event.mint);
      selling.delete(event.mint);
      continue;
    }
    if (!opening.has(event.mint)) {
      const quote = curveQuote(state, event.mint);
      if (quote !== null) opening.set(event.mint, quote);
    }
  }
}

function forgetSettledFills(state: BotState, batch: Batch): void {
  for (const fill of batch.fills) {
    if (fill.side === "sell" && fill.status === "filled") {
      selling.delete(fill.mint);
      entries.delete(fill.mint);
    }
    if (fill.side === "buy" && fill.status !== "filled") {
      // A buy that never landed frees nothing: the coin stays decided and
      // its entry record is dropped so a later position cannot inherit it.
      entries.delete(fill.mint);
    }
  }
}

// --- Sell pass: exits for every open position ---------------------------
function sellOrders(state: BotState): SellInput[] {
  const orders: SellInput[] = [];
  for (const [mint, holding] of state.positions) {
    if (selling.has(mint)) continue;
    if (holding.token_amount <= 0n) continue;
    const entry = entries.get(mint);
    const quote = curveQuote(state, mint);
    if (quote === null) continue;
    const exitByPrice =
      entry !== undefined &&
      (atLeastRisen(quote, entry.price, TAKE_PROFIT_BPS) ||
        atLeastFallen(quote, entry.price, STOP_LOSS_BPS));
    const exitByTime =
      entry !== undefined && state.slot - entry.slot >= MAX_HOLD_SLOTS;
    if (!exitByPrice && !exitByTime) continue;
    orders.push({
      side: "sell",
      mint,
      token_amount: holding.token_amount,
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    });
    selling.add(mint);
  }
  return orders;
}

// --- Buy pass: one momentum trigger per fresh coin -----------------------
function buyOrders(state: BotState, batch: Batch, alreadyOrdered: number): BuyInput[] {
  const { caps } = state.hello;
  const tx = state.txFeeLamports();
  const orders: BuyInput[] = [];
  let free = state.freeCashLamports();
  let slots = caps.max_open_positions - state.committedPositionCount();
  for (const event of batch.events) {
    if (alreadyOrdered + orders.length >= caps.max_orders_per_batch) break;
    if (slots <= 0) break;
    if (event.event !== "TradeEvent" && event.event !== "CreateEvent") continue;
    const mint = event.mint;
    if (decided.has(mint)) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) {
      decided.add(mint);
      continue;
    }
    if (curve.trades < MIN_TRADES) continue;
    const open = opening.get(mint);
    const now = curveQuote(state, mint);
    if (open === undefined || now === null) continue;
    // Wait for the trigger window: up enough to show momentum, not so far
    // up that the move is already over.
    if (!atLeastRisen(now, open, MIN_RISE_BPS)) continue;
    if (atLeastRisen(now, open, MAX_RISE_BPS)) {
      decided.add(mint);
      continue;
    }
    const cap = state.maxBuyLamports(mint);
    if (cap < MIN_STAKE_LAMPORTS) continue;
    const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
    if (free < amount + tx) {
      // Out of cash this batch: leave the coin undecided so a later batch
      // can still take it once a position closes and frees cash.
      continue;
    }
    decided.add(mint);
    entries.set(mint, { price: now, slot: state.slot });
    orders.push({
      side: "buy",
      mint,
      quote_lamports: amount,
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    });
    free -= amount + tx;
    slots -= 1;
  }
  return orders;
}

// --- Wire-up --------------------------------------------------------------
await runBot({
  onBatch(state, batch) {
    noteOpenings(state, batch);
    forgetSettledFills(state, batch);
    const sells = sellOrders(state);
    const buys = buyOrders(state, batch, sells.length);
    const orders: OrderInput[] = [...sells, ...buys];
    return orders.slice(0, state.hello.caps.max_orders_per_batch);
  },
  onDone(state, done) {
    const cash = state.account.cash_lamports;
    const held = state.account.positions.length;
    console.error(
      `[pump-replay] done: cash=${cash} lamports, open_positions=${held}`,
    );
  },
});
