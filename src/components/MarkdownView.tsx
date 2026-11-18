import { useMemo } from "react";
import { parseInline, parseMarkdownBlocks } from "../lib/docs.ts";
import { useT } from "../i18n";

/**
 * 全项目共用的 Markdown 子集渲染器：标题 / 列表 / 围栏代码 / `code` / **bold**。
 * 纯 React 元素映射，不使用 innerHTML（文档内容可能来自分享链接，必须避免注入）。
 *
 * 桌面端接口文档、公共章节编辑预览、文档站预览与网页版文档站都由它渲染，
 * 保证四处展示完全一致；样式挂在 `.wb-doc-markdown` 上。
 */
export function MarkdownView({
  text,
  emptyHint,
  className = "",
}: {
  text: string;
  emptyHint?: string;
  className?: string;
}) {
  const t = useT();
  const blocks = useMemo(() => parseMarkdownBlocks(text), [text]);
  if (blocks.length === 0) {
    return <p className="text-xs italic text-ink-faint">{emptyHint ?? t("docs.emptyContent")}</p>;
  }
  return (
    <div className={`wb-doc-markdown ${className}`.trim()}>
      {blocks.map((block, index) => {
        const inline = (value: string) =>
          parseInline(value).map((token, tokenIndex) =>
            token.code ? (
              <code key={tokenIndex}>{token.text}</code>
            ) : token.bold ? (
              <strong key={tokenIndex}>{token.text}</strong>
            ) : (
              <span key={tokenIndex}>{token.text}</span>
            ),
          );
        switch (block.kind) {
          case "h1":
            return <h1 key={index}>{inline(block.text)}</h1>;
          case "h2":
            return <h2 key={index}>{inline(block.text)}</h2>;
          case "h3":
            return <h3 key={index}>{inline(block.text)}</h3>;
          case "li":
            return <li key={index}>{inline(block.text)}</li>;
          case "code":
            return (
              <pre key={index}>
                <code>{block.text}</code>
              </pre>
            );
          default:
            return <p key={index}>{inline(block.text)}</p>;
        }
      })}
    </div>
  );
}
