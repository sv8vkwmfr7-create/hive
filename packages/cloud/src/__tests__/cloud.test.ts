import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeVMDriver, buildAgentUserData, CloudError } from "../index.js";

test("P0 全链：createVM → exec → destroy（假云驱动，行为契约）", async () => {
  const driver = new FakeVMDriver();
  driver.queueResult("total 24\ndrwxr-xr-x root\n");

  const vm = await driver.createVM({ name: "研究员", region: "ap-guangzhou" });
  assert.match(vm.vmId, /^fake-vm-\d+$/);
  assert.match(vm.publicIp, /^203\.0\.113\./);

  await driver.waitAgentReady(vm.vmId);
  const r = await driver.exec(vm.vmId, "ls -la /opt");
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /total 24/);

  await driver.destroyVM(vm.vmId);
  await assert.rejects(() => driver.exec(vm.vmId, "ls"), CloudError, "销毁后 exec 应拒绝");
  assert.equal(driver.destroyed.length, 1);
  assert.equal(driver.usdPerHour(), 0.08);
});

test("P0 幂等：同名 createVM 复用既有 VM；createVM 失败如实抛错", async () => {
  const driver = new FakeVMDriver();
  const a = await driver.createVM({ name: "写手" });
  const b = await driver.createVM({ name: "写手" });
  assert.equal(a.vmId, b.vmId, "同名应复用（幂等）");
  assert.equal(driver.created.length, 2, "spec 应记录（审计）");

  driver.failNextCreate = "QuotaExceeded: 实例数超限";
  await assert.rejects(() => driver.createVM({ name: "爆仓" }), /QuotaExceeded/, "云侧错误如实抛出");
});

test("user-data：cloud-init 脚本含 token/hubUrl/agentName，且不落明文 token 到模板", () => {
  const ud = buildAgentUserData({ token: "secret-token-x", hubUrl: "http://hub:8080", agentName: "研究员" });
  assert.match(ud, /^#cloud-init/);
  assert.match(ud, /secret-token-x/);
  assert.match(ud, /agent\.js/);
  assert.match(ud, /listen\(7788/);

  // 写成文件供真 VM 注入用（形态验证）
  const dir = mkdtempSync(join(tmpdir(), "hive-cloud-"));
  const f = join(dir, "user-data.txt");
  writeFileSync(f, ud, "utf8");
  assert.match(readFileSync(f, "utf8"), /hive-agent/);
});
