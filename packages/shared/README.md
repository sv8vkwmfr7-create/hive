# @hive/shared — 协议唯一真相源

Hive 全系统的协议定义：kernel / server / ui / adapters / connectors 一律从这里导入，禁止各自复制定义。

## 内容

| 模块 | 文件 | 内容 |
|---|---|---|
| 交接协议 | `src/handoff.ts` | 交接三要素（reason/progress/ask，缺一不可）、审核结论（PASS/BLOCK带证据/HOLD）、治理硬规则常量 |
| 组织即配置 | `src/org-chart.ts` | team.json schema v1（引擎引用、护栏 guards、流转 handoffs）、结构校验、agent-org-chart 宽容导入 |
| 事件溯源 | `src/events.ts` | 事件信封 + 23 种已知事件 payload 注册表、✅🔄⛔ 状态标记、宽容解析（未知 kind 入账不丢） |
| 账本 | `src/ledger.ts` | 成本条目、任务小票（工资单）、档位建议结构 |

## 用法

```bash
pnpm install
pnpm build   # tsc → dist/
pnpm test    # 构建 + node --test 冒烟测试
```

```ts
import { parseEvent, TeamChartSchema, validateChart, HandoffNote } from "@hive/shared";
```

## 设计要点

- **schema v1 兼容社区**：`TeamChartSchema` 用 passthrough，agent-org-chart 的 chart.json 字段原样保留；`importAgentOrgChart()` 把未识别 kind 宽容归为 specialist 并给出 warnings。
- **append-only**：`parseEvent()` 对未注册 kind 放行（known=false），历史不丢；已知 kind 的 payload 校验失败会返回 error，由内核记 `error.reported`，禁止静默丢弃。
- **门禁字段只做描述**：guards（预算/@ 权限/审批门）只是配置声明，强制执行在 kernel——"被管的那个东西管不了门"。
