/**
 * 桌面壳 server 子进程：跑系统 node（有 node:sqlite），内核内嵌此处。
 * Electron 主进程只负责窗口（Electron 内嵌 Node 版本不受限）。
 * 输出：.board-url 文件 + stdout（父进程读取）。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const desktopRoot = dirname(fileURLToPath(import.meta.url));
const hiveRoot = join(desktopRoot, "..", "..");

const envPath = join(hiveRoot, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const { HiveKernel } = await import(pathToFileURL(join(hiveRoot, "packages/kernel/dist/index.js")).href);
const { createHiveServer } = await import(pathToFileURL(join(hiveRoot, "packages/server/dist/index.js")).href);
const { createAdapterResolver, startCredentialProxy } = await import(
  pathToFileURL(join(hiveRoot, "packages/adapters/dist/index.js")).href
);

const teamName = process.env.HIVE_TEAM ?? "mock-team";
const chart = JSON.parse(readFileSync(join(hiveRoot, "teams", `${teamName}.json`), "utf8"));
const adaptersDir = join(hiveRoot, "packages", "adapters", "adapters");
const dataDir = process.env.HIVE_DATA_DIR ?? join(hiveRoot, "data", `desktop-${new Date().toISOString().replace(/[:.]/g, "-")}`);

const proxy = await startCredentialProxy({ adaptersDir, env: process.env });
const workers = createAdapterResolver({ adaptersDir, proxyUrl: proxy.url, proxySecret: proxy.secret });
const kernel = new HiveKernel({
  dataDir,
  chart,
  workers,
  vaultDir: process.env.HIVE_VAULT ?? undefined,
  skillsDir: existsSync(join(hiveRoot, "skills")) ? join(hiveRoot, "skills") : undefined,
});
const board = await createHiveServer({ kernel, teamsDir: join(hiveRoot, "teams"), adaptersDir });

const url = `http://127.0.0.1:${board.port}`;
writeFileSync(join(desktopRoot, ".board-url"), url, "utf8");
console.log(`board.url=${url}`);

process.on("SIGINT", () => {
  proxy.close();
  board.close();
  process.exit(0);
});
