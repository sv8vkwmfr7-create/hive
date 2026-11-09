# AGENTS.md — Hive 仓库 AI 协作约定

本文件约束任何在 `hive/` 内工作的 AI 会话或人类协作者。项目全貌见 [交接文档.md](./交接文档.md)。

## 工作语言

中文沟通与文档；代码、标识符、commit message 用英文。

## 硬原则（写代码前先读）

1. **门禁装在内核，不装在 bot 嘴里**：任何权限判断、预算扣减、审批门逻辑只允许出现在 kernel；bot 的 prompt/profile 只是"请求"，不是"执行"。
2. **一切皆事件**：任务生命周期内的每个动作都产生 append-only 事件（JSONL 落盘 + SQLite 索引）。禁止原地改写历史事件；修正 = 追加新事件。
3. **诚实熔断**：预算超限 → 自动暂停（`budget.exceeded`），不许硬烧；失败 → `task.status_changed { to: "failed" }`，禁止重试到谎报成功。测试不过就说不过，不粉饰。

## 治理规则（shared 协议已内建）

- 交接三要素：`转交原因 + 当前进度 + 需要对方做什么`；**交接 ≠ 审批**
- 审核员独立会话，只出 `PASS / BLOCK(带证据) / HOLD`，永不自审
- 状态标记：✅ ok / 🔄 running / ⛔ failed；**只有总管（orchestrator）可主动 @ 其他 bot**
- 每 bot 独立记账；同一信息源禁止两个 bot 重复查

## 工程约定

- **协议唯一真相源**：`packages/shared/`。kernel/server/ui/adapters/connectors 一律从 shared 导入类型与 schema，禁止各自复制一份定义。
- **引擎适配器**：每个引擎一个 `adapters/<engine>.json` 契约（spawn/resume/usage_parse/artifact_parse/caps）；引擎 API 变动只改适配器文件。
- **凭据**：bot 永远摸不到 API key（凭据代理在内核）。密钥只进 `.env`（已 gitignore），代码与文档中禁止出现明文密钥。
- **提交纪律**：每期按路线图的"不做"清单收口；不做清单里的东西写了就是范围失控。
- **vault 关系**：`hive/` 在 Obsidian vault 内但**不受 vault 规则约束**（vault 规则见 `../AGENTS.md`）；每阶段收尾把 Hive 进展落 `../wiki/` 并追加 `../wiki/log.md`。
- 引擎当前可用性以 [docs/引擎清单.md](./docs/引擎清单.md) 为准，环境变动先更新该清单。

## 已验证资产（复用，不重造）

- `../codex-zcode-team/`：内核委托模式（Codex 总管 + ZCode 执行者单任务委托已验证）
- vault `raw/1-Hermes和领域智能体生态/hermes-group-chat-optimization.md`：交接三要素、状态标记、chat-digest
- `botroster`（GitHub）：hub 强制审批 / 凭据代理 / 审计日志的设计出处
