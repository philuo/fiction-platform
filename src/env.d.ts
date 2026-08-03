/// <reference types="bun" />

// Bun 支持在客户端入口 side-effect import CSS（bun build 打包），此处提供类型声明
declare module "*.css" {
  const content: string;
  export default content;
}
