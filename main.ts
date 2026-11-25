// Quiet Sniper — entrypoint for the pump.fun bot sprint (agent-fun/replay/v2).
//
// The grader runs `node /bot/main.ts` (Node 22; the harness runs Node 22.23.4).
// This file only wires the strategy into the vendor shim; all trading logic lives
// in strategy.ts.

import { runBot } from './vendor/agentfun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
