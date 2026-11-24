# Pump.fun Replay Sprint — Paper Bot

![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)
![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/yudhisutawan77/makefun-pump-replay/rank.svg)
![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/yudhisutawan77/makefun-pump-replay/reward.svg)

[Compete on make.fun](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for the **Pump.fun Replay Sprint** bounty. It trades
10 SOL of paper money over a 24-hour replay of recorded pump.fun bonding-curve
activity. Nothing here trades for real — no wallet, no SOL, no network.

## Strategy: buy at launch, let winners run

1. **Watch** — every new curve is watched from its first sighting; its opening
   price is the virtual-quote / virtual-token reserve ratio at that moment.
2. **Buy** — once a coin has traded at least once and its price has not dipped
   below its opening price, buy **0.05 SOL** (or the 1%-of-real-reserve size
   cap when smaller, never below 0.02 SOL). One buy per coin, at most 5 open
   positions at once. Buying at launch, instead of chasing a rise, is what the
   dev window rewards: the kit's own momentum pilot loses 9.5 SOL chasing
   rises, while buying early and holding is near break-even.
3. **Sell** — the whole position is sold at **+100%** take-profit (let a
   migrating coin run), **−40%** stop-loss, or after **75,000 slots**
   (~8 hours) without either trigger, so capital keeps cycling instead of
   sitting in dead coins.

Costs per round trip are ~1.25% curve fees per leg plus 105,000 lamports of
transaction fees per order, so a trade needs roughly a 3% move to break even
— the exits sit well clear of that. The bot is fully deterministic (no clock,
no randomness, no environment reads): the same replay always produces the
same action log, as the grader requires.

## Run it

Requires Node 22.18+ (the grader runs Node 22.23.4). No dependencies, no
build step, no install:

```sh
node main.ts
```

The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout: the
harness sends `hello`, then one `batch` per slot, and the bot answers each
batch with its orders. Diagnostics go to stderr only.

## Grade it locally

With the kit unpacked next to this repo:

```sh
node kit/cli/makefun.mjs grade-local --kit kit --bot . --driver process --worktree
```

## Files

- `main.ts` — the bot (entrypoint, run as `node main.ts`)
- `vendor/makefun-bot.ts` — the kit's replay shim, byte-identical to
  `sdk/ts/makefun-bot.ts` in the kit (vendored as the SDK instructs)
- `kit/` — the competition kit (dataset, CLI, rules)

## License

MIT — see [LICENSE](LICENSE).
