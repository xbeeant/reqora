/**
 * 桌面端场景执行的 setVar 回写契约，以及 MCP 改名回归保护。
 *
 * 编排规则只在 src/lib/scenarioRunner.ts 里实现一份：transport 返回
 * `activeVariables` 才会被 mergeScriptVariables 折叠进后续步骤。这里用注入式
 * mock transport 验证该契约，并用源码断言保证桌面端 transport 真的回传了它。
 * 不引入任何依赖，也不写任何凭据。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readWorkspaceSource } from "./helpers/workspaceSource.mjs";
import test from "node:test";
import { runSteps } from "../src/lib/scenarioRunner.ts";

const source = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

const response = (status = 200) => ({
  requestId: "r",
  status,
  statusText: "OK",
  ok: status < 400,
  timeMs: 1,
  size: 2,
  url: "https://example.test",
  resolvedUrl: "https://example.test",
  missingVariables: [],
  headers: [],
  body: "{}",
  bodyKind: "json",
  truncated: false,
});

const caseItem = {
  id: "case-1",
  requestId: "req-1",
  name: "用例",
  group: "正向",
  enabled: true,
  request: {
    id: "case-req-1",
    name: "用例请求",
    method: "GET",
    url: "https://example.test/base",
    headers: [],
    query: [],
    body: { type: "none" },
    auth: { type: "none" },
    assertions: [],
  },
  syncedAt: 1,
  createdAt: 1,
  updatedAt: 1,
};

const step = (id) => ({
  id,
  name: `步骤 ${id}`,
  enabled: true,
  source: { kind: "case", caseId: "case-1" },
  extracts: [],
  continueOnFailure: false,
});

/** 记录每一步收到的变量表；可切换是否回传 activeVariables。 */
function recorder(withActive) {
  const seen = [];
  const transport = async (_request, variables) => {
    seen.push({ ...variables });
    const base = {
      response: response(),
      timeMs: 1,
      error: null,
      tests: [],
      assertions: [],
    };
    // 模拟脚本 setVar：把新变量并入「最终变量表」回传。
    return withActive
      ? { ...base, activeVariables: { ...variables, fromScript: "yes" } }
      : base;
  };
  return { seen, transport };
}

test("transport 回传 activeVariables 时，脚本变量对后续步骤可见", async () => {
  const { seen, transport } = recorder(true);
  const run = await runSteps([step("s1"), step("s2")], { cases: [caseItem], transport });
  assert.equal(seen.length, 2);
  // 第一步写入的变量被折叠进场景变量表，第二步能看到。
  assert.equal(seen[1].fromScript, "yes");
  assert.equal(run.variables.fromScript, "yes");
});

test("transport 不回传 activeVariables 时脚本变量不会传递（回归保护）", async () => {
  const { seen, transport } = recorder(false);
  const run = await runSteps([step("s1"), step("s2")], { cases: [caseItem], transport });
  assert.equal(seen[1].fromScript, undefined);
  assert.equal(run.variables.fromScript, undefined);
});

test("桌面端 runScenario 的 transport 与 CLI/MCP 一致回传 activeVariables", () => {
  const store = readWorkspaceSource();
  const runner = source("../src/lib/scenarioRunner.ts");
  // PipelineResult 暴露脚本跑完后的完整变量表。
  assert.match(store, /activeVariables:\s*Record<string, string>/);
  // executePipeline 每个出口都带上它，且捕获 post / 全局 post 脚本变量。
  assert.match(store, /activeVariables:\s*variables/);
  assert.match(store, /variables = post\.variables/);
  assert.match(store, /variables = globalPost\?\.variables \?\? variables/);
  // transport 返回值把它映射成 activeVariables（与 bin/reqora.mjs、bin/mcpServer.mjs 同）。
  assert.match(store, /activeVariables:\s*result\.activeVariables/);
  // 编排器只认这一个字段：activeVariables → scriptVariables → mergeScriptVariables。
  assert.match(runner, /scriptVariables:\s*result\.activeVariables/);
  assert.match(runner, /mergeScriptVariables\(/);
});

test("MCP 客户端改名用旧名定位替换，并拒绝与已有名称冲突", () => {
  const modal = source("../src/components/McpModal.tsx");
  // 旧名记在 editing，保存时交给纯函数按旧名定位。
  assert.match(modal, /setEditing\(server\.name\)/);
  assert.match(modal, /upsertMcpServer\(servers, editing, server\)/);
  // 改名撞上别人的名字时返回冲突，不静默覆盖。
  assert.match(modal, /index !== oldIndex && item\.name === next\.name/);
  assert.match(modal, /ok: false, error:/);
  // 旧的「只按新名判重 → map 覆盖 / 追加」逻辑已移除。
  assert.doesNotMatch(modal, /item\.name === server\.name \? server : item/);
});
