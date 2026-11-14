/**
 * 蜂巢桌面壳（Electron）：内核进程内嵌——主进程直接起 HiveKernel + HiveServer，
 * 窗口加载本地看板。无独立 server 进程，凭据代理与通道逻辑不变。
 *
 * 运行：pnpm --filter @hive/desktop start
 * 可选：HIVE_TEAM=<teams/ 模板名>（默认 mock-team）  HIVE_DATA_DIR=<既有数据目录>
 * 凭据：.env 若存在则加载（Telegram 等通道自动起；无凭据也能用看板+组织编辑器）
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const desktopRoot = dirname(fileURLToPath(import.meta.url));
const hiveRoot = join(desktopRoot, "..", "..");

// Electron 主进程不自动读 .env——手工加载（不打印值）
const envPath = join(hiveRoot, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const { app, BrowserWindow, shell } = await import("electron");
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

let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    title: "蜂巢 Hive",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true },
  });
  win.loadURL(board.url);
  // 外部链接走系统浏览器（看板内只留本应用）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(board.url)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(() => {
  createWindow();
  // Windows GUI 模式 stdout 不回传——URL 落文件供外部验证/自动化
  writeFileSync(join(desktopRoot, ".board-url"), board.url, "utf8");
  console.log(`\n🐝 蜂巢桌面壳已启动`);
  console.log(`   团队: ${teamName} · 看板: ${board.url}`);
  if (process.env.TELEGRAM_BOT_TOKEN) console.log("   telegram: 凭据已加载（通道由 hive-chat 负责；桌面壳为纯看板形态）");
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  proxy.close();
  kernel.close?.();
  board.close();
  app.quit();
});
