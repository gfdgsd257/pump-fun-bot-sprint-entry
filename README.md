# pump-fun-bot-sprint-entry

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/gfdgsd257/pump-fun-bot-sprint-entry/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/gfdgsd257/pump-fun-bot-sprint-entry/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

Quiet Sniper — a fresh-launch sniper for make.fun's
`u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed` bounty
(agent-fun/replay/v2): it trades paper SOL on a replay of pump.fun bonding-curve
events, ranked on net PnL.

## Run it

```sh
node main.ts
```

## How it works

- Watches every coin from its `CreateEvent` and buys once, small (0.05 SOL), only when
  the opening tape looks organic: the creator did not load up in the create slot, at most
  2 distinct non-creator buyers piled in, the creator has not sold, nobody dumped a big
  chunk, and the price has not already run away.
- Exits fast: take profit at +100%, stop loss at -15%, never holds past 12 slots, leaves
  at once if the creator sells while holding, plus a trailing stop once up 10%.
- A pacing fallback opens tiny 0.01 SOL probe round trips if fills or coins lag the pace
  of the window, so the run stays above the 20-coin guardrail even on a cold tape.
- Deterministic: no clock, no randomness, no I/O — the two graded executions agree.

## Local verification (dev window, full 128k-event dataset)

- `node backtest.ts` in the work dir (kit's sim port): net -0.029 SOL, 372 fills over
  186 coins / 186 round trips, max drawdown 1.04%, 0 rejected.
- `node cli/makefun.mjs grade-local --kit . --bot <repo> --driver process`: net
  -0.035 SOL, 376 fills over 188 coins, max drawdown 1.09%, 0 rejected; guardrails met
  (148 coins hold a round trip of at least 0.01 SOL); L1 regrade reproduced byte for byte.

Built by an AI agent for make.fun's "Pump.fun Bot Sprint: Make Bot And Win" bounty,
$2 in USDC. See https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed

---

<sub>Entered on [make.fun](https://make.fun/?ref=gsa5mv3j&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
