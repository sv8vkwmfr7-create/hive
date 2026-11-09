/**
 * @hive/kernel —— 内核：任务总线、事件溯源、进程管理、预算熔断。
 * 协议一律来自 @hive/shared，禁止复制定义。
 */
export { EventStore } from "./store/eventStore.js";
export type { StoredEvent } from "./store/eventStore.js";
export { BudgetGuard } from "./core/budget.js";
export type { BudgetCheck } from "./core/budget.js";
export { HiveKernel } from "./core/kernel.js";
export type { KernelOptions, RunResult, WorkerSpec } from "./core/kernel.js";
export { runBot } from "./engine/runner.js";
export type { BotMsg, RunBotOptions, RunBotResult } from "./engine/runner.js";
export { replayTask } from "./replay.js";
export type { TaskReplay, TimelineEntry } from "./replay.js";
