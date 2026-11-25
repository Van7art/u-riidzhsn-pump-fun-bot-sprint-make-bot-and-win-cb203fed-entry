// Dart — a fast launch scalper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and the SDK shim is
// the kit's sdk/ts/makefun-bot.ts, vendored byte for byte in vendor/.
//
// Dart only buys launches whose opening tape looks organic — several distinct non-creator
// buyers, buys dominating sells, the creator not selling and not loading up — then gets out
// fast: a partial take-profit early, a tight stop, a short trailing stop, and a hard time cap.
// See NOTES.md for the strategy, the variants it beat, and the dev-window backtest numbers.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
