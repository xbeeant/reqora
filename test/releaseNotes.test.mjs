import test from "node:test";
import assert from "node:assert/strict";

import {
  parseReleaseNotes,
  releaseSectionLabel,
} from "../src/lib/releaseNotes.ts";

const SAMPLE = `# 变更日志

> 说明：这是前言。

---

## [Unreleased]

### Added

- 第一项

## [0.2.0] - 2026-11-10

### Fixed

- 修了一个问题

## 0.1.0 - 2026-11-08

- 首个基线版本

[0.1.0]: https://example.com/releases/v0.1.0
`;

test("按版本标题切分，标题之前的内容作为前言", () => {
  const notes = parseReleaseNotes(SAMPLE);
  assert.equal(notes.sections.length, 3);
  assert.deepEqual(notes.sections.map((item) => item.version), [
    "Unreleased",
    "0.2.0",
    "0.1.0",
  ]);
  assert.match(notes.intro, /变更日志/u);
  assert.match(notes.intro, /这是前言/u);
  assert.ok(!notes.intro.includes("---"), "水平线不应进入渲染文本");
});

test("各段正文互不串台，并清理不可渲染的行", () => {
  const notes = parseReleaseNotes(SAMPLE);
  assert.match(notes.sections[0].body, /第一项/u);
  assert.ok(!notes.sections[0].body.includes("0.2.0"));
  assert.match(notes.sections[1].body, /修了一个问题/u);
  assert.match(notes.sections[2].body, /首个基线版本/u);
  assert.ok(!notes.sections[2].body.includes("example.com"), "链接定义应被过滤");
  assert.ok(!notes.sections[2].body.includes("[0.1.0]:"));
});

test("blockquote 前缀去掉，连续空行压缩", () => {
  const notes = parseReleaseNotes("> 说明：A\n\n\n\n## [0.1.0]\n\n\n- 条目\n");
  assert.equal(notes.intro, "说明：A");
  assert.equal(notes.sections[0].body, "- 条目");
});

test("CRLF 与空文档", () => {
  const notes = parseReleaseNotes("# 变更日志\r\n\r\n## [Unreleased]\r\n\r\n- 条目\r\n");
  assert.equal(notes.sections.length, 1);
  assert.equal(notes.sections[0].body, "- 条目");
  assert.deepEqual(parseReleaseNotes(""), { intro: "", sections: [] });
});

test("版本标签：Unreleased 与带前导 v 的版本", () => {
  assert.equal(releaseSectionLabel("Unreleased"), "未发布变更");
  assert.equal(releaseSectionLabel("unreleased"), "未发布变更");
  assert.equal(releaseSectionLabel("0.1.0"), "v0.1.0");
  assert.equal(releaseSectionLabel("v1.2.3"), "v1.2.3");
});
