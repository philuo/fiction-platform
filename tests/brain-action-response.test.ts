import { expect, test } from "bun:test";
import { attachmentFilename, consumeActionSuccess, nativeDownloadUrl, shouldHideSettledPreviewText } from "../src/components/BrainCabin";

test("附件文件名优先解析 RFC 5987 UTF-8 值", () => {
  expect(attachmentFilename("attachment; filename=rain.md; filename*=UTF-8''%E9%9B%A8%E5%A4%9C%E6%A1%A3%E6%A1%88.md"))
    .toBe("雨夜档案.md");
  expect(attachmentFilename("inline; filename=ignored.md")).toBeNull();
});

test("Brain 动作附件响应必须触发下载后才返回成功", async () => {
  const response = new Response("# 雨夜档案\n", {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": "attachment; filename=rain.md; filename*=UTF-8''%E9%9B%A8%E5%A4%9C%E6%A1%A3%E6%A1%88.md",
    },
  });
  const calls: { filename: string; text: string }[] = [];
  const result = await consumeActionSuccess(response, async (res, filename) => {
    calls.push({ filename, text: await res.text() });
  });

  expect(calls).toEqual([{ filename: "雨夜档案.md", text: "# 雨夜档案\n" }]);
  expect(result).toEqual({ success: true, detail: "已开始下载：雨夜档案.md" });
});

test("全书导出动作复用页面原生下载 URL", () => {
  expect(nativeDownloadUrl("/api/novel/export", { title: "雨夜档案", format: "md" }))
    .toBe("/api/novel/export?title=%E9%9B%A8%E5%A4%9C%E6%A1%A3%E6%A1%88&format=md");
  expect(nativeDownloadUrl("/api/novel/eval", { title: "雨夜档案" })).toBeNull();
});

test("一致性巡检 JSON 响应生成可见结论而不是通用执行成功", async () => {
  const clean = await consumeActionSuccess(new Response(JSON.stringify({
    ok: true,
    report: { autoFixed: [], findings: [], orphanMedia: [] },
  }), { headers: { "Content-Type": "application/json" } }));
  expect(clean).toEqual({ success: true, detail: "一致性巡检完成：未发现问题。" });

  const found = await consumeActionSuccess(new Response(JSON.stringify({
    ok: true,
    report: {
      autoFixed: ["已补齐摘要"],
      findings: [{ level: "warning", issue: "第 2 章伏笔引用悬空" }],
      orphanMedia: [{ chapterIndex: 1, mediaId: "m1" }],
    },
  }), { headers: { "Content-Type": "application/json" } }));
  expect(found.detail).toContain("发现 1 个问题");
  expect(found.detail).toContain("自动修复 1 项");
  expect(found.detail).toContain("孤儿媒体 1 项");
  expect(found.detail).toContain("第 2 章伏笔引用悬空");
  expect(found.detail).not.toBe("执行成功");
});

test("Preview 成功后隐藏与预览摘要重复的旧消息正文", () => {
  const summary = "已准备「一致性巡检」操作；请核对下方预览后执行，当前尚未执行。";
  expect(shouldHideSettledPreviewText({
    id: "m1", role: "brain", text: summary, at: "2026-08-14T00:00:00.000Z",
    cards: [{ kind: "preview", title: "一致性巡检", summary, executionState: "succeeded", detail: "一致性巡检完成：未发现问题。" }],
  }, summary)).toBe(true);
  expect(shouldHideSettledPreviewText({
    id: "m2", role: "brain", text: summary, at: "2026-08-14T00:00:00.000Z",
    cards: [{ kind: "preview", title: "一致性巡检", summary, executionState: "failed", detail: "失败" }],
  }, summary)).toBe(false);
  expect(shouldHideSettledPreviewText({
    id: "m3", role: "brain", text: "额外说明", at: "2026-08-14T00:00:00.000Z",
    cards: [{ kind: "preview", title: "一致性巡检", summary, executionState: "succeeded", detail: "完成" }],
  }, "额外说明")).toBe(false);
});
