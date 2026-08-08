import { hydrateRoot } from "react-dom/client";
import App from "./App";
import type { HomeProps } from "./pages/Home";
import "./styles/newspaper.css";
import "./styles/auth.css";

// 客户端水合：读取 SSR 注入的初始数据，保证与 SSR 渲染的初始状态一致
// （否则 ?title= 页面 SSR=游戏界面 / 客户端=启动页，hydration 冲突导致事件失效）
declare global {
  interface Window {
    __INITIAL_DATA__?: HomeProps["initialData"];
  }
}

// window 保护：server/dev.ts 会 import 本文件以注册 --hot 监听图（SSR 端无副作用）
if (typeof window !== "undefined") {
  const initialData = window.__INITIAL_DATA__;
  hydrateRoot(
    document.getElementById("root")!,
    <App url={window.location.pathname + window.location.search} initialData={initialData} />,
  );
}
