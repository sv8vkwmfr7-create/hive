# 蜂巢 Hive

> **把"雇一支 AI 团队"做成像装一个 App 一样简单。**
> 你在任何聊天工具里说一句话，一支看得见、管得住、越用越强的 AI bot 团队自动完成拆解 → 分派 → 协作 → 互审 → 汇总。你当 CEO（看板、拍板、发工资），bot 当员工（接活、干活、交结果）。

- **完整规划与调研**：[交接文档.md](./交接文档.md)（自包含，接手者从这里开始）
- **引擎注册表**：[docs/引擎清单.md](./docs/引擎清单.md)（12 引擎状态表）
- **工作语言**：中文（代码与标识符用英文）

## 当前状态（2026-11-11）

**MVP 全链 + V0.5 全清 + V1.0 部分提前**，58/58 测试全绿，20 个 commit。

| 能力 | 状态 |
|---|---|
| 真引擎 3-bot 闭环（拆解→分派→协作→互审→交付） | ✅ 多次 PASS（17~45s，账单落盘） |
| CEO 三门 ⏸️暂停 / ▶️恢复 / ✋接管 | ✅ 内核门 + 看板按钮 + API |
| 审批门 ✅批准 / ⛔拒绝（含 API 引擎协议） | ✅ 端到端验收 |
| Mission Control 蜂房画布 + 手机审批 PWA | ✅ 浏览器验收 |
| 共享大脑（Obsidian 落库 / 接活查库） | ✅ v0 |
| 团队模板 **22 个**（社区 11 + 原创 4 + 自研 7） | ✅ 全部合法 |
| 引擎注册表 **12 契约**（deepseek/qwen 实测通，编辑器标 key 就绪度） | ✅ 开箱即用 |
| 组织编辑器（拖拽画布 + 角色表单 + 换脑联动） | ✅ org.html 浏览器验收 |
| 合规率两道门（漏交棒重派 / 先批后审自愈） | ✅ qwen 修后 5/5 PASS |
| 聊天通道 feishu / telegram / discord / slack / dingtalk / wecom | ✅ 连接器就绪（真回调等凭据，§快速开始） |

## 仓库结构

```
hive/
├── packages/
│   ├── kernel/        # 内核：任务总线、事件溯源、进程管理、熔断、CEO 三门、凭据代理 ✅
│   ├── server/        # API + WebSocket + 看板（时间线/画布/输出流/账单）✅
│   ├── adapters/      # 12 引擎契约 + 桥接 worker + 凭据代理 ✅
│   ├── connectors/    # 飞书（长连接+webhook）/ Telegram（长轮询）/ Discord（gateway）
│   │                  # / Slack（Socket Mode）/ 钉钉（Stream Mode）/ 企微（回调）✅ 全离线 E2E
│   └── shared/        # 协议唯一真相源：事件 schema、org-chart、交接协议、账本 ✅
├── teams/             # 22 个团队模板（兼容 agent-org-chart，含社区 11 套）
├── scripts/           # ignition 自检 / 真引擎闭环 / 模板导入 / hive-chat 统一入口 / hive-replay 审计
└── docs/              # 引擎清单等工程文档
```

## 三条硬原则（不可妥协）

1. **门禁装在内核，不装在 bot 嘴里**——权限、预算、审批门由内核强制执行
2. **一切皆事件**——append-only（JSONL + SQLite 索引），任何一单可完整回放审计
3. **诚实熔断**——预算超限自动暂停；失败如实标 ⛔，汇总零谎报
4. **凭据代理**——真 key 只在内核进程；worker 只拿 127.0.0.1 代理地址，泄漏审计干净

## 快速开始

```bash
pnpm install && pnpm build
pnpm test                                    # 75 个测试
pnpm --filter @hive/kernel demo              # mock 团队闭环 demo
node --env-file=.env scripts/run-real-loop.mjs   # 真引擎 3-bot 闭环（凭据代理开启）
node scripts/import-team.mjs <chart.json> --with-reviewer   # 导入社区团队
node scripts/import-catalog.mjs              # 批量导入 agent-org-chart 全目录
node scripts/hive-chat.mjs                   # 聊天统一入口（自动检测已填通道）
```

### 聊天段验收（最后一段，填任一凭据即可）

六选一填进 `.env`（前两套免公网零配置成本最低）：
- **Telegram（最快）**：@BotFather → /newbot → token → `TELEGRAM_BOT_TOKEN=`
- **飞书**：open.feishu.cn 建企业自建应用（长连接）→ 三值
- **Discord**：Developer Portal → Bot → token（开 MESSAGE CONTENT intent）
- **Slack**：api.slack.com/apps → Socket Mode（xapp-）+ OAuth（xoxb-，chat:write）→ 订阅 message.im + app_mention
- **钉钉**：open-dev.dingtalk.com 企业内部应用 → appKey/appSecret → 机器人消息接收选「Stream 模式」
- **企微**：管理后台自建应用 → 五值（corpid/secret/AgentId/Token/EncodingAESKey）→ 接收消息 URL 需公网（cloudflared 可转发），wecom-demo

然后：
```bash
node --env-file=.env scripts/ignition.mjs --smoke   # 引擎复核
node --env-file=.env scripts/hive-chat.mjs          # 起通道
# 在聊天里发一句话 → 3 bot 团队交付简报 → 账单落盘 → 聊天收到 ✅ 回帖
```

## 路线图

| 版本 | 内容 | 状态 |
|---|---|---|
| **MVP** | 内核 / 飞书连接器 / 3 引擎 / 聊天闭环 / 看板 / 账本 | ✅ 全实现（真回调等凭据） |
| **V0.5** | Mission Control 画布 / 手机审批 PWA / 预算熔断 / ⏸️暂停/✋接管 | ✅ 全清 |
| **V1.0** | 组织编辑器 / agent-org-chart 导入 ✅ / 6+ 连接器（2/6）✅部分 / 凭据代理 ✅ / Tauri | 🔧 进行中 |
| **V2 生态** | 开源发布 / 模板市场 / 技能锻造厂 | ⬜ |
