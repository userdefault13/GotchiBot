---
name: Gotchi-Trader improve
description: >-
  Use when auto-improving or retuning a paper trader from its own realized trade
  history.
---
# Gotchi-Trader improve

Retune from realized paper history only.

## Steps
1. Run the monitor skill first. Abort if the API is down or the paper cron is stale.
2. Score each strategy by `realizedPnlUsdc` and `roundTrips`. Ignore open-mark / deprecated total PnL.
3. Add weight only if round-trips are at least 3 and realized is positive.
4. Cut weight if round-trips are at least 3 and realized is negative.
5. Hold as unproven if there are no round-trips, even if mark-to-market looks large.
6. Leave any strategy with `backtest_runs.gate_passed=false` cut.
7. Run the market news skill. If regime is risk-off, do not add.
8. Write a proposal (add/cut/hold). Apply weights or YAML only when the user already said to apply.
9. Never enable live execution. Never install new tools. No secrets in the proposal.
