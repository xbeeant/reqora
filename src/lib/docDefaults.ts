import type { ParamMeta, RequestDoc } from "../types";

/**
 * 文档渲染链路需要的最小默认值。
 *
 * 刻意不放在 defaults.ts：那个文件会通过 sse.ts → scripts.ts 拖入整套
 * 桌面端专用引擎。网页版文档站（MarkdownView / DocSiteViewer）只需要这两个
 * 纯工厂函数，独立成文件后打包图里不再出现桌面端模块，同时桌面端仍从
 * defaults.ts 拿到完全相同的实现（那里只是委托到这里）。
 */
export function emptyParamMeta(): ParamMeta {
  return { type: "string", required: false, description: "", example: "" };
}

export function emptyDoc(): RequestDoc {
  return {
    summary: "",
    description: "",
    owner: "",
    status: "开发中",
    tags: [],
    paramMeta: {},
    responses: [],
    updatedAt: 0,
  };
}
