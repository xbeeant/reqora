import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

const root = createRoot(document.getElementById("root") as HTMLElement);
const docToken = new URLSearchParams(window.location.search).get("doc");

/**
 * 同一个 SPA 的两个入口：
 * - `?doc=<token>`  → 只加载网页版文档站，不触碰桌面端 store / Tauri；
 * - 其他情况        → 加载完整的 Reqora 工作台。
 *
 * 用动态 import 做隔离，是为了让网页版产物里完全不包含桌面端依赖；
 * 公共部分（MarkdownView / DocSiteViewer / ui / index.css / lib 纯函数）
 * 仍然由两条链路共享同一份源码，不会出现两套渲染逻辑。
 */
if (docToken) {
  void import("./DocSiteApp").then(({ DocSiteApp }) => {
    root.render(
      <React.StrictMode>
        <DocSiteApp token={docToken} />
      </React.StrictMode>,
    );
  });
} else {
  void import("./App").then(({ default: App }) => {
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  });
}
