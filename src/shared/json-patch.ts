export type JsonPatchOperation =
  | { op: "add" | "replace"; path: string; value: unknown }
  | { op: "remove"; path: string };

function escapePointer(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function unescapePointer(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function equalJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => equalJson(value, b[index]));
  }
  if (!isObject(a) || !isObject(b)) return false;
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  return aKeys.length === bKeys.length
    && aKeys.every((key, index) => key === bKeys[index] && equalJson(a[key], b[key]));
}

/**
 * 生成 RFC 6902 patch。对象按字段递归，数组作为一个原子值替换：这能保证正确性，
 * 同时让运行态变化不会重复携带未变化的 world 正文。
 */
export function createJsonPatch(previous: unknown, next: unknown, path = ""): JsonPatchOperation[] {
  if (equalJson(previous, next)) return [];
  if (!isObject(previous) || !isObject(next)) return [{ op: path ? "replace" : "replace", path, value: next }];

  const ops: JsonPatchOperation[] = [];
  for (const key of Object.keys(previous).sort()) {
    if (!(key in next)) ops.push({ op: "remove", path: `${path}/${escapePointer(key)}` });
  }
  for (const key of Object.keys(next).sort()) {
    const childPath = `${path}/${escapePointer(key)}`;
    if (!(key in previous)) ops.push({ op: "add", path: childPath, value: next[key] });
    else ops.push(...createJsonPatch(previous[key], next[key], childPath));
  }
  return ops;
}

function cloneJson<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

/** 严格应用本项目生成的 RFC 6902 add/remove/replace 子集。非法路径直接抛错并触发 resync。 */
export function applyJsonPatch<T>(document: T, ops: JsonPatchOperation[]): T {
  let root: unknown = cloneJson(document);
  for (const op of ops) {
    if (op.path === "") {
      if (op.op === "remove") throw new Error("不能移除投影根节点");
      root = cloneJson(op.value);
      continue;
    }
    if (!op.path.startsWith("/")) throw new Error(`非法 JSON Pointer: ${op.path}`);
    const parts = op.path.slice(1).split("/").map(unescapePointer);
    const leaf = parts.pop()!;
    let parent: unknown = root;
    for (const part of parts) {
      if (Array.isArray(parent)) {
        const index = Number(part);
        if (!Number.isSafeInteger(index) || index < 0 || index >= parent.length) throw new Error(`数组路径不存在: ${op.path}`);
        parent = parent[index];
      } else if (isObject(parent) && part in parent) {
        parent = parent[part];
      } else {
        throw new Error(`对象路径不存在: ${op.path}`);
      }
    }
    if (Array.isArray(parent)) {
      const index = leaf === "-" ? parent.length : Number(leaf);
      if (!Number.isSafeInteger(index) || index < 0) throw new Error(`非法数组索引: ${op.path}`);
      if (op.op === "add") parent.splice(index, 0, cloneJson(op.value));
      else if (op.op === "remove") {
        if (index >= parent.length) throw new Error(`数组路径不存在: ${op.path}`);
        parent.splice(index, 1);
      } else {
        if (index >= parent.length) throw new Error(`数组路径不存在: ${op.path}`);
        parent[index] = cloneJson(op.value);
      }
      continue;
    }
    if (!isObject(parent)) throw new Error(`父路径不是容器: ${op.path}`);
    if (op.op === "remove") {
      if (!(leaf in parent)) throw new Error(`对象路径不存在: ${op.path}`);
      delete parent[leaf];
    } else {
      if (op.op === "replace" && !(leaf in parent)) throw new Error(`对象路径不存在: ${op.path}`);
      parent[leaf] = cloneJson(op.value);
    }
  }
  return root as T;
}

export function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (!isObject(input)) return input;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      if (input[key] !== undefined) out[key] = normalize(input[key]);
    }
    return out;
  };
  return JSON.stringify(normalize(value));
}

export async function sha256Json(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
