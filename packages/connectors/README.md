# @hive/connectors — 飞书连接器 ✅ v0.1（离线全链路已验证，等凭据上线）

MVP 首选连接器：飞书群里发一句话 → 内核建任务自动跑 → 终态回帖带账单。与 POST /api/tasks 同款闭环，只是入口从看板换成聊天工具。

**双 transport**：
- **长连接模式（默认，免公网）**：官方 SDK `@larksuiteoapi/node-sdk` WSClient WebSocket 直连，本地开发/单机部署不需要内网穿透。`startFeishuLongConnection()` 把 SDK 事件分发桥接到 `connector.handleEventObject()`——与 webhook 解密后同一套去重/解析/建任务逻辑。
- **webhook 模式**：签名门禁 + AES 解密 + challenge 回显，适合服务器部署。`FEISHU_WEBHOOK_ONLY=1` 切换。

## 架构（webhook 模式，可离线验证）

```
飞书开放平台 ──事件回调──▶ handleCallback(raw, headers)
                            ├─ 签名门禁（sha256(ts+nonce+encrypt_key+body) 不匹配 → 403）
                            ├─ AES-256-CBC 解密（key=SHA256(encrypt_key)，IV=密文前 16 字节）
                            ├─ url_verification → challenge 原样回显
                            ├─ im.message.receive_v1 → 事件去重 → 解析文本（剥 @机器人）
                            └─ kernel.createTask(source="feishu:<chatId>:<openId>") + runTask
任务终态/熔断 ◀──kernel.onEvent── 回帖到来源群（FeishuClient：token 缓存 + im/v1/messages）
```

- **回帖目标落在事件流里**（task.created payload.source）——内核重启后照样能找回来源群（一切皆事件的红利）
- **门禁全在内核**：预算熔断（回帖 ⏸️）、审批、交接校验；连接器只搬运不判断
- 每任务只回一帖（终态或熔断先到先回），不刷屏
- 非文本消息 / 未知事件 → 200 吞掉（非 200 飞书会无限重试）

## 离线验证（不需要凭据）

7 个 node:test：加解密对称 + 签名、url_verification 明文/密文、**闭环**（发一句话→mock 团队跑完→假飞书服务器收到 ✅ 回帖带 $0.50 账单，token 只取一次）、事件去重、签名 403 门禁、非文本吞掉、token 缓存。

**踩坑记录**：加密模式下整个回调体（含 url_verification）都在密文里——解密**之后**才能查 `type`，顺序反了 challenge 就回不去。

## 上线（等用户建应用）

1. https://open.feishu.cn → 开发者后台 → 创建企业自建应用
2. 事件订阅：**模式选"长连接"（推荐，免公网）**；订阅 `im.message.receive_v1`；权限：`im:message`、`im:message:send_as_bot`
3. 凭据填 `hive/.env`（见 `.env.example`）：`FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_ENCRYPT_KEY`
4. 跑：`node --env-file=../../.env examples/feishu-demo.mjs`（默认长连接；webhook 模式加 `FEISHU_WEBHOOK_ONLY=1`，回调地址填 `<公网>/webhook/feishu`）

## 用法（程序化）

```ts
import { FeishuConnector, FeishuClient } from "@hive/connectors";
const connector = new FeishuConnector({ kernel, client, encryptKey, defaultBudgetUsd: 3 });
const { status, body } = await connector.handleCallback(rawBody, headers); // 挂到任意 http server
```

## 下一步

- 长连接模式（官方 SDK WebSocket，免公网）——V0.5
- 更多连接器：企微/钉钉/TG（V1.0），QQ（V2），微信只通知不主控
- 审批回复（群里回"批准"→ POST /api/tasks/:id/approve）——配合 V0.5 审批门
