// 行级双向同步：协作空间必须显式绑定，绝不静默自动创建或随便挑一个可写空间。
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerDict, t } from "../src/i18n/index.ts";
import { zh as cloudZh } from "../src/i18n/ns/cloud.ts";

registerDict("zh", cloudZh);
import { readWorkspaceSource } from "./helpers/workspaceSource.mjs";
import {
  CloudError,
  clearCloudSession,
  cloudLogin,
  cloudProjectSlugFor,
  configureCloud,
  ensureCloudProject,
} from "../src/lib/cloud.ts";
import {
  clearSyncBaseline,
  clearSyncConflicts,
  loadSyncBaseline,
  loadSyncConflicts,
  saveSyncBaseline,
  saveSyncConflicts,
} from "../src/lib/cloudSync.ts";
import { threeWayMerge } from "../src/lib/workspaceRows.ts";
import {
  cloudProjectFor,
  resetCloudConnection,
  setCloudProjectFor,
} from "../src/lib/cloudConnection.ts";

const emptyRows = () => ({
  folders: [], requests: [], environments: [], cases: [],
  scenarios: [], suites: [], artifacts: [],
});

const rowsWith = (domain, ...rows) => ({
  ...emptyRows(),
  [domain]: rows,
});

const ok = (data) =>
  new Response(JSON.stringify({ code: 0, message: "ok", data, requestId: "rid" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const fail = (status, code, message = "") =>
  new Response(JSON.stringify({ code, message, data: null, requestId: "rid" }), {
    status,
    headers: { "content-type": "application/json" },
  });

const tokens = () => ({
  accessToken: "a1",
  refreshToken: "r1",
  tokenType: "Bearer",
  expiresIn: 900,
  user: { id: 1, username: "alice", displayName: "Alice" },
});

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
}

const originalFetch = globalThis.fetch;
let calls = [];
let handler = () => ok(null);

beforeEach(() => {
  globalThis.localStorage = fakeStorage();
  resetCloudConnection();
  clearCloudSession();
  configureCloud("http://cloud.test");
  calls = [];
  handler = () => ok(null);
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearCloudSession();
});

async function login() {
  const previous = handler;
  handler = () => ok(tokens());
  await cloudLogin("alice", "pw");
  handler = previous;
  calls = [];
}

test("未绑定的本地项目返回 null，绝不自动创建协作空间", async () => {
  await login();
  handler = (url) => {
    if (url.endsWith("/api/v1/projects?size=100")) {
      return ok({ records: [], total: 0, page: 1, size: 100 });
    }
    if (url.endsWith("/api/v1/projects")) {
      throw new Error("不应自动创建协作空间");
    }
    return ok(null);
  };
  const target = await ensureCloudProject("default");
  assert.equal(target, null, "未绑定时应返回 null，由 UI 弹出选择框");
  assert.ok(!calls.some((call) => call.url.endsWith("/api/v1/projects")), "不应有创建请求");
  assert.equal(cloudProjectFor("default"), null);
  assert.ok(!calls.some((call) => call.url.endsWith("/workspace")), "绝不读取远端快照");
});

test("已绑定时复用缓存目标，只做一次 head 存活校验", async () => {
  await login();
  let heads = 0;
  handler = (url) => {
    if (url.endsWith("/workspace/head")) {
      heads += 1;
      return ok({ projectId: 9, version: 2, checksum: "", updatedAt: null });
    }
    return ok(null);
  };
  setCloudProjectFor("default", { id: 9, name: "团队空间", slug: "team-space" });
  const target = await ensureCloudProject("default");
  assert.equal(target.id, 9);
  assert.equal(target.reused, true);
  assert.equal(target.created, false);
  assert.equal(heads, 1);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/workspace/head"));
});

test("绑定的协作空间已被删除时解除绑定并返回 null，由用户重新选择", async () => {
  await login();
  handler = (url) => {
    if (url.endsWith("/workspace/head")) return fail(404, 1004, "项目不存在");
    return ok(null);
  };
  setCloudProjectFor("default", { id: 6, name: "旧空间", slug: "old-space" });
  const target = await ensureCloudProject("default");
  assert.equal(target, null);
  assert.equal(cloudProjectFor("default"), null, "失效绑定必须被清除");
  assert.ok(
    calls.every((call) => call.url.endsWith("/workspace/head")),
    "只应做存活校验，不应重新解析或创建协作空间",
  );
});

test("后端离线时保留缓存绑定并给出离线提示，不改动本地映射", async () => {
  await login();
  setCloudProjectFor("default", { id: 8, name: "空间", slug: "space" });
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(
    () => ensureCloudProject("default"),
    (error) => error instanceof CloudError && error.message === t("cloud.offline"),
  );
  assert.ok(cloudProjectFor("default"), "离线绝不能清掉绑定");
});

test("cloudProjectSlugFor 生成确定性的建议 slug（仅作预填参考）", () => {
  assert.equal(cloudProjectSlugFor("default"), "reqora-default");
  assert.equal(cloudProjectSlugFor("My Project #1"), "reqora-my-project-1");
});

test("三方合并：仅本地变 → 上传；仅云端变 → 下载；无基线退化为 LWW 不报冲突", () => {
  const baseline = rowsWith(
    "requests",
    { id: "r1", name: "same", updatedAt: 10 },
    { id: "r2", name: "base2", updatedAt: 10 },
  );
  const local = rowsWith(
    "requests",
    { id: "r1", name: "same", updatedAt: 10 },
    { id: "r2", name: "local-edit", updatedAt: 20 },
    { id: "r3", name: "new-local", updatedAt: 30 },
  );
  const remote = rowsWith(
    "requests",
    { id: "r1", name: "remote-edit", updatedAt: 25 },
    { id: "r2", name: "base2", updatedAt: 10 },
    { id: "r4", name: "new-remote", updatedAt: 15 },
  );

  const outcome = threeWayMerge(local, remote, baseline);
  // 仅云端变：r1 采用云端；仅本地变：r2 保留本地并上传；本地新建 r3 上传。
  const uploaded = outcome.localChanges.requests.map((row) => row.id).sort();
  assert.deepEqual(uploaded, ["r2", "r3"], "仅本地变更的行应上传");
  const r1 = outcome.remote.requests.find((row) => row.id === "r1");
  assert.equal(r1.name, "remote-edit", "仅云端变更的行应下载");
  const r2 = outcome.remote.requests.find((row) => row.id === "r2");
  assert.equal(r2.name, "local-edit", "本地变更不被云端旧版本覆盖");
  assert.equal(outcome.conflicts.length, 0, "无双改时不应报冲突");

  // 无基线：退化为 LWW，不产生冲突（第一轮同步的目的是建立基线）。
  const cold = threeWayMerge(local, remote, null);
  assert.equal(cold.conflicts.length, 0);
  const coldR1 = cold.remote.requests.find((row) => row.id === "r1");
  assert.equal(coldR1.name, "remote-edit", "云端更新时 LWW 采用云端");
  const coldR2 = cold.remote.requests.find((row) => row.id === "r2");
  assert.equal(coldR2.name, "local-edit", "本地更新时 LWW 保留本地");
});

test("三方合并：双方都改 → 冲突，保留本地版本且不上传；挂起冲突行继续跳过", () => {
  const baseline = rowsWith("requests", { id: "r1", name: "base", updatedAt: 10 });
  const local = rowsWith("requests", { id: "r1", name: "local-edit", updatedAt: 20 });
  const remote = rowsWith("requests", { id: "r1", name: "remote-edit", updatedAt: 25 });

  const outcome = threeWayMerge(local, remote, baseline);
  assert.equal(outcome.conflicts.length, 1, "双改必须检出为冲突");
  assert.deepEqual(outcome.conflicts[0], {
    domain: "requests",
    id: "r1",
    name: "remote-edit",
    base: { id: "r1", name: "base", updatedAt: 10 },
    local: { id: "r1", name: "local-edit", updatedAt: 20 },
    remote: { id: "r1", name: "remote-edit", updatedAt: 25 },
  });
  const kept = outcome.remote.requests.find((row) => row.id === "r1");
  assert.equal(kept.name, "local-edit", "冲突时本地版本不能被云端覆盖");
  assert.equal(
    outcome.localChanges.requests.length,
    0,
    "冲突行绝不自动上传",
  );

  // 挂起中的冲突行：保留本地、不上传、不重复报告。
  const pending = threeWayMerge(local, remote, baseline, {
    skipIds: new Set(["requests:r1"]),
  });
  assert.equal(pending.conflicts.length, 0, "挂起行不重复报告");
  assert.equal(pending.localChanges.requests.length, 0, "挂起行不上传");
  const pendingKept = pending.remote.requests.find((row) => row.id === "r1");
  assert.equal(pendingKept.name, "local-edit", "挂起行保留本地版本");
});

test("三方合并：删除语义收敛，服务端硬删对本地活行报冲突", () => {
  const base = { id: "r1", name: "base", updatedAt: 10 };
  const tombstone = { id: "r1", name: "", updatedAt: 20, deleted: true };

  // 本地墓碑 vs 云端未变 → 删除传播（上传墓碑）。
  const deletion = threeWayMerge(
    rowsWith("requests", tombstone),
    rowsWith("requests", base),
    rowsWith("requests", base),
  );
  assert.equal(deletion.conflicts.length, 0);
  assert.equal(deletion.localChanges.requests.length, 1, "墓碑应上传以传播删除");
  assert.equal(deletion.remote.requests.find((row) => row.id === "r1").deleted, true);

  // 本地墓碑 vs 服务端已无该行（硬删）→ 收敛，丢弃墓碑不上传。
  const converged = threeWayMerge(
    rowsWith("requests", tombstone),
    emptyRows(),
    rowsWith("requests", base),
  );
  assert.equal(converged.conflicts.length, 0);
  assert.equal(converged.localChanges.requests.length, 0, "收敛的删除不上传");
  assert.equal(converged.remote.requests.length, 0);

  // 本地活行未变 vs 服务端硬删该行 → 冲突（云端侧=删除），保留本地待裁决。
  const hardDeleted = threeWayMerge(
    rowsWith("requests", base),
    emptyRows(),
    rowsWith("requests", base),
  );
  assert.equal(hardDeleted.conflicts.length, 1, "服务端硬删活行应提醒");
  assert.equal(hardDeleted.conflicts[0].remote, null);
  assert.equal(hardDeleted.remote.requests.find((row) => row.id === "r1").name, "base");

  // 云端新建行 → 直接并入本地。
  const added = threeWayMerge(
    emptyRows(),
    rowsWith("requests", { id: "r9", name: "from-cloud", updatedAt: 5 }),
    emptyRows(),
  );
  assert.equal(added.conflicts.length, 0);
  assert.equal(added.remote.requests[0].name, "from-cloud");
});

test("同步基线与冲突记录：按本地项目存取，换空间即失效", async () => {
  await saveSyncBaseline("p1", 7, rowsWith("requests", { id: "r1", updatedAt: 1 }));
  assert.equal((await loadSyncBaseline("p1")).cloudProjectId, 7);
  assert.equal((await loadSyncBaseline("p1")).rows.requests.length, 1);
  assert.equal(await loadSyncBaseline("p2"), null, "其他项目无基线");

  await clearSyncBaseline("p1");
  assert.equal(await loadSyncBaseline("p1"), null);

  await saveSyncConflicts("p1", 7, [
    {
      domain: "requests",
      id: "r1",
      name: "n",
      base: null,
      local: {},
      remote: {},
    },
  ]);
  const record = await loadSyncConflicts("p1");
  assert.equal(record.cloudProjectId, 7);
  assert.equal(record.entries.length, 1);
  assert.equal(record.entries[0].base, null);
  await clearSyncConflicts("p1");
  assert.equal(await loadSyncConflicts("p1"), null);
});

test("架构护栏：store 走行级双向同步，不存在任何整快照写回路径", () => {
  const source = readWorkspaceSource();
  for (const forbidden of [
    "cloudGetWorkspace",
    "cloudPutWorkspace",
    "cloudSubscribeWorkspace",
    "mergeSnapshots",
    "cloudPullWorkspace",
    "cloudRestore",
    "startRealtime",
    "handleRemoteVersion",
  ]) {
    assert.ok(!source.includes(forbidden), `store 不应再包含 ${forbidden}`);
  }
  assert.ok(source.includes("cloudImport"), "必须保留同步 action（沿用 cloudImport 名称）");
  assert.ok(source.includes("stripForUpload"), "上传前必须剔除本地专属数据并脱敏");
  assert.ok(source.includes("snapshotToRows"), "必须把本地快照拆成行参与比对");
  assert.ok(
    source.includes("threeWayMerge") && source.includes("loadSyncBaseline"),
    "必须走基线三方合并（冲突可检出），不得退回无基线的静默 LWW",
  );
  assert.ok(source.includes("rowsToSnapshot"), "必须用服务端合并结果重建本地共享域");
});

test("架构护栏：同步目标必须显式绑定，不存在静默自动创建或回退路径", () => {
  const source = readWorkspaceSource();
  assert.ok(
    source.includes("cloudPickerOpen"),
    "未绑定时必须弹出协作空间选择框",
  );
  assert.ok(
    source.includes("cloudBindSpace"),
    "必须保留显式绑定 action",
  );
  assert.ok(
    source.includes("cloudCreateAndBindSpace"),
    "必须保留「新建并绑定」action",
  );
  assert.ok(
    !/ensureCloudProject\([^)]*,/.test(source),
    "ensureCloudProject 只接收本地项目 id，不应再传名称触发自动创建",
  );
  assert.ok(
    !source.includes("shouldDownloadOnBind"),
    "换绑行为已由显式流程取代：绑定动作里不得再做自动方向判定",
  );
  assert.ok(
    source.includes("downloadOnly"),
    "cloudImport 必须支持仅下载分支（GET 行集 + 不 POST），供显式拉取流程使用",
  );
  assert.ok(
    source.includes("saveSyncConflicts") && source.includes("saveSyncBaseline"),
    "同步成功后必须落基线并持久化冲突记录",
  );
  assert.ok(
    source.includes("renameProject"),
    "空默认项目绑定空间 / 拉取项目时必须把本地项目重命名为协作空间名",
  );
});

test("架构护栏：导入的上传载荷不含云端连接配置与本地凭据", async () => {
  const { stripForUpload } = await import("../src/lib/cloudSync.ts");
  const { emptySnapshot } = await import("../src/lib/defaults.ts");
  const snapshot = {
    ...emptySnapshot(),
    settings: {
      ...emptySnapshot().settings,
      cloudBaseUrl: "http://127.0.0.1:8080",
      cloudProjectId: "7",
      aiApiKey: "sk-secret",
    },
  };
  const payload = stripForUpload(snapshot);
  assert.equal(payload.settings.cloudBaseUrl, undefined);
  assert.equal(payload.settings.cloudProjectId, undefined);
  assert.equal(payload.settings.aiApiKey, undefined);
  assert.deepEqual(payload.history, []);
  assert.deepEqual(payload.trash, []);
});
