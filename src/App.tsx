import Home, { type HomeProps } from "./pages/Home";

// 根组件（SSR/CSR 共用）。CSS 由客户端入口 import（entry-client.tsx），
// SSR 端不加载 CSS —— 页面样式经服务器渲染时引用打包后的 <link>，无 FOUC
export default function App(props: { url?: string; initialData?: HomeProps["initialData"] }) {
  return (
    <main>
      <Home initialData={props.initialData} url={props.url ?? "/"} />
    </main>
  );
}
