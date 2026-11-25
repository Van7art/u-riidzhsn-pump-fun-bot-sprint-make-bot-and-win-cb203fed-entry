# NOTES — Dart (Pump.fun Bot Sprint)

## Competition

- "Pump.fun Bot Sprint: Make Bot And Win", slug `u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed`
- Harness `pumpfun-replay/v2`, runtimes node22 / python3.13, capital 10 SOL, no shorts, no leverage.
- Caps: max 5 open positions, max order 1% of real SOL reserve per reply per mint, max 16 orders per batch, 2-slot latency.
- Fees: protocol 95 bps + creator 30 bps on curve trades, base 5,000 + priority 100,000 lamports per tx, 2% failed-tx draw (seeded).
- Guardrails: a round trip of at least 0.01 SOL on each of at least 20 coins; max drawdown 50%; net PnL above 0 SOL after every fee qualifies for a prize; ranking by net PnL, highest first.
- Final window: 6 hours of fresh pump.fun chain data recorded after entries close (2026-11-28T08:00Z). Entries close 2026-11-28T08:00Z (16:00 WITA 28 Nov).

## Strategy (Dart)

A fast launch scalper. Every coin is watched from its CreateEvent. A first buy is decided
only in the first 40 slots, and only when the opening tape looks organic:

- at least 6 distinct non-creator buyers and 6 trades seen;
- buys dominate sells (sold-by-others at most 20% of bought);
- no single non-creator sell above 20% of the real SOL reserve before it;
- the creator has not sold, and the creator's own buy in the create slot is at most 2 SOL;
- real SOL reserve between 0.3 and 30;
- price run-up from creation at most 30%;
- net flow over the last 10 slots at least 0.05 SOL with at least 3 buys.

Stake is 0.08 SOL per coin (capped by the 1%-of-real-reserve rule), with one add of 0.08 SOL
while the price is at least 8% above the last buy and flow is still positive, within 30 slots.

Exits (checked every batch, exits first): sell half at +25% over cost; full exit at +50%,
at −10% (stop loss), on a trailing stop of 8% once up 8%, after 300 slots held, when the
creator sells, or when the coin goes 200 slots without a trade. Positions in completed
curves are closed by the replay.

Tiny probe round trips (0.01 SOL buy, sold as soon as it lands) keep the run above the
guardrail when real entries are scarce. The probe targets are deliberately small
(22 coins / 60 fills over the window) because probe round trips cost fees and drag PnL.

Risk limits: at most 1 SOL at cost across all positions at once; at most 5 open positions
(the harness cap); every order respects the 1% real-reserve cap and the 16-orders-per-batch
cap; sells always go out at 10,000 bps slippage, buys at 1,000 bps.

## Variants built and compared (kit dev window, 24h, 1,222 coins)

Backtested offline on the kit's frozen dev dataset with a local port of the harness market
model (constant-product quotes, 1.25% curve fees, 2-slot latency, seeded 2% failed txs).
Numbers are the mean over 4 failed-tx seeds unless noted.

| Variant | Net PnL (SOL) | Max DD | Trips / wins | Fills | Coins |
|---|---|---|---|---|---|
| V1 Surge (momentum, pyramid) | −1.93 | 0.19 | 359 / 54 | 869 | 209 |
| V2 Dip (mean reversion) | −3.71 | 0.46 | 428 / 115 | 2,339 | 199 |
| V3 Dart (default params) | −0.30 | 0.04 | 197 / 28 | 430 | 145 |
| V3 Dart, strict entry + mid exits | −0.006 | 0.010 | 163 / 16 | 343 | 79 |
| **V3 Dart, chosen params** | **+0.086** | **0.004** | **48 / 14** | **106** | **43** |

House pilots on the same window, for reference: sniper −0.48 SOL, reversion −3.91 SOL,
momentum −9.59 SOL. Dart's chosen params beat all of them.

Chosen params (in `strategy.ts` DEFAULT_PARAMS): minBuyers 6, maxSellRatio 20%,
minFlow 0.05 SOL, maxRunup +30%, maxAge 40 slots, stake 0.08 SOL, tp1 +25% (sell half),
TP +50%, SL −10%, trail 8% after +8%, maxHold 300 slots, stale 200 slots,
probe targets 22 coins / 60 fills.

## Robustness of the chosen params

- 4 failed-tx seeds: mean +0.086 SOL, worst +0.084, best +0.087.
- Net PnL without the single best round trip: +0.036 SOL (the result is not one lucky coin).
- At 2x fees: +0.037 SOL.
- Six-hour slices of the dev window (fresh coins only): −0.007 / −0.017 / +0.100 / −0.008 SOL,
  each slice meeting the guardrail (23–26 coins with round trips ≥ 0.01 SOL).
- Guardrail on the full window: 43 coins with round trips ≥ 0.01 SOL (need ≥ 20), max
  drawdown 0.4% (limit 50%).

## What the data said

- 70% of dev-window coins reach +25% within 60 slots of creation and 29% reach 2x, but the
  median coin ends its first 300 slots near flat — the edge is selection plus letting
  winners run, not holding everything.
- Coins with a strong early tape (≥6 buyers, ≥0.1 SOL of buys, sells ≤ a third of buys,
  creator not sold) reach +50% 89% of the time vs 45% otherwise — the entry filter is
  built on exactly that.
- Buying into a run-up above +30% destroys PnL (−0.13 SOL in testing vs −0.003 at the
  +30% cap); the cap stays.
- Probe round trips are a cost, not a profit centre: a 300-fill pacing target cost ~0.05 SOL
  versus the 60-fill target. Targets are set to the minimum that holds the guardrail.

## Caveats

- The dev window (2–3 Nov 2026) is one 24-hour sample; the final window is 6 hours of fresh
  data on 28 Nov 2026. Time-of-day effects were visible in the dev data (entries clustered
  in the early hours), so the final result may differ. Params were picked from the middle of
  a flat, near-breakeven region rather than a single best cell, and verified across fail
  seeds, fee levels, and time slices — but no backtest guarantees the final window.
- The bot never uses the clock, randomness, or the network; it is a pure function of the
  batches, so the two graded executions produce byte-identical action logs.
