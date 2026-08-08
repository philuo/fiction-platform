// 本章出场角色判定（左栏「脉络」与右栏「人物」共用，保证两栏一致）
// 实现已收敛到 src/shared/appearance.ts（服务端 chronicler 的登场重算同源引用），
// 本文件仅作为前端 re-export 入口，保持既有 import 路径不变。
export { normCharName, appearsInChapter, appearedChars, appearedInChapter, formatChapterRange } from "../shared/appearance";
