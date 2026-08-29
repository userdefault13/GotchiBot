---
name: Market news feed
description: >-
  Use when a trading desk needs live headlines or a risk-on/off veto before
  adding size.
---
# Market news feed

Public RSS first (CoinDesk, Cointelegraph, Decrypt). Paid news APIs stay behind an existing secrets vault.

## Steps
1. Fetch a small set of public crypto RSS feeds.
2. Keep headlines that mention ETH, BTC, AAVE, UNI, LINK, Base, SEC, ETF, hack, exploit.
3. Cap at about 8 items.
4. Map regime: risk-off on hack/exploit/SEC suit/halt; risk-on on confirmed ETF inflow/approval; otherwise neutral.
5. risk-off vetoes new size. risk-on is not a buy signal. Neutral is ignored.
6. Never open, close, or live-trade from a headline.
7. If RSS is not enough, request a connector rather than scraping random sites. Do not put API keys in the skill or the output.
