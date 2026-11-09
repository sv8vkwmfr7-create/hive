import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { HiveKernel, replayTask } from "@hive/kernel";
import type { StoredEvent } from "@hive/kernel";
import { listTasks } from "./views.js";

const DEFAULT_PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

export interface HiveServerOptions {
  kernel: HiveKernel;
  /** 默认 0 = 随机可用端口（测试友好） */
  port?: number;
  host?: string;
  publicDir?: string;
}

export interface HiveServer {
  port: number;
  /** 组播内核事件（已广播给 WS 客户端之后仍可被订阅） */
  onEvent(fn: (e: StoredEvent) => void): () => void;
  close(): Promise<void>;
}

/**
 * Hive server v0：把内核事件流用 HTTP API + WebSocket 暴露出去，附带最简 Web 看板。
 * 无鉴权——MVP 只绑本机；对外暴露是 V1.0 凭据代理加固后的事（不做清单外的事不写）。
 */
export async function createHiveServer(opts: HiveServerOptions): Promise<HiveServer> {
  const { kernel } = opts;
  const publicDir = resolve(opts.publicDir ?? DEFAULT_PUBLIC_DIR);

  const httpServer = createServer((req, res) => {
    void route(req, res).catch((err: unknown) => {
      sendJson(res, 500, { error: errText(err) });
    });
  });

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  wss.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "snapshot", tasks: listTasks(kernel) }));
  });

  const listeners = new Set<(e: StoredEvent) => void>();
  const offKernel = kernel.onEvent((e) => {
    const msg = JSON.stringify({ type: "event", event: e });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
    for (const fn of listeners) fn(e);
  });

  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((res, rej) => {
    httpServer.once("error", rej);
    httpServer.listen(opts.port ?? 0, host, () => res());
  });
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 0);

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = decodeURIComponent(url.pathname);

    if (path === "/health") return sendJson(res, 200, { ok: true });
    if (path === "/api/chart") return sendJson(res, 200, { chart: kernel.chart });
    if (path === "/api/tasks" && req.method === "GET") return sendJson(res, 200, { tasks: listTasks(kernel) });
    if (path === "/api/tasks" && req.method === "POST") return handleCreateTask(req, res);

    const taskMatch = path.match(/^\/api\/tasks\/([^/]+)(\/artifacts)?$/);
    if (taskMatch) {
      const taskId = taskMatch[1];
      if (taskMatch[2]) return handleArtifacts(res, taskId);
      return handleTaskDetail(res, taskId);
    }

    return serveStatic(res, path);
  }

  function handleCreateTask(req: IncomingMessage, res: ServerResponse): void {
    let body = "";
    req.on("data", (c: string) => {
      body += c;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        const input = JSON.parse(body || "{}") as { title?: string; brief?: string; budgetUsd?: number; source?: string };
        if (!input.title || !input.brief) {
          return sendJson(res, 400, { error: "title 与 brief 必填" });
        }
        const taskId = kernel.createTask({
          title: input.title,
          brief: input.brief,
          budgetUsd: input.budgetUsd,
          source: input.source ?? "web-board",
        });
        // 自动开跑（不 await——事件流会实时推给看板）
        void kernel.runTask(taskId).catch((err) => {
          console.error(`runTask #${taskId} 意外失败：`, err);
        });
        return sendJson(res, 202, { taskId, accepted: true });
      } catch (err) {
        return sendJson(res, 400, { error: errText(err) });
      }
    });
  }

  function handleTaskDetail(res: ServerResponse, taskId: string): void {
    const summary = listTasks(kernel).find((t) => t.taskId === taskId);
    if (!summary) return sendJson(res, 404, { error: `任务不存在：#${taskId}` });
    const rp = replayTask(kernel.store, taskId);
    return sendJson(res, 200, { ...summary, timeline: rp.timeline, receipt: rp.receipt });
  }

  function handleArtifacts(res: ServerResponse, taskId: string): void {
    const events = kernel.store.replayTaskEvents(taskId);
    const artifacts = events
      .filter((e) => e.kind === "artifact.produced")
      .map((e) => (e.payload as { path: string; kind?: string }).path)
      .filter((p) => existsSync(p) && isInsideTaskArtifacts(taskId, p))
      .map((p) => ({
        path: p,
        name: p.split(/[\\/]/).at(-1),
        kind: events.find((e) => e.kind === "artifact.produced" && (e.payload as { path: string }).path === p),
        content: readFileSync(p, "utf8").slice(0, 1_000_000),
      }));
    return sendJson(res, 200, {
      artifacts: artifacts.map((a) => ({ path: a.path, name: a.name, content: a.content })),
    });
  }

  /** 路径穿越防护：只允许读该任务 artifacts 目录内的文件 */
  function isInsideTaskArtifacts(taskId: string, p: string): boolean {
    const base = resolve(join(kernel.dataDir, "artifacts", taskId));
    return resolve(p).startsWith(base + sep) || resolve(p) === base;
  }

  function serveStatic(res: ServerResponse, path: string): void {
    const rel = path === "/" ? "index.html" : path.replace(/^\/+/, "");
    const file = normalize(join(publicDir, rel));
    if (!file.startsWith(publicDir + sep) && file !== publicDir) {
      return sendJson(res, 403, { error: "forbidden" });
    }
    if (!existsSync(file)) {
      return sendJson(res, 404, { error: "not found" });
    }
    const mime = MIME[extname(file)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": mime });
    res.end(readFileSync(file));
  }

  return {
    port,
    onEvent(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    close: () =>
      new Promise<void>((resolveClose) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => {
          httpServer.closeAllConnections();
          httpServer.close(() => {
            offKernel();
            resolveClose();
          });
        });
      }),
  };
}

function errText(e: unknown): string {
  return e instanceof Error ? (e.stack ?? e.message) : String(e);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
