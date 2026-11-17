/**
 * 假云驱动：进程内模拟 VM（离线测试 P0 全链，凭据无关）。
 * exec 结果可编程（queueResult 注入），行为契约与真驱动一致。
 */
import { CloudError, buildAgentUserData, type ExecResult, type VMDriver, type VMHandle, type VMSpec } from "./vmDriver.js";

export class FakeVMDriver implements VMDriver {
  readonly id = "fake";
  private vms = new Map<string, VMHandle & { alive: boolean }>();
  private results: string[] = []; // exec 弹出队列（可编程回复）
  created: VMSpec[] = [];
  destroyed: string[] = [];
  /** 模拟开关：createVM 抛错（额度不足等） */
  failNextCreate: string | null = null;
  /** 模拟开关：exec 时 VM 已销毁 */
  strictAlive = true;

  /** 注入下一次 exec 的 stdout（队列） */
  queueResult(stdout: string): void {
    this.results.push(stdout);
  }

  async createVM(spec: VMSpec): Promise<VMHandle> {
    if (this.failNextCreate) {
      const msg = this.failNextCreate;
      this.failNextCreate = null;
      throw new CloudError(msg);
    }
    this.created.push(spec);
    const existing = this.vms.get(spec.name);
    if (existing?.alive) return { vmId: existing.vmId, name: existing.name, publicIp: existing.publicIp };
    const handle = {
      vmId: `fake-vm-${this.vms.size + 1}`,
      name: spec.name,
      publicIp: `203.0.113.${this.vms.size + 1}`,
      alive: true,
    };
    this.vms.set(spec.name, handle);
    return { vmId: handle.vmId, name: handle.name, publicIp: handle.publicIp };
  }

  async waitAgentReady(_vmId: string, _timeoutMs?: number): Promise<void> {
    // 假驱动即时就绪
  }

  async exec(vmId: string, command: string, _timeoutMs?: number): Promise<ExecResult> {
    const vm = [...this.vms.values()].find((v) => v.vmId === vmId);
    if (this.strictAlive && (!vm || !vm.alive)) throw new CloudError(`VM ${vmId} 不存在或已销毁`);
    const stdout = this.results.shift() ?? "";
    return { stdout, stderr: "", exitCode: 0 };
  }

  async destroyVM(vmId: string): Promise<void> {
    const vm = [...this.vms.values()].find((v) => v.vmId === vmId);
    if (!vm) throw new CloudError(`VM ${vmId} 不存在`);
    vm.alive = false;
    this.destroyed.push(vmId);
  }

  usdPerHour(): number {
    return 0.08; // 假定价：$0.08/小时（测试记账）
  }
}

// 防未使用告警：buildAgentUserData 被 agentBoot 测试引用，这里导出保持单一来源
export { buildAgentUserData };
