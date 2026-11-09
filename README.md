# 蜂巢 Hive

> **把"雇一支 AI 团队"做成像装一个 App 一样简单。**
> 你在任何聊天工具里说一句话，一支看得见、管得住、越用越强的 AI bot 团队自动完成拆解 → 分派 → 协作 → 互审 → 汇总。你当 CEO（看板、拍板、发工资），bot 当员工（接活、干活、交结果）。

- **完整规划与调研**：[交接文档.md](./交接文档.md)（自包含，接手者从这里开始）
- **当前引擎可用性**：[docs/引擎清单.md](./docs/引擎清单.md)
- **工作语言**：中文（代码与标识符用英文）

## 当前状态

**MVP 开发中**。北极星：TTFD ≤ 30 分钟（装上 → 飞书发一句话 → 3 bot 团队交付研究简报 → 账单落盘，人工只拍板一次）。

## 仓库结构

```
hive/
├── packages/
│   ├── kernel/        # Node daemon：任务总线、事件溯源、进程管理、熔断 ✅ v0.1（mock 闭环已通）
│   ├── server/        # API + WebSocket，实时推 Mission Control ✅ v0.1（含最简看板）
│   ├── ui/            # Next.js：Mission Control、组织编辑器、账单页（未开始）
│   ├── adapters/      # 引擎适配器：契约 json + 桥接 worker ✅ v0.1（离线全链路已验证）
│   ├── connectors/    # 平台连接器：飞书 ✅ v0.1（离线全链路验证，等凭据上线）
│   └── shared/        # 协议唯一真相源：事件 schema、org-chart、交接协议、账本 ✅ v0.1
├── teams/             # 团队模板（chart.json 兼容 agent-org-chart）
└── docs/              # 引擎清单等工程文档
```

## 三条硬原则（不可妥协）

1. **门禁装在内核，不装在 bot 嘴里**——权限、预算、审批门由内核强制执行
2. **一切皆事件**——append-only（JSONL + SQLite 索引），任何一单可完整回放审计
3. **诚实熔断**——预算超限自动暂停；失败如实标 ⛔，汇总零谎报

## 快速开始

```bash
pnpm install
pnpm build     # shared → kernel 按拓扑序构建
pnpm test      # shared 12 + kernel 5 = 17 个测试
pnpm --filter @hive/kernel demo   # 第一个本地任务闭环：mock 团队 4 bot 交付 + 账单落盘
pnpm --filter @hive/server demo   # 起最简 Web 看板（时间线/输出流/账单，实时 WS），自动发一单演示
pnpm --filter @hive/adapters smoke -- codex   # 引擎复冒烟（codex 额度 11-14 重置后跑）
node scripts/ignition.mjs                     # 点火自检：盘点凭据与引擎状态（零成本）
node --env-file=.env scripts/ignition.mjs --smoke   # 凭据齐后：真引擎冒烟点火
```

## 路线图

| 版本 | 内容 | 不做 |
|---|---|---|
| MVP | 内核(任务总线+事件溯源) + 飞书连接器 + 3 引擎适配 + 聊天闭环 + 最简看板 + 账本 | 画布动画、组织编辑器、多平台、打包 |
| V0.5 | Mission Control 画布 · 审批 PWA · 预算熔断 · 暂停/接管 | 模板市场 |
| V1.0 | 组织编辑器 · agent-org-chart 导入 · 6+ 连接器 · Tauri 打包 | 市场、多人 |
| V2 | 开源发布 · 模板市场 · 技能锻造厂 | — |
