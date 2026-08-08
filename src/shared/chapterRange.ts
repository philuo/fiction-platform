// 登场章节显示格式化（零依赖纯函数）：合并连续章节为区间，如 [1,2,3,4,5,6,7,10,12,15,16,17,18,20] → "1~7、10、12、15~18、20"。
// 独立成模块（不依赖 world 类型），供服务端 worldSummary/报错与前端各面板共用。

/** 登场章节区间压缩显示：合并连续章节为 a~b（连续 2 个及以上），单章独立列出。
 * 例：[1,2,3,4,5,6,7,10,12,15,16,17,18,20] → "1~7、10、12、15~18、20"
 * 未登场（undefined/空数组/非数字）返回 "0"，便于拼「登场 N 章」。 */
export function formatChapterRange(chapters: readonly number[] | undefined): string {
  const arr = [...new Set((chapters ?? []).filter((n) => Number.isFinite(n)))].sort((a, b) => a - b);
  if (arr.length === 0) return "0";
  const parts: string[] = [];
  let start = arr[0];
  let prev = arr[0];
  for (let i = 1; i <= arr.length; i++) {
    const cur = arr[i];
    if (cur === prev + 1) {
      prev = cur;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}~${prev}`);
    start = cur;
    prev = cur;
  }
  return parts.join("、");
}
