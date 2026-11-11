import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { WorkerSpec } from "@hive/kernel";
import { loadAdapter } from "./contract.js";
import type { AdapterContract } from "./contract.js";

const BRIDGE_WORKER = fileURLToPath(new URL("./bridgeWorker.js", import.meta.url));

export interface AdapterResolverOptions {
  /** 契约目录（含 <adapterId>.json），真引擎用 packages/adapters/adapters/，测试可用 fixtures */
  adaptersDir: string;
  /** 额外环境变量（凭据代理注入点；api 契约的 env_key 从 process.env 透传） */
  env?: Record<string, string>;
  /** 凭据代理（V1.0 加固）：设置后 api 引擎改调本地代理，真 key 不进 worker 进程 */
  proxyUrl?: string;
  /** 代理会话密钥（与 startCredentialProxy().secret 配对） */
  proxySecret?: string;
}

export type AdapterResolver = (adapterId: string) => WorkerSpec | null;

/**
 * adapterId → WorkerSpec：桥接 worker + 契约路径 + 凭据环境。
 * 契约加载失败 → null（内核如实失败），坏契约不进内核。
 */
export function createAdapterResolver(opts: AdapterResolverOptions): AdapterResolver & { contracts: Map<string, AdapterContract> } {
  const contracts = new Map<string, AdapterContract>();
  return Object.assign(
    (adapterId: string): WorkerSpec | null => {
      if (adapterId === "mock") return { workerPath: "" }; // 内核自己处理 mock；此处不应被调用
      const file = join(opts.adaptersDir, `${adapterId}.json`);
      let contract: AdapterContract;
      try {
        if (!contracts.has(adapterId)) contracts.set(adapterId, loadAdapter(file));
        contract = contracts.get(adapterId)!;
      } catch {
        // 未知或坏契约：内核侧会如实失败并记录原因
        return null;
      }
      const env: Record<string, string> = { ...opts.env };
      const viaProxy = !!opts.proxyUrl && contract.kind === "api";
      if (contract.kind === "api" && contract.env_key) {
        // 代理模式：worker 只拿占位 key；真 key 由内核侧凭据代理注入
        env[contract.env_key] = viaProxy ? "hive-proxy" : (process.env[contract.env_key] ?? "");
      }
      if (viaProxy) env.HIVE_PROXY_SECRET = opts.proxySecret ?? "";
      const args = [file];
      if (viaProxy) args.push("--via-proxy", opts.proxyUrl!);
      return { workerPath: BRIDGE_WORKER, args, env };
    },
    { contracts },
  );
}
