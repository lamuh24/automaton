# Paper-trading learning workflow

This workflow is strictly an educational, local simulation. It never connects an account, sends an order, accepts credentials, transfers funds, or guarantees a result. It reads public prices only from unauthenticated Kraken and Yahoo Finance endpoints.

The initial portfolio is $10,000 in virtual USD cash with no positions. It limits simulated activity to BTC, ETH, SOL, AAPL, MSFT, and TSLA; three simulated trades per day; $2,000 per simulated trade; 20% per asset; 40% total exposure; no leverage; and no shorting. A rationale is required for every simulated trade.

Commands:

```bat
paper-trading.cmd initialize
paper-trading.cmd snapshot
paper-trading.cmd status
paper-trading.cmd simulate-buy BTC 100 "Educational hypothesis only"
paper-trading.cmd simulate-sell BTC 0.001 "Close simulated position after review"
```

Local files are stored in `~/.automaton/paper-trading` by default: `portfolio.json`, `trades.jsonl`, `rationale.jsonl`, and `market-snapshot.json`. Set `AUTOMATON_PAPER_TRADING_ROOT` to use a different location.
# Local paper-trading dashboard

Run `paper-trading-dashboard.cmd`, then open http://127.0.0.1:8787 in a browser. The server binds only to this PC. It provides two views of the same local simulation: the clear standard dashboard at `/`, and the playful Market Battle view at `/battle`; each view links to the other. It reads the simulator files under `~/.automaton/paper-trading` and calls the simulator only for a public-price refresh or a rationale-required simulated trade. It cannot authenticate to an exchange, use an API key, connect a wallet, transfer funds, or create a real order.

The dashboard displays virtual balances, current public prices and their refresh time, positions, simulated trade log, risk limits, and portfolio-history entries. It records one history entry on initialization and each refresh/trade.

To view it on a phone connected to the same Wi-Fi, run `paper-trading-dashboard-phone.cmd` and open `http://<your-PC's-private-IP>:8788`. This is a LAN-only viewer for the same paper simulation; do not port-forward it or expose it to the public internet.

The Market Battle view has original CSS sprite themes for BTC, ETH, SOL, AAPL, MSFT, and TSLA. Its enemy ladder uses logarithmic asset-market-cap milestones from $100K through $1T. Market-cap data is deliberately shown as unavailable unless a verified source is integrated. `config/market-cap-demo.json` contains an optional disabled-by-default, local visual-demo mock; it cannot affect prices, portfolios, or simulated trades.
