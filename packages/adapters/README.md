# @hive/adapters — 引擎适配器 ✅ v0.1（契约 + 桥接 + 离线全链路已验证）

引擎 API 变动只改一个 json（适配器隔离原则）：契约文件定义 spawn/解析/计费，通用桥接 worker 把引擎输出翻译成 kernel 行协议。

## 三份真引擎契约（adapters/）

| 契约 | 引擎 | 模式 | 当前状态 |
|---|---|---|---|
| `codex.json` | Codex CLI | `codex_jsonl`（JSONL 事件流） | 认证 ✅，额度 2026-11-14 01:08 重置；**重置后跑冒烟即插即用**（见下） |
| `claude-code.json` | Claude Code | `claude_json`（单 JSON 文档） | CLI 已装，需先在 cc-switch 切供应商（127.0.0.1:3425 代理模型名不被识别，见 docs/引擎清单.md） |
| `deepseek.json` | DeepSeek API | `openai_chat`（OpenAI 兼容） | 等用户提供 `DEEPSEEK_API_KEY`；pricing 为牌价估算 |

契约字段（交接文档 §4 格式的 v1 落地）：`spawn` / `stdin_prompt` / `base_url`+`model`+`env_key` / `usage_parse`（`scan` 存在时 tokens 路径相对求值）/ `final_items`（codex_jsonl 筛 agent_message）/ `pricing`（无 usd 路径时按牌价估算）/ `on_unparseable`（fail=诚实失败 | text_output=纯文本交付）/ `timeout_ms` / `caps` / `tier`。

## 桥接 worker（src/bridge.ts + bridgeWorker.ts）

```
kernel spawn ──stdin: 任务包──▶ bridgeWorker.js <契约.json> ──▶ 调引擎（CLI spawn 或 API fetch）
                                      ◀── 引擎输出 ─── parse mode 提取 final text + usage
                                      ──stdout: 行协议──▶ kernel（output/handoff/artifact/usage/verdict）
```

- **prompt 构建**（`src/prompt.ts`，纯函数）：角色 + 指令 + 上游产物 + 治理规则（三要素/PASS-BLOCK-HOLD）+ 严格 JSON 回复格式。prompt 里的规矩是"请求"，强制在内核。
- **计费**：契约 `usd` 路径（claude 的 `$.total_cost_usd`）> `pricing` 牌价估算（codex/deepseek 按 tokens）> 0（订阅额度制，tokens 如实记账）。
- **凭据**：API key 由内核/resolver 经环境变量注入桥进程，不落盘、不进 prompt。
- **诚实失败**：引擎非零退出 / 超时 / 回复不是协议 JSON → stderr + 非零退出码 → 内核标 ⛔，绝不谎报成功。

## 接入内核

```ts
import { HiveKernel } from "@hive/kernel";
import { createAdapterResolver } from "@hive/adapters";
const workers = createAdapterResolver({ adaptersDir: "packages/adapters/adapters" });
const kernel = new HiveKernel({ dataDir, chart, workers }); // bot 的 engine.adapter 现在可以是 codex/claude-code/deepseek
```

resolver：契约加载失败 → null → 内核如实失败（坏契约不进内核）。kernel 侧改动：`WorkerSpec` + `workers` 注入（默认只认 mock，向后兼容）。

## 离线验证（不依赖 key/额度）

fixtures/ 里有假 codex 引擎（模拟 `codex exec --json` JSONL）与假 claude 引擎；测试内起假 OpenAI 兼容服务器。8 个 node:test 全过，其中 E2E：**假 codex(cli) + 假 DeepSeek(api) 经桥接跑通 4-bot 闭环**——usage 从两种 parse mode 正确提取、pricing 计费正确、产物落盘、审核 PASS。

## 复冒烟（引擎恢复后）

```bash
pnpm --filter @hive/adapters smoke -- codex   # 或 claude-code / deepseek
```

单发一个 bot 头less 调用，验证 契约→引擎→桥接→协议 链路。若真实引擎的 `--json` 行结构与契约不符，**只改对应 json 的 `final_items`/`usage_parse` 路径**，桥代码不动。

**踩坑记录**：测试里 fake API 的 `content` 必须是字符串（真实 API 如此），塞对象会被桥如实判"非协议 JSON"退出码 3——桥的诚实失败路径被意外验证了一次。
