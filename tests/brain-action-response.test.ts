import { expect, test } from "bun:test";
import { attachmentFilename, consumeActionSuccess, nativeDownloadUrl } from "../src/components/BrainCabin";

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
