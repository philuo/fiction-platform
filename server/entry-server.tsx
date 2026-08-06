import { renderToString } from "react-dom/server";
import App from "../src/App";
import type { HomeProps } from "../src/pages/Home";

// SSR 入口：dev（bun --hot 动态 import）与 prod（bun build 产物）共用
export function render(url: string, initialData?: unknown): string {
  return renderToString(<App url={url} initialData={initialData as HomeProps["initialData"]} />);
}
