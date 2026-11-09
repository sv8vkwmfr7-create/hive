#!/usr/bin/env node
/**
 * 蜂巢看板 demo：起 server，浏览器打开看板，3 秒后自动发一单演示任务。
 * 你会在时间线/输出流里实时看到 chief→researcher→writer→reviewer 的流转与账单。
 * 运行：pnpm --filter @hive/server demo   然后打开 http://127.0.0.1:<port>
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HiveKernel } from "@hive/kernel";
import { createHiveServer } from "../dist/index.js";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const hiveRoot = join(serverRoot, "..", "..");
const chart = JSON.parse(readFileSync(join(hiveRoot, "teams", "mock-team.json"), "utf8"));
const dataDir = join(serverRoot, "data", `demo-${new Date().toISOString().replace(/[:.]/g, "-")}`);

const kernel = new HiveKernel({ dataDir, chart });
const server = await createHiveServer({ kernel, publicDir: join(serverRoot, "public") });

console.log(`\n🐝 蜂巢看板已启动： http://127.0.0.1:${server.port}`);
console.log("   Ctrl+C 退出；3 秒后自动发一单演示任务，可先打开浏览器。");

setTimeout(() => {
  const taskId = kernel.createTask({
    title: "竞品简报",
    brief: "调研 3 个竞品的定位与定价，产出一份研究简报",
    budgetUsd: 3,
    source: "board-demo",
  });
  void kernel
    .runTask(taskId)
    .then((r) => console.log(`演示任务 #${taskId}: ${r.status}，花费 $${r.receipt?.totalUsd?.toFixed(2) ?? "?"}`))
    .catch((err) => console.error(err));
}, 3000);

setInterval(() => {}, 1 << 30);
