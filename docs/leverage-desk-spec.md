# Leverage desk — implementation spec for Gotchi-Trader

**Target repo:** `~/Dev/Gotchi-Trader` (iMac). **Owner:** trader desk hero
(`starter-link-h1-1`). **Written by:** Hub Claude, 2026-09-05.

Gotchi-Trader is spot-only today. `packages/execution` is
`quote / riskGate / router / uniswapSwap`; `StrategyDefinition` has no side, no
leverage, no funding, no liquidation. Every "leverage" string in the repo is
prose in a strategy description. So this is a new capability, not a tweak.

Goal: **the desk learns how leveraged strategies actually perform** — backtest
over historical funding to rank candidates, paper-forward on live rates to
confirm the survivors.

**Paper only.** Nothing here enables live execution, and no step may. The
existing hard rule stands.

---

## 1. Venues

Two adapters behind one interface. **GMX is the default**; Gains is the second
implementation that proves the interface isn't GMX-shaped.

| | GMX v2 | Gains (gTrade) |
|---|---|---|
| Chains | Arbitrum One, Avalanche | Arbitrum, Polygon, **Base** |
| Cost model | funding between longs/shorts **plus** borrowing fee to LPs, **plus** price impact on OI imbalance | vault-based: opening fee, **rollover** fee, closing fee, spread — no trader-to-trader funding |
| Why it matters | funding can flip sign; a crowded side pays | rollover accrues regardless of which side is crowded |

Gains on Base is the one that matches the rest of the stack — worth having even
though GMX is default.

**Read every number from the venue, never hardcode.** Max leverage, maintenance
margin, fee bps and impact parameters are per-market and change. An adapter that
bakes in "0.05%" is wrong the week the market updates. Fetch from the venue's
reader contracts or subgraph at ingest time and record what was fetched.

## 2. Types (`packages/core/src/types.ts`)

```ts
export type PerpVenue = "gmx" | "gains";
export type PositionSide = "long" | "short";

export interface LeverageConfig {
  venue: PerpVenue;              // default "gmx"
  targetLeverage: number;        // notional / collateral at entry
  maxLeverage: number;           // hard cap; must be <= the market's own max
  sides: PositionSide[];         // ["long"], ["short"], or both
  collateralUsdc: number;        // margin committed per position
  maintenanceMarginPct?: number; // venue/market default when absent
  maxFundingBpsPerDay?: number;  // refuse to open (and exit) above this
}
```

- `StrategyDefinition` gains `leverage?: LeverageConfig`. Absent ⇒ spot, exactly
  as today. **No existing strategy changes behaviour.**
- `StrategySignal` gains `side?: PositionSide` and `leverage?: number`.
  A spot strategy keeps emitting `buy/sell/hold` and is unaffected.

```ts
export interface PerpPosition {
  id: string;
  strategyId: string;
  venue: PerpVenue;
  market: string;              // venue's market id, not just a symbol
  side: PositionSide;
  collateralUsdc: number;
  notionalUsd: number;         // collateral * leverage at entry
  entryPrice: number;
  openedAt: string;
  fundingPaidUsdc: number;     // signed: negative means received
  borrowPaidUsdc: number;
  feesPaidUsdc: number;        // open + close + impact
  liquidationPrice: number;
  lastMarkPrice: number;
  status: "open" | "closed" | "liquidated";
}
```

## 3. Adapter interface (new package `packages/perps`)

```ts
export interface PerpVenueAdapter {
  id: PerpVenue;
  markets(): Promise<PerpMarket[]>;               // id, symbol, chain, maxLeverage,
                                                  // maintenanceMarginPct, minCollateralUsd
  rates(marketId: string): Promise<RateSnapshot>; // fundingBpsPerHour (signed, per side),
                                                  // borrowBpsPerHour, openInterestLongUsd/ShortUsd, at
  fees(marketId: string, notionalUsd: number, side: PositionSide):
    Promise<{ openBps: number; closeBps: number; priceImpactBps: number }>;
  liquidationPrice(pos: PerpPosition, market: PerpMarket): number;   // pure
  historicalRates(marketId: string, fromIso: string, toIso: string): Promise<RateBar[]>;
}
```

`historicalRates` is what makes backtesting honest, and it is the piece the repo
does not have in any form — treat it as the long pole, not an afterthought.

## 4. Paper engine — per bar, in this order

Order matters; getting it wrong flatters leverage.

1. **Mark**: `pnlUsd = dir * (mark - entry) / entry * notionalUsd` where
   `dir = +1` long, `-1` short.
2. **Accrue** funding and borrow on **notional**, not collateral:
   `notionalUsd * rateBpsPerHour/10_000 * hoursElapsed`. Funding is signed — a
   short in a long-crowded market is paid, and the engine must model that or it
   will never learn the carry trade.
3. **Equity** `= collateralUsdc + pnlUsd - fundingPaid - borrowPaid - feesPaid`.
4. **Liquidate** when `equity <= notionalUsd * maintenanceMarginPct`: close at
   the liquidation price, realise `-collateralUsdc`, mark `status:"liquidated"`.
   Check this **before** exit policy — the venue does not wait for your stop.
5. **Exit policy** evaluates on **equity percent, not price percent.** A 5% stop
   at 10× is 50% of margin. `resolveExitPolicy` in `packages/core/src/exitPolicy.ts`
   currently assumes price moves equal position moves; it must take leverage.

## 5. Scoring (`packages/strategies` + the improve skill)

The current gate — `realizedPnlUsdc` and `roundTrips ≥ 3` — ranks 20× noise
above a good spot strategy. Leverage needs risk-adjusted terms:

- `returnOnMargin` = realised PnL ÷ collateral deployed (the headline)
- `fundingDrag` = funding + borrow paid ÷ gross PnL
- `liquidations` — **any liquidation cuts the strategy**, regardless of PnL
- `maxAdverseExcursionPctMargin` — worst unrealised drawdown as % of margin
- `effectiveLeverage` = time-weighted notional ÷ collateral (catches strategies
  that quietly drift above target)

Gate to add weight: ≥3 round trips, zero liquidations, positive
`returnOnMargin`, `fundingDrag < 0.5`, `maxAdverseExcursionPctMargin < 60`.
Update `.opencode/skills/gotchi-trader-improve/SKILL.md` in lockstep — the skill
is what the agent actually reads.

## 6. Learning loop — both halves

**Backtest to rank.** Ingest historical funding/borrow per venue+market into
`packages/db`, replay price + rate bars through the engine above, and sweep
strategy × leverage × side. Output a ranked table with the metrics in §5. This
is where the desk learns fast: hundreds of combinations, no waiting.

**Paper-forward to confirm.** Take the top N and run them on live rates through
the existing paper cron, which already reports per-strategy realised PnL. Only a
strategy that survives both earns weight.

Report both in `paperCronSummary` so `gotchibot trader monitor` shows leverage
rows alongside spot, with venue and effective leverage visible.

## 7. Guardrails

- Paper only. No live execution path, no keys, no signing — not even behind a flag.
- Default `maxLeverage: 3`. Anything above 10 requires an explicit per-strategy
  config and should be flagged in the monitor output.
- Refuse to open when `maxFundingBpsPerDay` is exceeded, and record the refusal —
  a strategy that only works in cheap-funding regimes must show that.
- Adapters are read-only. No approvals, no transactions.

## 8. Order of work

1. Types + `LeverageConfig` (no behaviour change; existing strategies untouched).
2. `packages/perps` with the GMX adapter and a fixture-backed test.
3. Paper engine leverage path + liquidation, with unit tests on the §4 ordering.
4. Gains adapter — the interface is wrong if this hurts.
5. Historical rate ingest + backtest sweep.
6. Scoring + improve-skill update.
7. Monitor surface.

Each step lands green tests before the next. Step 3 is where correctness lives:
if funding, liquidation and equity-based exits are wrong, every number the desk
learns from afterwards is fiction.
