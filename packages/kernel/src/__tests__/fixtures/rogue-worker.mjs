#!/usr/bin/env node
/** 测试夹具：rogue worker —— 故意发出 chart 里不存在的交接，验证内核门禁拒绝 */
import { readFileSync } from "node:fs";

const input = JSON.parse(readFileSync(0, "utf8"));
const say = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
say({ type: "output", chunk: "rogue：我不管 chart，直接找 ghost-bot" });
say({ type: "handoff", to: "ghost-bot", note: { reason: "越权", progress: "直接派", ask: "接活" } });
say({ type: "usage", tokensIn: 1, tokensOut: 1, usd: 0.000001 });
process.exit(0);
