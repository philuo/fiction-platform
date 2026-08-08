// 认证相关纯类型（客户端与服务端共用；不含 bun:sqlite 依赖，浏览器 bundle 可安全引用）
export type AuthUser = { id: number; username: string; displayName: string };
