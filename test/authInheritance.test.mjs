// 集合级鉴权继承：解析语义、IPC 边界护栏、快照归一化。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readWorkspaceSource } from "./helpers/workspaceSource.mjs";
import {
  NONE_AUTH,
  caseOwnerRequestId,
  collectionAuth,
  findCollectionOfRequest,
  isInheritAuth,
  resolveAuth,
  resolveRequestAuth,
  toWireAuth,
} from "../src/lib/auth.ts";
import { emptySnapshot, normalizeSnapshot } from "../src/lib/defaults.ts";
import { stripForUpload } from "../src/lib/cloudSync.ts";
import { newCaseFromRequest } from "../src/lib/cases.ts";
import {
  resolveStepOwnerRequestId,
  resolveStepRequest,
  stepFromCase,
} from "../src/lib/scenario.ts";

const source = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

const collections = () => [
  {
    id: "c1",
    name: "用户服务",
    auth: { type: "bearer", token: "{{token}}" },
    items: [
      { id: "r1", auth: { type: "inherit" } },
      { id: "r2", auth: { type: "none" } },
      { id: "r3", auth: { type: "apiKey", key: "X-Key", value: "own", location: "header" } },
    ],
  },
  {
    id: "c2",
    name: "无鉴权集合",
    items: [{ id: "r4", auth: { type: "inherit" } }],
  },
];

test("请求级显式鉴权优先，只有 inherit 才回退到集合", () => {
  const list = collections();
  const authOf = (id) => resolveAuth({ id, auth: { type: "inherit" } }, list);
  assert.deepEqual(authOf("r1"), { type: "bearer", token: "{{token}}" });
  assert.deepEqual(authOf("r4"), NONE_AUTH, "集合未配置鉴权 = 无鉴权");
  assert.deepEqual(authOf("missing"), NONE_AUTH, "请求不属于任何集合 = 无鉴权");

  assert.deepEqual(
    resolveAuth({ id: "r1", auth: { type: "none" } }, list),
    { type: "none" },
    "显式「无鉴权」可以覆盖集合",
  );
  assert.deepEqual(
    resolveAuth({ id: "r1", auth: { type: "basic", username: "u", password: "p" } }, list),
    { type: "basic", username: "u", password: "p" },
  );
  assert.deepEqual(resolveAuth({ id: "r1", auth: undefined }, list), NONE_AUTH);
});

test("resolveRequestAuth 返回新对象且绝不修改原请求", () => {
  const list = collections();
  const request = { id: "r1", name: "GET /me", auth: { type: "inherit" } };
  const resolved = resolveRequestAuth(request, list);
  assert.notEqual(resolved, request);
  assert.deepEqual(resolved.auth, { type: "bearer", token: "{{token}}" });
  assert.deepEqual(request.auth, { type: "inherit" }, "原请求保持 inherit 标记");

  const unchanged = resolveRequestAuth(list[0].items[2], list);
  assert.equal(unchanged, list[0].items[2], "非 inherit 时复用同一对象");
});

test("集合不能继承自己；toWireAuth 是 IPC 边界的最后一道闸", () => {
  assert.equal(collectionAuth(undefined), NONE_AUTH);
  assert.equal(
    collectionAuth({ id: "x", name: "x", items: [], auth: { type: "inherit" } }),
    NONE_AUTH,
  );
  assert.deepEqual(toWireAuth({ type: "bearer", token: "t" }), { type: "bearer", token: "t" });
  assert.deepEqual(toWireAuth({ type: "inherit" }), NONE_AUTH);
  assert.deepEqual(toWireAuth(undefined), NONE_AUTH);
  assert.equal(isInheritAuth({ type: "inherit" }), true);
  assert.equal(isInheritAuth({ type: "none" }), false);
  assert.equal(findCollectionOfRequest(collections(), "r3")?.id, "c1");
  assert.equal(findCollectionOfRequest(undefined, "r1"), undefined);
});

test("快照归一化保留集合鉴权，但拒绝集合上的 inherit", () => {
  const raw = {
    ...emptySnapshot(),
    collections: [
      { id: "c1", name: "a", items: [], auth: { type: "bearer", token: "t" } },
      { id: "c2", name: "b", items: [], auth: { type: "inherit" } },
      { id: "c3", name: "c", items: [] },
    ],
  };
  const normalized = normalizeSnapshot(raw);
  assert.deepEqual(normalized.collections[0].auth, { type: "bearer", token: "t" });
  assert.deepEqual(normalized.collections[1].auth, NONE_AUTH);
  assert.deepEqual(normalized.collections[2].auth, NONE_AUTH);
  // 请求级 inherit 必须原样保留，否则继承语义会在加载时被抹掉。
  const withInherit = normalizeSnapshot({
    ...raw,
    collections: [{ id: "c1", name: "a", items: [{ id: "r1", auth: { type: "inherit" } }] }],
  });
  assert.deepEqual(withInherit.collections[0].items[0].auth, { type: "inherit" });
});

test("架构护栏：inherit 绝不进入 Rust，且桌面端与 CLI 都做解析", () => {
  const api = source("../src/lib/api.ts");
  assert.match(api, /return toWireSpec\(request, options\)/, "桌面端必须复用共享 wire contract");
  const wireSpec = source("../src/lib/wireSpec.ts");
  assert.match(wireSpec, /auth: toWireAuth\(request\.auth\)/);
  const store = readWorkspaceSource();
  assert.match(store, /resolveRequestAuth\(\s*request,\s*snapshot\.collections/);
  assert.match(store, /snapshot\.cases,/, "store 必须传入 cases 以自动反查用例副本");
  assert.match(store, /get\(\)\.snapshot, caseItem\.requestId\)/, "runCase 必须回退到原接口 id");
  // 场景步骤的 owner 反查现在只有一份实现（runner），store 必须复用而不是另写一份。
  assert.match(store, /runScenarioEngine\(scenario, \{/, "store 必须复用共享场景运行器");
  assert.doesNotMatch(store, /computeRepeatIterations\(/, "编排语义不允许在 store 里再实现一份");
  // 进程外执行（CLI + MCP）共用 requester.mjs / scenarioRunner.ts 做同一份解析。
  const requester = source("../bin/requester.mjs");
  assert.match(requester, /resolveRequestAuth\(request, collections, ownerRequestId, cases\)/);
  const runner = source("../src/lib/scenarioRunner.ts");
  assert.match(runner, /resolveStepOwnerRequestId\(step, options\.cases\)/);
  // 用例 tab 里的 draft 是带新 id 的副本：复制代码 / 模板预览也必须传 cases。
  const responseViewer = source("../src/components/ResponseViewer.tsx");
  assert.match(
    responseViewer,
    /resolveRequestAuth\(draft, collections, undefined, allCases\)/,
    "域级 selector 收窄后仍必须传入 cases 以反查用例副本",
  );
  const codeTemplateModal = source("../src/components/CodeTemplateModal.tsx");
  assert.match(
    codeTemplateModal,
    /resolveRequestAuth\(draft, collections, undefined, cases\)/,
  );
  // Rust 侧仍是四个具体变体，没有 inherit —— 前端解析是唯一入口。
  const models = source("../src-tauri/crates/reqora-core/src/models.rs");
  const authEnum = models.match(/pub enum AuthSpec \{[\s\S]*?\n\}/);
  assert.ok(authEnum, "找不到 Rust AuthSpec 枚举定义");
  assert.ok(!/Inherit/.test(authEnum[0]), "Rust AuthSpec 不应新增 inherit 变体");
});

const interfaceWithInherit = () => ({
  id: "r1",
  name: "GET /me",
  method: "GET",
  url: "{{baseUrl}}/me",
  headers: [],
  query: [],
  body: { type: "none" },
  auth: { type: "inherit" },
});

test("回归：用例副本带新 id，仍能继承原接口所属集合的鉴权", () => {
  const list = collections();
  const caseItem = newCaseFromRequest(interfaceWithInherit());
  assert.notEqual(caseItem.request.id, "r1", "用例保存的是带新 id 的副本");
  assert.equal(caseItem.requestId, "r1");
  assert.deepEqual(caseItem.request.auth, { type: "inherit" });

  // 不带任何上下文 = 旧的静默降级行为，正是本回归。
  assert.deepEqual(resolveRequestAuth(caseItem.request, list).auth, NONE_AUTH);

  // 显式 ownerRequestId（runCase 走这条）。
  assert.deepEqual(
    resolveRequestAuth(caseItem.request, list, caseItem.requestId).auth,
    { type: "bearer", token: "{{token}}" },
  );
  // 自动推断（用例 tab 下的 send / 压测 / 内省 / WebSocket 走这条）。
  assert.deepEqual(
    resolveRequestAuth(caseItem.request, list, undefined, [caseItem]).auth,
    { type: "bearer", token: "{{token}}" },
  );
  assert.equal(caseOwnerRequestId(caseItem.request, [caseItem]), "r1");
  assert.equal(caseOwnerRequestId(caseItem.request, []), undefined);
  assert.deepEqual(caseItem.request.auth, { type: "inherit" }, "解析不得写回用例快照");

  // 用例显式改成自己的鉴权时，集合不再生效。
  const explicit = { ...caseItem.request, auth: { type: "none" } };
  assert.deepEqual(
    resolveRequestAuth(explicit, list, caseItem.requestId, [caseItem]).auth,
    { type: "none" },
  );
});

test("场景引用用例的步骤跟随集合鉴权，且 inline 步骤不需要 owner id", () => {
  const list = collections();
  const caseItem = newCaseFromRequest(interfaceWithInherit());
  const step = stepFromCase(caseItem);
  const request = resolveStepRequest(step, [caseItem]);
  assert.ok(request);
  assert.equal(request.id, caseItem.request.id);
  assert.equal(resolveStepOwnerRequestId(step, [caseItem]), "r1");
  assert.equal(resolveStepOwnerRequestId(step, []), undefined, "悬空引用不猜集合");

  const changed = list.map((collection) =>
    collection.id === "c1"
      ? { ...collection, auth: { type: "apiKey", key: "X-New", value: "v2", location: "header" } }
      : collection,
  );
  assert.deepEqual(
    resolveRequestAuth(request, changed, resolveStepOwnerRequestId(step, [caseItem])).auth,
    { type: "apiKey", key: "X-New", value: "v2", location: "header" },
    "修改集合鉴权后，已有用例 / 场景步骤立即生效",
  );

  const inline = {
    id: "s2",
    name: "inline",
    enabled: true,
    source: { kind: "inline", request: { ...interfaceWithInherit() } },
    extracts: [],
    continueOnFailure: false,
  };
  assert.equal(resolveStepOwnerRequestId(inline, [caseItem]), undefined);
  assert.deepEqual(resolveRequestAuth(inline.source.request, list).auth, {
    type: "bearer",
    token: "{{token}}",
  });
  assert.equal(resolveStepOwnerRequestId({ source: { kind: "wait", ms: 1 } }, [caseItem]), undefined);
  assert.equal(resolveStepOwnerRequestId({ source: { kind: "db", db: {} } }, [caseItem]), undefined);
});

test("集合级鉴权同样参与上传脱敏", () => {
  const snapshot = {
    ...emptySnapshot(),
    collections: [
      {
        id: "c1",
        name: "a",
        auth: { type: "bearer", token: "collection-live-token" },
        items: [{ id: "r1", auth: { type: "inherit" } }],
      },
    ],
  };
  const payload = stripForUpload(snapshot);
  assert.equal(payload.collections[0].auth.token, "");
  assert.deepEqual(payload.collections[0].items[0].auth, { type: "inherit" });
  assert.ok(!JSON.stringify(payload).includes("collection-live-token"));
  assert.equal(snapshot.collections[0].auth.token, "collection-live-token", "本地不受影响");
});
