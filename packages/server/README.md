# @hive/server — HTTP API + WebSocket ✅ v0.1（实时事件流 + 最简 Web 看板）

把内核事件流暴露给人和程序：REST 查详情、WebSocket 收实时事件、静态托管看板页。
无鉴权——MVP 只绑 127.0.0.1；对外暴露是 V1.0 凭据代理加固后的事。

## API

| 端点 | 方法 | 内容 |
|---|---|---|
| `/health` | GET | 存活检查 |
| `/api/tasks` | GET | 任务摘要列表（状态 glyph / 花费 / 预算），新单在前 |
| `/api/tasks` | POST | **发单**：`{title, brief, budgetUsd}` → 内核建任务并自动开跑（202 accepted） |
| `/api/tasks/:id` | GET | 详情：摘要 + 回放时间线 + 账单小票 |
| `/api/tasks/:id/artifacts` | GET | 产物文件内容（路径穿越防护：只读该任务 artifacts 目录内） |
| `/api/chart` | GET | 当前团队架构图 |
| `/ws` | WebSocket | 连接即发 `{type:"snapshot"}`；此后每条内核事件实时广播 `{type:"event"}` |

## 看板（public/，vanilla JS 无构建）

- **任务列表**：`✅/🔄/⛔/⏸️` + 花费/预算
- **时间线**：seq + glyph + kind + actor + 摘要，WS 实时追加
- **输出流**：bot.output 实时滚动
- **账单页**：按 bot 的 tokens/费用表格 + 合计 + 落盘路径
- **产物**：素材/初稿内容折叠预览
- **发单表单**：一句话需求 → POST → 自动选中新任务看它跑

（此看板是 MVP 的"最简版"；Mission Control 画布/组织编辑器属于 V0.5+ 的 `@hive/ui`（Next.js），按路线图"不做"清单收口。）

## 状态推导（views.ts）

只信事件、不信缓存：`task.created` → running 🔄；`run.paused`/`budget.exceeded` → paused ⏸️；`task.status_changed` → ✅/⛔（shared `STATUS_GLYPH`）。花费由 `cost.recorded` 累加。

## 用法

```bash
pnpm --filter @hive/server demo   # 起看板 + 自动发一单演示任务（mock 引擎，零 key 依赖）
pnpm test                         # 2 个 node:test：HTTP+WS 全链路 / 熔断任务如实显示 ⏸️
```

程序化使用：

```ts
import { HiveKernel } from "@hive/kernel";
import { createHiveServer } from "@hive/server";
const kernel = new HiveKernel({ dataDir, chart });
const server = await createHiveServer({ kernel }); // port 随机可用
console.log(`http://127.0.0.1:${server.port}`);
```

**踩坑记录**：WS 客户端必须在 `await open` 之前挂 message 监听器——服务端连接即发快照，open 同一个 tick 里就会到，后挂监听器会漏掉首条快照。

## 下一步

1. `@hive/adapters`：真引擎适配器（codex / claude-code / deepseek，复用 kernel worker 协议；可用性见 docs/引擎清单.md）
2. `@hive/connectors`：飞书连接器 → POST /api/tasks 同款闭环走聊天入口
3. 审批门 API（POST /api/tasks/:id/approve）配合 V0.5 ⏸️/✋
