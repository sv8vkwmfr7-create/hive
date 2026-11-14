/**
 * 蜂巢桌面壳（Electron）：主进程只开窗口；server 跑在系统 node 子进程
 * （server-child.mjs——内核依赖 node:sqlite，Electron 内嵌 Node 版本不保证有）。
 * 架构：Electron(窗口) --spawn--> node(server-child) --写--> .board-url --读--> loadURL
 *
 * 运行：pnpm --filter @hive/desktop start
 * 可选：HIVE_TEAM=<teams/ 模板名>（默认 mock-team）  HIVE_DATA_DIR=<既有数据目录>
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = dirname(fileURLToPath(import.meta.url));
const hiveRoot = join(desktopRoot, "..", "..");

const { app, BrowserWindow, shell } = await import("electron");

const urlFile = join(desktopRoot, ".board-url");
rmSync(urlFile, { force: true });

// 系统 node 跑 server 子进程（有 node:sqlite；凭据代理/技能/组织编辑器全链同 hive-chat）
const child = spawn(process.execPath.includes("electron") ? "node" : process.execPath, [join(desktopRoot, "server-child.mjs")], {
  cwd: hiveRoot,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});
let childOut = "";
child.stdout.on("data", (c) => {
  childOut += c;
  process.stdout.write(`[server] ${c}`);
});
child.stderr.on("data", (c) => process.stderr.write(`[server:err] ${c}`));

let win;
function createWindow(url) {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    title: "蜂巢 Hive",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true },
  });
  win.loadURL(url);
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    if (u.startsWith(url)) return { action: "allow" };
    shell.openExternal(u);
    return { action: "deny" };
  });
}

function waitForUrl(timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (existsSync(urlFile)) {
        clearInterval(timer);
        resolve(readFileSync(urlFile, "utf8").trim());
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`server 子进程超时未产出 board-url\n${childOut.slice(-600)}`));
      }
    }, 200);
  });
}

app.whenReady().then(async () => {
  try {
    const url = await waitForUrl();
    createWindow(url);
    writeFileSync(join(desktopRoot, ".board-url"), url, "utf8");
  } catch (e) {
    new BrowserWindow({ width: 640, height: 400 }).loadURL(
      `data:text/html;charset=utf8,${encodeURIComponent(`<pre style="font-family:monospace;padding:20px">server 子进程启动失败：\n\n${String(e.message ?? e)}</pre>`)}`,
    );
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && existsSync(urlFile)) createWindow(readFileSync(urlFile, "utf8").trim());
  });
});

app.on("window-all-closed", () => {
  child.kill();
  app.quit();
});
