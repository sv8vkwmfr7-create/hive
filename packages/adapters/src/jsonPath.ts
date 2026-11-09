/** JSONPath-lite：支持 $.a.b[0].c；不带 $ 前缀则按相对路径求值（契约 usage_parse.scan 场景） */
export function getPath(obj: unknown, path: string): unknown {
  const rest = path.startsWith("$") ? path.slice(1).replace(/^\./, "") : path;
  if (!rest) return obj;
  let cur: unknown = obj;
  for (const seg of rest.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    const m = seg.match(/^([^\[\]]+)((\[\d+\])+)?$/);
    if (!m) return undefined;
    cur = (cur as Record<string, unknown>)[m[1]];
    if (m[2]) {
      for (const idx of m[2].matchAll(/\[(\d+)\]/g)) {
        if (!Array.isArray(cur)) return undefined;
        cur = cur[Number(idx[1])];
      }
    }
  }
  return cur;
}
