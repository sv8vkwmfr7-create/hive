import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { loadAdapter } from "./contract.js";
import type { AdapterContract } from "./contract.js";

/**
 * 凭据代理 v1（V1.0 加固项）：worker 只拿 127.0.0.1 代理地址 + 随机会话密钥，
 * 真 key 留在内核进程里，转发时才注入 Authorization——bot 进程永远摸不到 key。
 *
 * 路由：POST <proxy>/<adapterId>/<上游路径…>
 *   校验 X-Hive-Proxy-Secret → 按 adapterId 找契约（base_url + env_key）
 *   → 注入 Bearer env[key] → 转发请求体 → 原样回传上游响应（状态/类型/体）。
 */
export interface CredentialProxy {
  /** http://127.0.0.1:<port>（worker 只见这个） */
  url: string;
  /** 会话密钥（worker env 注入；请求头缺失/不符 → 403） */
  secret: string;
  port: number;
  /** 测试观测点：转发次数 */
  forwarded: number;
  close(): Promise<void>;
}

export interface CredentialProxyOptions {
  /** 契约目录（proxy 需要知道每个 adapter 的上游 base_url 与 env_key） */
  adaptersDir: string;
  /** 内核进程的 env（key 的唯一居所） */
  env?: NodeJS.ProcessEnv;
}

export async function startCredentialProxy(opts: CredentialProxyOptions): Promise<CredentialProxy> {
  const env = opts.env ?? process.env;
  const contracts = new Map<string, AdapterContract>();
  const getContract = (id: string): AdapterContract | null => {
    if (!contracts.has(id)) {
      try {
        contracts.set(id, loadAdapter(join(opts.adaptersDir, `${id}.json`)));
      } catch {
        return null;
      }
    }
    return contracts.get(id)!;
  };
  const secret = randomBytes(24).toString("base64url");
  let forwarded = 0;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // 路径：/<adapterId>/<上游剩余路径>
    const parts = url.pathname.replace(/^\/+/, "").split("/");
    const adapterId = parts.shift() ?? "";
    const restPath = parts.join("/");

    if (req.headers["x-hive-proxy-secret"] !== secret) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "proxy secret mismatch" }));
      return;
    }
    const contract = getContract(adapterId);
    if (!contract || contract.kind === "cli") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `unknown api adapter: ${adapterId}` }));
      return;
    }
    const apiKey = contract.env_key ? (env[contract.env_key] ?? "") : "";
    if (!apiKey) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `missing ${contract.env_key} in kernel env（凭据代理：key 只在内核进程）` }));
      return;
    }

    const upstream = new URL(contract.base_url!.replace(/\/$/, "") + "/" + restPath);
    upstream.search = url.search;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const ureq = fetch(upstream, {
        method: req.method,
        headers: {
          "content-type": req.headers["content-type"] ?? "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: body.length ? body : undefined,
        signal: AbortSignal.timeout(300000),
      })
        .then(async (ures) => {
          forwarded += 1;
          res.writeHead(ures.status, { "content-type": ures.headers.get("content-type") ?? "application/json" });
          res.end(Buffer.from(await ures.arrayBuffer()));
        })
        .catch((err: unknown) => {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `upstream failed: ${err instanceof Error ? err.message : String(err)}` }));
        });
      void ureq;
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    secret,
    port,
    get forwarded() {
      return forwarded;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

