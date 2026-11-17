/**
 * VM 驱动 SPI（云无关）：每 agent 一台云电脑。
 * 契约先行——编排器只认这个接口；云厂商适配器（腾讯/阿里/fake）各自实现。
 *
 * 执行通道 v0：VM 内 agent 守护（user-data cloud-init 开机自启）——
 *   守护监听 7788 端口，POST /exec {token, command} → 本地执行 → JSON 回传。
 *   编排器经公网 IP 调用；token 由编排器生成随 user-data 注入（防裸奔）。
 */

export interface VMSpec {
  /** agent 名（VM 命名与幂等键） */
  name: string;
  /** 地域（云厂商语义，如 ap-guangzhou） */
  region?: string;
  /** 规格档位（云厂商语义；缺省 = 驱动默认最低档） */
  instanceType?: string;
  /** OS 镜像（缺省 ubuntu 22.04） */
  imageOs?: string;
}

export interface VMHandle {
  vmId: string;
  name: string;
  publicIp: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface VMDriver {
  readonly id: string;
  /** 开机（幂等：同 name 存在则返回既有 VM） */
  createVM(spec: VMSpec): Promise<VMHandle>;
  /** 等待 VM 可执行（agent 守护就绪），超时抛错 */
  waitAgentReady(vmId: string, timeoutMs?: number): Promise<void>;
  /** 在 VM 内执行命令（经 agent 守护） */
  exec(vmId: string, command: string, timeoutMs?: number): Promise<ExecResult>;
  /** 销毁（关机+释放，不再计费） */
  destroyVM(vmId: string): Promise<void>;
  /** 单小时成本估算（USD，记账用） */
  usdPerHour(): number;
}

export class CloudError extends Error {}

/** 生成 VM 内 agent 守护的 user-data（cloud-init）：开机自启 HTTP 执行器 */
export function buildAgentUserData(opts: { token: string; hubUrl: string; agentName: string }): string {
  const payload = JSON.stringify({ token: opts.token, hubUrl: opts.hubUrl, agentName: opts.agentName });
  return `#cloud-init
runcmd:
  - |
    set -e
    mkdir -p /opt/hive-agent
    cat > /opt/hive-agent/agent.json <<'JSON'
    ${payload}
    JSON
    cat > /opt/hive-agent/agent.js <<'JS'
    const http = require("http");
    const { execSync } = require("child_process");
    const cfg = require("/opt/hive-agent/agent.json");
    http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let parsed = {};
        try { parsed = JSON.parse(body || "{}"); } catch {}
        if (req.url !== "/exec" || parsed.token !== cfg.token) {
          res.writeHead(403).end(JSON.stringify({ error: "forbidden" }));
          return;
        }
        const timeoutMs = Math.min(Number(parsed.timeoutMs) || 60000, 300000);
        try {
          const out = execSync(String(parsed.command || ""), { timeout: timeoutMs, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
          res.writeHead(200).end(JSON.stringify({ stdout: String(out), stderr: "", exitCode: 0 }));
        } catch (e) {
          res.writeHead(200).end(JSON.stringify({
            stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? e.message ?? ""), exitCode: e.status ?? 1,
          }));
        }
      });
    }).listen(7788, () => console.log("hive agent ready"));
    JS
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash || true
    export NVM_DIR="$HOME/.nvm" && . "$HOME/.nvm/nvm.sh" || true
    nvm install 22 || true
    nohup node /opt/hive-agent/agent.js > /var/log/hive-agent.log 2>&1 &
`;
}
