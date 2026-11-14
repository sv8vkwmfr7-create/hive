/**
 * 团队技能（技能锻造厂 v0）：好做法沉淀为 markdown 技能文件，
 * 任务指令命中 applies 关键词时随任务包下发给接活的蜂。
 *
 * 文件格式（skills/<name>.md）：
 * ---
 * name: 竞品简报
 * description: 竞品调研简报的结构与口径规范
 * applies: [简报, 竞品, 调研]
 * ---
 * 正文 = 做法本体（结构、口径、红线）。
 * applies 留空 = 全局技能（每单都挂）。
 */

export interface SkillFile {
  name: string;
  description: string;
  applies: string[];
  /** 正文（做法本体） */
  body: string;
  /** 来源文件名（不含 .md） */
  file: string;
}

export class SkillError extends Error {}

/** 解析一个技能 markdown（frontmatter + 正文） */
export function parseSkillFile(text: string, file: string): SkillFile {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) throw new SkillError(`技能 ${file} 缺少 frontmatter（name/description/applies）`);
  const name = fm[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
  if (!name) throw new SkillError(`技能 ${file} 缺少 name`);
  const description = fm[1].match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const appliesRaw = fm[1].match(/^applies:\s*(.+)$/m)?.[1]?.trim() ?? "";
  // 支持 [a, b] 与 a,b 两种写法
  const applies = appliesRaw
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((k) => k.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  const body = text.slice(fm[0].length).trim();
  if (!body) throw new SkillError(`技能 ${file} 正文为空（做法本体不能为空）`);
  return { name, description, applies, body, file };
}

/** 任务指令 → 命中的技能：applies 空 = 全局；否则任一关键词（小写）出现在指令中即命中 */
export function matchSkills(skills: SkillFile[], instruction: string): SkillFile[] {
  const lower = instruction.toLowerCase();
  return skills.filter((s) => s.applies.length === 0 || s.applies.some((k) => lower.includes(k.toLowerCase())));
}

/** 全量校验：重名即非法（同名字段会互相覆盖，锻造厂必须拒绝） */
export function validateSkills(skills: SkillFile[]): string[] {
  const errors: string[] = [];
  const seen = new Map<string, string>();
  for (const s of skills) {
    const prev = seen.get(s.name);
    if (prev) errors.push(`技能重名：${s.name}（${prev} 与 ${s.file}）`);
    seen.set(s.name, s.file);
    if (s.applies.length === 0) errors.push(`技能 ${s.name}（${s.file}）无 applies 关键词——将挂到每一单，确认是有意为之`);
  }
  return errors;
}
