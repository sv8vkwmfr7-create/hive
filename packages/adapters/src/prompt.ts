import { readFileSync } from "node:fs";

/** 引擎 worker 收到的任务包（kernel → worker 行协议的 stdin 部分） */
export interface TaskPack {
  taskId: string;
  botId: string;
  role: string;
  instruction: string;
  artifactDir: string;
  inputArtifacts: Array<{ botId: string; path: string }>;
  /** 本 bot 的合法派单链（chart 边），由内核传入；真正的强制在内核门禁 */
  handoffs?: Array<{ to: string; when: string }>;
  /** 共享大脑（团队知识库）已有条目——接活先查库，避免重复劳动 */
  vault?: Array<{ name: string }>;
  /** 审批门：本任务已获 CEO 批准的动作（重跑的蜂据此跳过再次请求审批） */
  approvals?: string[];
}

const MAX_ARTIFACT_CHARS = 4000;
const MAX_CHUNK_CHARS = 4000;

export function clip(s: string, max = MAX_CHUNK_CHARS): string {
  return s.length <= max ? s : s.slice(0, max) + `…（截断 ${s.length - max} 字）`;
}

/**
 * 任务包 → 引擎 prompt（纯函数，离线可测）。
 * 把治理规则写进 prompt 是"请求"；真正的强制在内核——这里只负责把规矩讲清楚。
 * API 引擎是单轮调用，角色契约必须一次讲死，否则 T1 模型倾向自己干完全部活。
 */
export function buildPrompt(pack: TaskPack, adapterName: string): string {
  const isReviewer = pack.role === "reviewer";
  const isChief = pack.role === "orchestrator";
  const handoffTargets = pack.handoffs ?? [];
  const handoffList = handoffTargets.map((h) => `- 「${h.to}」：${h.when}`).join("\n");

  const artifacts = pack.inputArtifacts
    .map((a) => {
      let content = "";
      try {
        content = clip(readSafe(a.path), MAX_ARTIFACT_CHARS);
      } catch {
        content = "（文件不可读）";
      }
      return `- ${a.path.split(/[\\/]/).at(-1)}：\n${content}`;
    })
    .join("\n");

  const replyShape = isReviewer
    ? `{"say": "给总管的一句话说明", "verdict": {"verdict": "PASS 或 BLOCK 或 HOLD", "evidence": "判定依据（BLOCK 必填）"}}`
    : isChief
      ? `{"say": "给用户的简短进展说明", "handoff": {"to": "<合法交接目标之一>", "note": {"reason": "转交原因", "progress": "当前进度", "ask": "需要对方做什么"}}}`
      : `{"say": "给用户的简短进展说明", "artifact": {"filename": "名字.md", "content": "全文"}, "handoff": {"to": "<合法交接目标之一>", "note": {"reason": "转交原因", "progress": "当前进度", "ask": "需要对方做什么"}} 或无下一棒时省略 handoff}`;

  const roleRules = isReviewer
    ? [`- 你是独立审核员：只出 PASS / BLOCK（必须带证据）/ HOLD，绝不替生产者改稿，也不产出任何文件`]
    : isChief
      ? [
          `- 你是总管：你不亲自产出成品，回复里禁止出现 artifact 字段`,
          `- 你必须把活派出去：handoff 字段必填，"to" 只能从下方合法交接目标里选`,
          `- 交接三要素缺一不可：reason（转交原因）、progress（当前进度）、ask（需要对方做什么）`,
        ]
      : [
          `- 你是专业岗：必须产出自己的 artifact`,
          `- 若下方存在合法交接目标，说明还有下一棒：必须同时 handoff 交给它；没有则省略 handoff`,
          `- 交接三要素缺一不可：reason（转交原因）、progress（当前进度）、ask（需要对方做什么）`,
          `- 只有总管能主动联络其他 bot；你的交接目标必须来自下方派单链`,
        ];

  return [
    `你是蜂巢 Hive 团队的 bot「${pack.botId}」（角色类型：${pack.role}，引擎：${adapterName}）。`,
    `任务 #${pack.taskId} 指令：${pack.instruction}`,
    artifacts ? `\n上游产物：\n${artifacts}` : "",
    `\n治理规则：`,
    ...roleRules,
    handoffTargets.length
      ? `\n合法交接目标（只能从中选一个，没有匹配就选最接近的）：\n${handoffList}`
      : `\n（你没有合法交接目标：干完即交付，不要试图 handoff）`,
    pack.vault?.length
      ? `\n团队知识库（共享大脑）已有条目——开工前先查库，与已有条目重复的活不要重做，可引用其结论：\n${pack.vault.map((v) => `- ${v.name}`).join("\n")}`
      : `\n团队知识库（共享大脑）当前为空：你交付的产物会自动落库，成为团队的长期资产`,
    pack.approvals?.length
      ? `\n已获 CEO 批准、可直接执行的动作（无需再请求审批）：${pack.approvals.join("、")}`
      : "",
    `\n回复格式（严格要求）：只输出一个 JSON 对象，不要任何多余文本、解释或代码块标记：`,
    replyShape,
  ]
    .filter(Boolean)
    .join("\n");
}

function readSafe(path: string): string {
  return readFileSync(path, "utf8");
}
