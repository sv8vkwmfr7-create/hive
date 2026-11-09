# @hive/kernel — 内核 ✅ v0.1（任务总线 + 事件溯源 + mock 引擎 + 预算熔断）

Node daemon 库（v0 为库形态，daemon/server 化在 server 包做）。基于 `@hive/shared` 协议，零自造定义。

## 已实现

| 模块 | 文件 | 内容 |
|---|---|---|
| 事件溯源 | `src/store/eventStore.ts` | JSONL append-only（唯一真相源）+ SQLite 索引（`node:sqlite`，只索引不存 payload）；先写 JSONL 后写索引，崩溃最多丢索引不丢历史 |
| 任务总线 | `src/core/kernel.ts` | `createTask()` / `runTask()`；bot 提议、内核裁决 |
| 预算熔断 | `src/core/budget.ts` | 任务级 budgetUsd + bot 级 daily_budget_usd（UTC 日）；超限 → `budget.exceeded` + `run.paused`，**暂停而非硬烧**；花费只信 `cost.recorded`，内核重启后从事件流重建 |
| 进程管理 | `src/engine/runner.ts` | spawn 引擎 worker，JSON 行协议；`max_turns` 超限强杀 |
| mock 引擎 | `bin/worker-mock.mjs` | 引擎协议参考实现（总管拆解 → 研究员素材 → 写手初稿 → 审核员独立判定） |
| 回放审计 | `src/replay.ts` | `replayTask()`：任一单完整重建时间线 + 账单（从事件重算，不信缓存） |

## 内核强制的门禁（bot 提议 ≠ 执行）

1. handoff 必须命中 chart 边，越权交接 → `error.reported` + 任务失败
2. 交接三要素缺一不可（shared `HandoffNote`）
3. 只有 `kind=reviewer` 能出结论；`BLOCK` 无证据协议违规
4. bot 谎报产物（文件不存在）→ 失败
5. 引擎非 mock → 如实失败（不用 mock 冒充真引擎，见 `docs/引擎清单.md`）
6. 没有审核 PASS 不算交付；交付前核验产物文件真实存在

## 用法

```bash
pnpm build && pnpm test          # 构建 + 5 个 node:test（闭环/双熔断/重启重建/越权拒绝）
pnpm --filter @hive/kernel demo  # 第一个本地任务闭环：27 事件、账单落盘、全可回放
```

```ts
import { HiveKernel, replayTask } from "@hive/kernel";
const kernel = new HiveKernel({ dataDir, chart });
const taskId = kernel.createTask({ title: "竞品简报", brief: "…", budgetUsd: 3 });
const res = await kernel.runTask(taskId); // { status: "ok" | "failed" | "paused", receipt }
kernel.onEvent((e) => console.log(e.kind)); // 实时事件流（server 包推 Mission Control 用）
```

测试实测输出（demo）：JSONL 27 行 = SQLite 27 行；账单 $0.50（chief 0.05 / researcher 0.20 / writer 0.15 / reviewer 0.10）。

## 下一步

1. 真引擎适配器（`@hive/adapters`：codex / claude-code / deepseek，复用 worker 协议；可用性见引擎清单）
2. server 包：HTTP + WebSocket 推事件流 → 最简 Web 看板
3. 飞书连接器 → 聊天闭环 E2E（北极星 TTFD ≤ 30min）
4. 审批门（send_external / spend / merge）——V0.5 的 ⏸️暂停 / ✋接管
