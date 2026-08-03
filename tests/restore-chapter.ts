// 恢复测试污染的章节文本：从 state.json.bak 取第 1 节原文并调 API 恢复
const { readFileSync } = require("node:fs");
const old = JSON.parse(readFileSync("data/断梦录/state.json.bak", "utf-8"));
const text = old.chapters[0].text;
console.log("原文开头:", text.slice(0, 40));
const res = await fetch("http://localhost:5173/api/novel/chapter/edit", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "断梦录", index: 1, text }),
});
const data = await res.json();
console.log("恢复结果 ok:", data.ok);
if (!data.ok) console.error(data.error);
