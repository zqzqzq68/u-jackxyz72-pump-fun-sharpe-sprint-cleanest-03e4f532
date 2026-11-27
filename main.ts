// Cleanest Paper Bot — Pump.fun Sharpe Sprint
//
// Deterministic momentum-scalp bot for the agent-fun/replay/v2 protocol.
// It reads newline-delimited JSON from stdin (hello / batch / done) and
// answers every batch with one reply line on stdout.
//
// Idea, in one paragraph: buy a small fixed slice of coins whose price has
// risen a little (not a lot) on mostly-buy flow, then exit quickly on a
// modest take-profit, a tight stop, a trailing give-back, or a time limit.
// Small size, many distinct coins, and quick exits keep the hourly equity
// curve smooth, which is what an hourly Sharpe ranking rewards. Nothing
// here is random: the same replay always produces the same action log.
//
// Two facts about the harness shape the whole design. First, one batch is
// one slot's records (a slot is about 0.4 seconds), so every time window
// below is counted in slots, never in batches. Second, the marks in a batch
// only cover coins the bot already holds or has pending orders for, so all
// price discovery has to come from TradeEvents: each trade carries the
// bonding curve's post-trade reserves, and the price is the ratio of the
// virtual SOL reserves to the virtual token reserves.
//
// Money notes: each fill pays about 1.25% in protocol + creator fees plus
// 105,000 lamports of transaction fees, so a round trip costs roughly 2.7%
// of a 0.1 SOL ticket. The take-profit (+10%) and stop (-4%) brackets are
// set wider than that round-trip cost on purpose.

import * as readline from "node:readline";

// ---------------------------------------------------------------------------
// Protocol shapes (agent-fun/replay/v2). Amounts arrive as decimal strings.
// ---------------------------------------------------------------------------

interface HelloMsg {
  type: "hello";
  protocol: string;
  seed: string;
  capital: { lamports: string };
  caps: {
    max_open_positions: number;
    max_order_bps_of_real_reserve: number;
    max_orders_per_batch: number;
    shorts: boolean;
    leverage: boolean;
  };
  latency_slots: number;
  fees: {
    protocol_bps_fallback: number;
    creator_bps_fallback: number;
    base_fee_lamports: string;
    priority_fee_lamports: string;
    failed_tx_bps: number;
  };
}

interface TradeEvent {
  event: "TradeEvent";
  mint: string;
  sol_amount: string;
  token_amount: string;
  is_buy: boolean;
  virtual_sol_reserves: string;
  virtual_token_reserves: string;
  real_sol_reserves: string;
  real_token_reserves: string;
  slot: number;
}

interface CreateEvent {
  event: "CreateEvent";
  mint: string;
  virtual_token_reserves: string;
  virtual_sol_reserves: string;
  slot: number;
}

interface CompleteEvent {
  event: "CompleteEvent";
  mint: string;
  slot: number;
}

type ReplayEvent = TradeEvent | CreateEvent | CompleteEvent;

interface Mark {
  mint: string;
  slot: number;
  virtual_token_reserves: string;
  virtual_quote_reserves: string;
  real_token_reserves: string;
  real_quote_reserves: string;
}

interface Fill {
  client_id: string;
  mint: string;
  side: "buy" | "sell";
  status: "filled" | "rejected" | "failed";
  reason: string | null;
  decided_slot: number;
  slot: number;
  quote_lamports: string;
  token_amount: string;
  fee_lamports: string;
  tx_fee_lamports: string;
  fee_fallback: boolean;
}

interface Position {
  mint: string;
  token_amount: string;
  cost_lamports: string;
}

interface BatchMsg {
  type: "batch";
  seq: number;
  slot: number;
  events: ReplayEvent[];
  marks: Mark[];
  fills: Fill[];
  account: { cash_lamports: string; positions: Position[] };
}

interface DoneMsg {
  type: "done";
  seq: number;
  reason: string;
  account: { cash_lamports: string; positions: Position[] };
}

type Order =
  | {
      side: "buy";
      client_id: string;
      mint: string;
      quote_lamports: string;
      max_slippage_bps: number;
    }
  | {
      side: "sell";
      client_id: string;
      mint: string;
      token_amount: string;
      max_slippage_bps: number;
    };

// ---------------------------------------------------------------------------
// Tunables. All fixed; nothing is sampled or adapted from the clock.
// One slot is about 0.4 seconds, so 750 slots is about 5 minutes.
// ---------------------------------------------------------------------------

const BUY_LAMPORTS = 100_000_000n; // 0.1 SOL per ticket. The per-trip edge
// on this data is slightly negative, so the ticket is kept small: with
// ~800 trips in a 24-hour dev window the cumulative loss stays a small
// share of capital, and the 6-hour final window (about a quarter of the
// trips) stays far inside the 50% drawdown guardrail.
const MIN_BUY_LAMPORTS = 50_000_000n; // 0.05 SOL: below this, fees eat the edge
const CASH_BUFFER_LAMPORTS = 10_000_000n; // keep 0.01 SOL spare per buy
const MAX_BUY_SLIPPAGE_BPS = 200;
const MAX_SELL_SLIPPAGE_BPS = 500; // sells must go through even in a fast
// fall: a rejected stop-loss that strands a crashing position costs far
// more than a few hundred bps of slippage on the exit.

const MOMENTUM_SLOTS = 750; // entry momentum is measured over ~5 minutes.
const MIN_MOMENTUM_SPAN_SLOTS = 300; // the samples must span ~2 minutes
const MIN_SAMPLES_FOR_ENTRY = 5; // need a little price history before entry
const FLOW_SLOTS = 1500; // flow window for the buy/sell volume split (~10 min)
const MIN_AGE_SLOTS = 100; // a coin must be ~40 seconds old before entry
const MIN_MOMENTUM = 0.02; // need at least +2% over the momentum window.
// The filters are deliberately loose: the binding constraint is breadth,
// not per-trade edge — the final window is 6 hours, a quarter of this dev
// window, and the guardrail needs 20 distinct round-tripped coins there,
// so the dev window must show roughly 80+ distinct coins for margin.
const MAX_MOMENTUM = 0.35; // skip coins that already ran +35% (reversion risk)
const MIN_WINDOW_VOLUME_SOL = 0.2; // need at least 0.2 SOL of flow in window
const MIN_BUY_SHARE = 0.52; // buys must be at least 52% of window flow

const TAKE_PROFIT = 0.1; // sell at +10% from the filled entry price
const STOP_LOSS = -0.04; // sell at -4% from the filled entry price
const TRAIL_TRIGGER = 0.05; // trailing exit arms once the peak is +5%
const TRAIL_GIVEBACK = 0.03; // then sell after a 3% fall from the peak
const MAX_HOLD_SLOTS = 3000; // flat time exit after ~20 minutes, win or lose
const PENDING_BUY_EXPIRY_SLOTS = 100; // a buy with no fill after ~40 seconds
// is treated as never placed, so a stuck pending ticket cannot block the
// position budget forever.

const DISTINCT_TARGET = 20; // guardrail: round-trip at least 20 mints
const SAMPLE_CAP = 240; // price samples kept per mint (oldest pruned)

// ---------------------------------------------------------------------------
// Per-mint state. Prices come from trade post-states, one sample per slot
// at most; flow is one buy/sell SOL aggregate per slot at most.
// ---------------------------------------------------------------------------

interface PriceSample {
  slot: number;
  price: number;
}

interface FlowSample {
  slot: number;
  buySol: number;
  sellSol: number;
}

interface MintState {
  samples: PriceSample[];
  flows: FlowSample[];
  firstSlot: number; // slot where the mint was first seen
  completed: boolean; // a CompleteEvent arrived for this mint
  realQuote: bigint; // latest real quote reserves, for the order-size cap
  lastPrice: number; // latest known price, 0 when never priced
}

interface OpenTrade {
  entryPrice: number; // filled price: quote paid / tokens received
  peakPrice: number; // highest price seen while holding
  entrySlot: number; // slot of the buy fill
}

const mints = new Map<string, MintState>();
const openTrades = new Map<string, OpenTrade>();
const roundTripped = new Set<string>();
// Buys sent but not yet answered by a fill: they will occupy a position
// slot in two slots' time, so they must count against the open-position
// budget now, or the next batch over-buys and the harness rejects the
// excess with max_open_positions. Keyed by mint, valued by the slot sent.
const pendingBuys = new Map<string, number>();

let capitalLamports = 0n;
let maxOpenPositions = 5;
let maxOrderBps = 100;
let maxOrdersPerBatch = 16;
let curSlot = 0;
let orderCounter = 0;

function mintState(mint: string, slot: number): MintState {
  let st = mints.get(mint);
  if (st === undefined) {
    st = {
      samples: [],
      flows: [],
      firstSlot: slot,
      completed: false,
      realQuote: 0n,
      lastPrice: 0,
    };
    mints.set(mint, st);
  }
  return st;
}

// Price of one token in lamports from bonding-curve reserves. Returns 0
// on degenerate reserves instead of dividing by zero.
function reservesPrice(virtualQuote: bigint, virtualTokens: bigint): number {
  if (virtualTokens <= 0n || virtualQuote <= 0n) return 0;
  return Number(virtualQuote) / Number(virtualTokens);
}

// Record one price sample, at most one per slot (a later trade in the same
// slot overwrites the earlier one: the newest post-state is the price).
function recordPrice(st: MintState, slot: number, price: number): void {
  if (price <= 0) return;
  const last = st.samples[st.samples.length - 1];
  if (last !== undefined && last.slot === slot) {
    last.price = price;
  } else {
    st.samples.push({ slot, price });
    if (st.samples.length > SAMPLE_CAP) st.samples.shift();
  }
  st.lastPrice = price;
}

// Sum of buy and sell SOL inside the flow window ending at curSlot.
function windowFlow(st: MintState): { buy: number; sell: number } {
  let buy = 0;
  let sell = 0;
  const floor = curSlot - FLOW_SLOTS;
  for (let i = st.flows.length - 1; i >= 0; i--) {
    const f = st.flows[i]!;
    if (f.slot < floor) break;
    buy += f.buySol;
    sell += f.sellSol;
  }
  return { buy, sell };
}

// ---------------------------------------------------------------------------
// Entry screen. Returns true only for a coin that is rising on buy flow,
// has not run away yet, and is fresh enough to be worth a ticket.
// ---------------------------------------------------------------------------

function entrySignal(mint: string): boolean {
  const st = mints.get(mint);
  if (st === undefined) return false;
  if (st.completed) return false;
  if (openTrades.has(mint)) return false;
  if (pendingBuys.has(mint)) return false; // a buy is already in flight
  if (curSlot - st.firstSlot < MIN_AGE_SLOTS) return false;
  if (st.samples.length < MIN_SAMPLES_FOR_ENTRY) return false;
  if (st.lastPrice <= 0) return false;

  // Momentum over the last few minutes: the oldest sample inside the
  // window is the base. The samples must actually span enough time.
  const floor = curSlot - MOMENTUM_SLOTS;
  let base: PriceSample | undefined;
  for (const s of st.samples) {
    if (s.slot >= floor) {
      base = s;
      break;
    }
  }
  if (base === undefined) return false;
  if (curSlot - base.slot < MIN_MOMENTUM_SPAN_SLOTS) return false;
  const momentum = st.lastPrice / base.price - 1;
  if (momentum < MIN_MOMENTUM || momentum > MAX_MOMENTUM) return false;
  // Still rising on the latest sample, not already rolling over.
  const n = st.samples.length;
  if (n >= 2) {
    const prev = st.samples[n - 2]!;
    if (st.lastPrice < prev.price) return false;
  }

  // Flow must be real and buy-dominated over the recent window.
  const flow = windowFlow(st);
  const totalVol = flow.buy + flow.sell;
  if (totalVol < MIN_WINDOW_VOLUME_SOL) return false;
  if (flow.buy / totalVol < MIN_BUY_SHARE) return false;

  // Until the distinct-mint guardrail is met, spend tickets on new coins
  // only; afterwards a re-entry on a proven coin is allowed.
  if (roundTripped.size < DISTINCT_TARGET && roundTripped.has(mint)) {
    return false;
  }
  return true;
}

// Ticket size for one buy, clamped by the harness order-size cap (a share
// of the coin's real reserves) and floored so fees stay a small fraction.
function ticketSize(mint: string, cash: bigint): bigint | null {
  const st = mints.get(mint);
  if (st === undefined || st.realQuote <= 0n) return null;
  const cap = (st.realQuote * BigInt(maxOrderBps)) / 10000n;
  let size = BUY_LAMPORTS;
  const softCap = (cap * 9n) / 10n;
  if (size > softCap) size = softCap;
  if (size < MIN_BUY_LAMPORTS) return null;
  if (cash < size + CASH_BUFFER_LAMPORTS) return null;
  return size;
}

// ---------------------------------------------------------------------------
// Exit screen for one open trade. Returns a reason string, or null to hold.
// ---------------------------------------------------------------------------

function exitReason(mint: string, price: number): string | null {
  const trade = openTrades.get(mint);
  if (trade === undefined || trade.entryPrice <= 0 || price <= 0) return null;
  if (price > trade.peakPrice) trade.peakPrice = price;
  const ret = price / trade.entryPrice - 1;
  if (ret >= TAKE_PROFIT) return "take-profit";
  if (ret <= STOP_LOSS) return "stop-loss";
  if (trade.peakPrice / trade.entryPrice - 1 >= TRAIL_TRIGGER) {
    if (price / trade.peakPrice - 1 <= -TRAIL_GIVEBACK) return "trailing";
  }
  if (curSlot - trade.entrySlot >= MAX_HOLD_SLOTS) return "time-exit";
  return null;
}

// ---------------------------------------------------------------------------
// One batch: absorb events and marks, apply fills, then decide sells/buys.
// ---------------------------------------------------------------------------

function onBatch(msg: BatchMsg): Order[] {
  curSlot = msg.slot;
  const orders: Order[] = [];

  // Per-mint aggregates for this slot: flow totals and the last post-trade
  // price. A slot usually carries few trades, so these maps stay small.
  const slotBuy = new Map<string, number>();
  const slotSell = new Map<string, number>();
  const slotPrice = new Map<string, number>();
  const slotRealQuote = new Map<string, bigint>();
  for (const ev of msg.events) {
    if (ev.event === "TradeEvent") {
      const sol = Number(BigInt(ev.sol_amount)) / 1e9;
      const bucket = ev.is_buy ? slotBuy : slotSell;
      bucket.set(ev.mint, (bucket.get(ev.mint) ?? 0) + sol);
      const price = reservesPrice(
        BigInt(ev.virtual_sol_reserves),
        BigInt(ev.virtual_token_reserves),
      );
      slotPrice.set(ev.mint, price);
      slotRealQuote.set(ev.mint, BigInt(ev.real_sol_reserves));
      mintState(ev.mint, curSlot);
    } else if (ev.event === "CreateEvent") {
      const st = mintState(ev.mint, curSlot);
      const price = reservesPrice(
        BigInt(ev.virtual_sol_reserves),
        BigInt(ev.virtual_token_reserves),
      );
      recordPrice(st, curSlot, price);
    } else if (ev.event === "CompleteEvent") {
      mintState(ev.mint, curSlot).completed = true;
    }
  }
  for (const [mint, price] of slotPrice) {
    const st = mints.get(mint);
    if (st === undefined) continue;
    recordPrice(st, curSlot, price);
    const rq = slotRealQuote.get(mint);
    if (rq !== undefined) st.realQuote = rq;
  }
  const flowed = new Set<string>([...slotBuy.keys(), ...slotSell.keys()]);
  for (const mint of flowed) {
    const st = mints.get(mint);
    if (st === undefined) continue;
    st.flows.push({
      slot: curSlot,
      buySol: slotBuy.get(mint) ?? 0,
      sellSol: slotSell.get(mint) ?? 0,
    });
    if (st.flows.length > SAMPLE_CAP) st.flows.shift();
  }

  // Marks only cover held or pending coins: use them to refresh the price
  // and reserves of positions, never for discovering new coins.
  for (const mark of msg.marks) {
    const st = mints.get(mark.mint);
    if (st === undefined) continue;
    const price = reservesPrice(
      BigInt(mark.virtual_quote_reserves),
      BigInt(mark.virtual_token_reserves),
    );
    if (price > 0) st.lastPrice = price;
    st.realQuote = BigInt(mark.real_quote_reserves);
  }

  // Fills are the truth about what we own and at what price: a buy fill
  // opens the trade, a sell fill closes it and counts the round trip.
  // Any fill answering a buy — filled, rejected or failed — clears that
  // buy from the pending set, so the budget it reserved is released.
  for (const fill of msg.fills) {
    if (fill.side === "buy") pendingBuys.delete(fill.mint);
    if (fill.status !== "filled") continue;
    if (fill.side === "buy") {
      const tokens = BigInt(fill.token_amount);
      const quote = BigInt(fill.quote_lamports);
      if (tokens > 0n && quote > 0n) {
        const price = Number(quote) / Number(tokens);
        openTrades.set(fill.mint, {
          entryPrice: price,
          peakPrice: price,
          entrySlot: curSlot,
        });
      }
    } else if (fill.side === "sell") {
      if (openTrades.has(fill.mint)) {
        openTrades.delete(fill.mint);
        roundTripped.add(fill.mint);
      }
    }
  }

  // A pending buy with no answer for a long time is treated as never
  // placed, so a lost fill cannot block the position budget forever.
  for (const [mint, sentSlot] of [...pendingBuys.entries()]) {
    if (curSlot - sentSlot >= PENDING_BUY_EXPIRY_SLOTS) {
      pendingBuys.delete(mint);
    }
  }

  // Positions from the account are the other source of truth: drop trade
  // records for mints the account no longer holds (for example a sell
  // that filled under a harness-generated client id).
  const held = new Map<string, bigint>();
  for (const pos of msg.account.positions) {
    held.set(pos.mint, BigInt(pos.token_amount));
  }
  for (const mint of [...openTrades.keys()]) {
    if (!held.has(mint)) openTrades.delete(mint);
  }
  const cash = BigInt(msg.account.cash_lamports);

  // Sells first, in mint order so the log is deterministic.
  const selling = new Set<string>();
  const heldMints = [...held.keys()].sort();
  for (const mint of heldMints) {
    const st = mints.get(mint);
    const price = st === undefined ? 0 : st.lastPrice;
    if (price <= 0) continue;
    if (exitReason(mint, price) === null) continue;
    const tokens = held.get(mint);
    if (tokens === undefined || tokens <= 0n) continue;
    orderCounter += 1;
    orders.push({
      side: "sell",
      client_id: `s${orderCounter}`,
      mint,
      token_amount: tokens.toString(),
      max_slippage_bps: MAX_SELL_SLIPPAGE_BPS,
    });
    selling.add(mint);
  }

  // Buys next: scan every tracked mint in sorted order and take the first
  // signals that fit the open-position budget and the per-batch cap.
  // Pending buys already reserve slots, so they count against the budget.
  const freeSlots =
    maxOpenPositions - held.size - pendingBuys.size + selling.size;
  if (freeSlots > 0 && orders.length < maxOrdersPerBatch) {
    let bought = 0;
    const candidates = [...mints.keys()].sort();
    for (const mint of candidates) {
      if (bought >= freeSlots) break;
      if (orders.length >= maxOrdersPerBatch) break;
      if (held.has(mint) && !selling.has(mint)) continue;
      if (!entrySignal(mint)) continue;
      const size = ticketSize(mint, cash);
      if (size === null) continue;
      orderCounter += 1;
      orders.push({
        side: "buy",
        client_id: `b${orderCounter}`,
        mint,
        quote_lamports: size.toString(),
        max_slippage_bps: MAX_BUY_SLIPPAGE_BPS,
      });
      pendingBuys.set(mint, curSlot);
      bought += 1;
    }
  }

  return validateReply(orders, held);
}

// ---------------------------------------------------------------------------
// Reply validation: re-read the orders we are about to send and drop any
// that break the protocol before they reach the harness. A bad line would
// fail the whole batch, so a dropped order is always the cheaper mistake.
// ---------------------------------------------------------------------------

function validateReply(orders: Order[], held: Map<string, bigint>): Order[] {
  const seenIds = new Set<string>();
  const kept: Order[] = [];
  for (const order of orders) {
    if (seenIds.has(order.client_id)) continue;
    seenIds.add(order.client_id);
    if (kept.length >= maxOrdersPerBatch) break;
    if (order.side === "buy") {
      const amount = BigInt(order.quote_lamports);
      if (amount <= 0n) continue;
      if (order.max_slippage_bps < 0 || order.max_slippage_bps > 10000) {
        continue;
      }
    } else {
      const amount = BigInt(order.token_amount);
      if (amount <= 0n) continue;
      const owned = held.get(order.mint) ?? 0n;
      if (amount > owned) continue;
    }
    kept.push(order);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Main loop: one reply per batch, nothing on hello, clean exit on done.
// ---------------------------------------------------------------------------

function onHello(msg: HelloMsg): void {
  capitalLamports = BigInt(msg.capital.lamports);
  maxOpenPositions = msg.caps.max_open_positions;
  maxOrderBps = msg.caps.max_order_bps_of_real_reserve;
  maxOrdersPerBatch = msg.caps.max_orders_per_batch;
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line: string) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let msg: HelloMsg | BatchMsg | DoneMsg;
  try {
    msg = JSON.parse(trimmed) as HelloMsg | BatchMsg | DoneMsg;
  } catch {
    return;
  }
  if (msg.type === "hello") {
    onHello(msg as HelloMsg);
  } else if (msg.type === "batch") {
    const batch = msg as BatchMsg;
    const orders = onBatch(batch);
    process.stdout.write(
      JSON.stringify({ type: "reply", seq: batch.seq, orders }) + "\n",
    );
  } else if (msg.type === "done") {
    lines.close();
  }
});
lines.on("close", () => {
  process.exit(0);
});
