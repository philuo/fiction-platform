// per-title 互斥锁（共享模块）：串行化 load→修改→save 的操作，防止并发下基于旧快照覆盖。
// 原为 routes.ts 内部实现；提取为公共模块后 autorun（ReviewFailed 债务落盘）、state 读时自愈等
// 非路由写点也能复用同一把锁，保证所有写路径互斥一致。
// key 统一归一化为 slug(title)：调用方无论传原始书名还是 slug 都映射到同一把锁（防 routes 传 slug、
// autorun 传 title 导致锁不互斥）。key 前缀当前用户：不同账号的同名书互不串锁。
import { slugify, currentUser } from "./storage";

const titleLocks = new Map<string, Promise<unknown>>();

export function withTitleLock<T>(title: string, fn: () => Promise<T>): Promise<T> {
  const key = `${currentUser() ?? ""}::${slugify(title)}`;
  const prev = titleLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const guard = run.then(
    () => undefined,
    () => undefined,
  );
  titleLocks.set(key, guard);
  return run.finally(() => {
    if (titleLocks.get(key) === guard) titleLocks.delete(key);
  });
}
