import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadAdapter } from "./contract.js";
import { runBridge } from "./bridge.js";
import type { TaskPack } from "./prompt.js";

/**
 * 桥接 worker 入口：kernel spawn 本文件，argv[2] = 契约文件路径，stdin = 任务包。
 * 可选 argv：--via-proxy <url>（凭据代理模式：改调本地代理，真 key 不进本进程）。
 * 由 @hive/adapters 的 resolver 生成 WorkerSpec；kernel 只见统一的行协议。
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const viaProxyIdx = argv.indexOf("--via-proxy");
  const proxyUrl = viaProxyIdx >= 0 ? argv[viaProxyIdx + 1] : undefined;
  const contractPath = argv[0];
  if (!contractPath) {
    process.stderr.write("用法：node bridgeWorker.js <adapter.json> [--via-proxy <proxyUrl>]\n");
    process.exit(2);
  }
  let contract;
  try {
    contract = loadAdapter(contractPath);
  } catch (e) {
    process.stderr.write(String(e instanceof Error ? e.message : e) + "\n");
    process.exit(2);
  }
  if (proxyUrl && contract.kind === "api") {
    // 凭据代理模式：上游改为 <proxy>/<adapterId>/…；占位 key 经 authorization 头送出（代理校验会话密钥）
    contract = { ...contract, base_url: `${proxyUrl.replace(/\/$/, "")}/${contract.adapter}` };
  }
  let pack: TaskPack;
  try {
    pack = JSON.parse(readFileSync(0, "utf8")) as TaskPack;
  } catch (e) {
    process.stderr.write(`任务包不可读：${e instanceof Error ? e.message : e}\n`);
    process.exit(2);
  }
  const result = await runBridge(pack, contract);
  // Windows：process.exit() 会与 undici keep-alive 套接字的 libuv 关闭竞态
  // （Assertion failed: !(handle->flags & UV_HANDLE_CLOSING) → 退出码 3221226505）。
  // 协议行已写完，改为设退出码自然排空；5s 兜底强退防悬挂。
  process.exitCode = result.exitCode;
  setTimeout(() => process.exit(result.exitCode), 5000);
}

// 仅作为 worker 直接运行时执行 main（被测试 import 时不触发）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
