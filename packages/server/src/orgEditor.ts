import { writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateChart, TeamChartSchema } from "@hive/shared";
import type { TeamChart } from "@hive/shared";
import { loadAdapter } from "@hive/adapters";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * 组织编辑器 API（V1.0 表单式第一版）：
 * GET  /api/org/engines          引擎注册表（换脑下拉数据源；api 引擎如实标注 key 是否就绪）
 * GET  /api/org/templates        列出 teams/*.json 模板
 * GET  /api/org/template/:name   读某模板全文
 * PUT  /api/org/template/:name   校验 + 保存模板（仅 teams/ 目录，禁路径穿越）
 * 拖拽画布属 V1.0 后段；本版提供表单式编辑的数据面。
 */
export function registerOrgRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string,
  teamsDir: string,
  sendJson: (res: ServerResponse, status: number, body: unknown) => void,
  adaptersDir?: string,
): boolean {
  if (!path.startsWith("/api/org/")) return false;

  // 换脑数据源：引擎注册表（坏契约如实跳过并报数，不粉饰）
  if (path === "/api/org/engines" && req.method === "GET") {
    if (!adaptersDir || !existsSync(adaptersDir)) {
      sendJson(res, 404, { error: "未配置 adaptersDir，引擎注册表不可用" });
      return true;
    }
    const engines: Array<Record<string, unknown>> = [];
    const broken: string[] = [];
    for (const f of readdirSync(adaptersDir).filter((x) => x.endsWith(".json"))) {
      try {
        const c = loadAdapter(join(adaptersDir, f));
        // key 就绪度如实标注：api 引擎查内核进程环境变量；cli/local 引擎看本机运行时（null = 不适用）
        const keyReady = c.kind === "api" ? (c.env_key ? Boolean(process.env[c.env_key]) : false) : null;
        engines.push({
          adapter: c.adapter,
          kind: c.kind,
          mode: c.mode,
          model: c.model,
          tier: c.tier,
          envKey: c.env_key,
          keyReady,
        });
      } catch (e) {
        broken.push(`${f.replace(/\.json$/, "")}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    engines.sort((a, b) => String(a.adapter).localeCompare(String(b.adapter)));
    sendJson(res, 200, { engines, broken });
    return true;
  }


  if (path === "/api/org/templates" && req.method === "GET") {
    const files = existsSync(teamsDir) ? readdirSync(teamsDir).filter((f) => f.endsWith(".json")) : [];
    const templates = files.map((f) => {
      try {
        const chart = JSON.parse(readFileSync(join(teamsDir, f), "utf8")) as TeamChart;
        const errs = validateChart(chart);
        return {
          file: f.replace(/\.json$/, ""),
          team: chart.team ?? f,
          roles: chart.roles?.length ?? 0,
          handoffs: chart.handoffs?.length ?? 0,
          valid: errs.length === 0,
          errors: errs,
        };
      } catch (e) {
        return { file: f.replace(/\.json$/, ""), valid: false, errors: [errText(e)] };
      }
    });
    sendJson(res, 200, { templates });
    return true;
  }

  const m = path.match(/^\/api\/org\/template\/([a-zA-Z0-9_-]+)$/);
  if (m) {
    const name = m[1];
    const file = join(teamsDir, `${name}.json`);

    if (req.method === "GET") {
      if (!existsSync(file)) {
        sendJson(res, 404, { error: `模板不存在：${name}` });
        return true;
      }
      try {
        const chart = JSON.parse(readFileSync(file, "utf8")) as TeamChart;
        sendJson(res, 200, { name, chart, errors: validateChart(chart) });
      } catch (e) {
        sendJson(res, 500, { error: errText(e) });
      }
      return true;
    }

    if (req.method === "PUT") {
      let body = "";
      req.on("data", (c: string) => {
        body += c;
        if (body.length > 500_000) req.destroy();
      });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body) as { chart?: unknown };
          const raw = parsed.chart ?? JSON.parse(body || "{}");
          const errs0 = TeamChartSchema.safeParse(raw);
          if (!errs0.success) {
            return sendJson(res, 400, { error: "schema 校验失败", issues: errs0.error.issues.slice(0, 5) });
          }
          const errs = validateChart(errs0.data);
          if (errs.length) {
            return sendJson(res, 400, { error: "语义校验失败", issues: errs });
          }
          // 路径穿越防护：name 已由正则限定 [a-zA-Z0-9_-]
          if (existsSync(file) && name === "mock-team") {
            return sendJson(res, 400, { error: "mock-team 是内核兜底模板，禁止覆盖" });
          }
          writeFileSync(file, JSON.stringify(errs0.data, null, 2) + "\n", "utf8");
          return sendJson(res, 200, { ok: true, name, saved: `${name}.json` });
        } catch (e) {
          return sendJson(res, 400, { error: errText(e) });
        }
      });
      return true;
    }
  }

  return false;
}


function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
