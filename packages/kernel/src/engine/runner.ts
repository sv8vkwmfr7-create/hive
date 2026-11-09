import { spawn } from "node:child_process";

/** bot 进程 → 内核的协议消息（worker stdout 每行一个 JSON） */
export type BotMsg =
  | { type: "output"; chunk: string }
  | { type: "handoff"; to: string; note: unknown }
  | { type: "artifact"; path: string; kind?: string }
  | { type: "usage"; tokensIn?: number; tokensOut?: number; usd: number; model?: string }
  | { type: "verdict"; verdict: "PASS" | "BLOCK" | "HOLD"; evidence?: string; reason?: string };

export interface RunBotOptions {
  workerPath: string;
  /** 附加参数（适配器桥接：argv 传契约文件路径） */
  args?: string[];
  /** 附加环境变量（适配器桥接：API key 经内核注入，bot 进程自身无凭据） */
  env?: Record<string, string>;
  stdinPayload: Record<string, unknown>;
  /** guards.max_turns：单次运行的协议消息上限，超出即杀进程（防失控烧钱） */
  maxTurns: number;
  onMsg: (m: BotMsg) => void;
}

export interface RunBotResult {
  code: number | null;
  stderrTail: string;
  killed: boolean;
}

/**
 * 进程管理：spawn 一个引擎 worker（MVP = mock 脚本；后续适配器复用同一协议），
 * 按 JSON 行解析 stdout 协议消息，stderr 只留尾部用于失败诊断。
 */
export function runBot(opts: RunBotOptions): Promise<RunBotResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [opts.workerPath, ...(opts.args ?? [])], {
      stdio: ["pipe", "pipe", "pipe"],
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    let stdoutBuf = "";
    let stderrTail = "";
    let msgCount = 0;
    let killed = false;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        msgCount += 1;
        if (msgCount > opts.maxTurns) {
          killed = true;
          child.kill("SIGKILL");
          stderrTail = `超出 max_turns=${opts.maxTurns}，内核强制终止`;
          return;
        }
        try {
          opts.onMsg(JSON.parse(line) as BotMsg);
        } catch {
          // 非 JSON 行：worker 违反协议。MVP 选择忽略并继续（真实适配器会升级为 error.reported）。
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
    });
    child.on("close", (code) => resolve({ code, stderrTail, killed }));

    child.stdin.write(JSON.stringify(opts.stdinPayload) + "\n");
    child.stdin.end();
  });
}
