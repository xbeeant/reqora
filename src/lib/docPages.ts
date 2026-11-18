import type { DocPage, DocPageGroup, ErrorCodeRow } from "../types";
import { uid } from "./id.ts";

/**
 * 公共文档章节的纯逻辑层。刻意不依赖 defaults.ts / store，
 * 这样桌面端、单文件导出、网页版（拉取服务端 payload）都能直接复用。
 */

export const DOC_PAGE_GROUPS: { id: DocPageGroup; label: string }[] = [
  { id: "guide", label: "指南" },
  { id: "reference", label: "参考" },
  { id: "changelog", label: "更新日志" },
];

export function docPageGroupLabel(group: string): string {
  return DOC_PAGE_GROUPS.find((item) => item.id === group)?.label ?? "指南";
}

/** 生成 URL 锚点：中文保留，空白转连字符，去掉浏览器不友好的字符。 */
export function slugifyDocTitle(title: string, fallback = ""): string {
  const cleaned = (title ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^\p{L}\p{N}-]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || fallback || "section";
}

export function newErrorCodeRow(): ErrorCodeRow {
  return { id: uid(), code: "", httpStatus: "", message: "", description: "", solution: "" };
}

export function newDocPage(title = "新章节", group: DocPageGroup = "guide"): DocPage {
  return {
    id: uid(),
    title,
    slug: slugifyDocTitle(title, uid().slice(0, 8)),
    group,
    body: "",
    errorCodes: [],
  };
}

function normalizeErrorCode(raw: unknown): ErrorCodeRow | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const str = (value: unknown) => (typeof value === "string" ? value : "");
  return {
    id: str(item.id) || uid(),
    code: str(item.code),
    httpStatus: str(item.httpStatus),
    message: str(item.message),
    description: str(item.description),
    solution: str(item.solution),
  };
}

/** 兼容旧快照、云拉取数据与公开 payload 里的任意形状。 */
export function normalizeDocPages(raw: unknown): DocPage[] {
  if (!Array.isArray(raw)) return [];
  const used = new Set<string>();
  return raw
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .map((entry) => {
      const title = typeof entry.title === "string" ? entry.title : "未命名章节";
      const group: DocPageGroup =
        entry.group === "reference" || entry.group === "changelog" ? entry.group : "guide";
      const preferred = typeof entry.slug === "string" && entry.slug.trim() ? entry.slug : title;
      let slug = slugifyDocTitle(preferred, "section");
      if (used.has(slug)) slug = `${slug}-${used.size + 1}`;
      used.add(slug);
      const errorCodes = Array.isArray(entry.errorCodes)
        ? entry.errorCodes
            .map(normalizeErrorCode)
            .filter((row): row is ErrorCodeRow => row !== null)
        : [];
      return {
        id: typeof entry.id === "string" && entry.id ? entry.id : uid(),
        title,
        slug,
        group,
        body: typeof entry.body === "string" ? entry.body : "",
        errorCodes,
      };
    });
}

/** 上移 / 下移，返回新数组；越界时原样返回。 */
export function moveDocPage(pages: DocPage[], id: string, delta: -1 | 1): DocPage[] {
  const from = pages.findIndex((page) => page.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= pages.length) return pages;
  const next = [...pages];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

export const DOC_SITE_ERROR_CODE_COLUMNS = [
  "错误码",
  "HTTP",
  "说明",
  "描述",
  "处理建议",
] as const;

export function errorCodeRowsForTable(page: DocPage): string[][] {
  return (page.errorCodes ?? [])
    .filter((row) => row.code.trim() || row.message.trim() || row.description.trim())
    .map((row) => [
      row.code,
      row.httpStatus,
      row.message,
      row.description,
      row.solution,
    ]);
}

/** Markdown 导出用：把公共章节渲染成前置正文。 */
export function docPagesToMarkdown(pages: DocPage[], heading = "#"): string {
  const out: string[] = [];
  for (const page of normalizeDocPages(pages)) {
    out.push(`${heading} ${page.title}`, "");
    if (page.body.trim()) out.push(page.body.trim(), "");
    const rows = errorCodeRowsForTable(page);
    if (rows.length > 0) {
      out.push("| 错误码 | HTTP | 说明 | 描述 | 处理建议 |");
      out.push("| --- | --- | --- | --- | --- |");
      for (const row of rows) {
        out.push(`| ${row.map((cell) => cell.replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`);
      }
      out.push("");
    }
  }
  return out.join("\n");
}

/**
 * 首次启动写入示例工作区的骨架章节。用户可自由编辑或删除；
 * 内容只讲结构与占位，不假设任何真实业务域名或凭据。
 */
export function builtinDocPages(): DocPage[] {
  return [
    {
      id: uid(),
      title: "快速开始",
      slug: "quickstart",
      group: "guide",
      body: [
        "## 环境地址",
        "",
        "所有接口使用 `{{baseUrl}}` 作为基础地址，按环境切换：",
        "",
        "- 开发环境：本地或内网网关",
        "- 生产环境：由运维统一分配",
        "",
        "## 第一个请求",
        "",
        "选择左侧任意接口，查看方法、URL、参数表与响应示例。",
        "在 Reqora 桌面端可直接点击「发送」调试；网页版仅供阅读。",
        "",
        "> 变量语法为 `{{name}}`，在导出时按当前环境展开。",
      ].join("\n"),
      errorCodes: [],
    },
    {
      id: uid(),
      title: "接口鉴权",
      slug: "auth",
      group: "guide",
      body: [
        "## 认证方式",
        "",
        "除登录接口外，所有请求需携带访问令牌：",
        "",
        "```http",
        "Authorization: Bearer <access_token>",
        "```",
        "",
        "## 获取令牌",
        "",
        "1. 调用登录接口，传入账号与口令",
        "2. 从响应中取出 `accessToken` 与 `refreshToken`",
        "3. 访问令牌过期前用刷新令牌轮换，避免重复登录",
        "",
        "## 安全约定",
        "",
        "- 令牌只放在请求头，**不要**放在 URL 查询参数里",
        "- 服务端仅保存令牌摘要，日志不记录明文",
        "- 环境与全局 Header 在 Reqora 中统一维护，不要写死在接口里",
      ].join("\n"),
      errorCodes: [],
    },
    {
      id: uid(),
      title: "业务流程",
      slug: "flow",
      group: "guide",
      body: [
        "## 典型调用链",
        "",
        "1. 初始化：读取配置与版本信息",
        "2. 鉴权：登录并保存令牌",
        "3. 业务：按下方接口列表依次调用",
        "4. 收尾：必要时主动注销令牌",
        "",
        "## 幂等与重试",
        "",
        "写操作建议携带幂等键；网络超时可重试，但需先确认服务端是否已受理。",
        "具体重试策略以各接口说明为准。",
      ].join("\n"),
      errorCodes: [],
    },
    {
      id: uid(),
      title: "错误码",
      slug: "errors",
      group: "reference",
      body: [
        "## 统一响应结构",
        "",
        "```json",
        "{ \"code\": 0, \"message\": \"ok\", \"data\": {} }",
        "```",
        "",
        "`code` 为 0 表示成功；非 0 时按下方表格排查，HTTP 状态码仅表达传输层语义。",
      ].join("\n"),
      errorCodes: [
        {
          id: uid(),
          code: "0",
          httpStatus: "200",
          message: "ok",
          description: "请求成功",
          solution: "无需处理",
        },
        {
          id: uid(),
          code: "1002",
          httpStatus: "401",
          message: "未登录或登录已失效",
          description: "访问令牌缺失、过期或被撤销",
          solution: "用刷新令牌换取新的访问令牌，仍失败则重新登录",
        },
        {
          id: uid(),
          code: "1003",
          httpStatus: "403",
          message: "没有权限执行此操作",
          description: "当前角色不具备该能力",
          solution: "联系项目管理员调整成员角色",
        },
      ],
    },
  ];
}
