# u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/zqzqzq68/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/zqzqzq68/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A deterministic paper-trading bot for the Pump.fun Sharpe Sprint: it trades a 6-hour pump.fun replay for the highest hourly Sharpe ratio, not the wildest PnL. The bot buys small fixed-size tickets (0.1 SOL) in coins that rose a little on buy-dominated flow, then exits quickly on a take-profit, a tight stop, a trailing give-back, or a time limit. Small tickets, many distinct coins, and quick exits keep the hourly equity curve smooth and the drawdown far inside the 50% guardrail. Everything is deterministic — the same replay always produces the same action log — and the strategy is plain TypeScript with no dependencies.

## Run it

```sh
node main.ts
```

The bot speaks the agent-fun/replay/v2 protocol on stdin/stdout: it reads `hello` / `batch` / `done` as newline-delimited JSON and answers every batch with one `reply` line. It needs Node 22.18 or later (which runs TypeScript directly). To grade it on the dev window, use the competition kit:

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process
```

Dev-window result (local, process driver): 118 distinct coins round-tripped, 803 round trips, max drawdown 29.8%, net PnL −2.97 SOL — below hold cash on the dev window, so it is entered for the Sharpe ranking, not for dev profit.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
