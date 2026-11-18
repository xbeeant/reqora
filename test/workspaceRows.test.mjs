// 统一行模型：快照拆行 / 行重组 / 行级合并（updatedAt 胜出 + 凭据回填）。
import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeRows,
  restoreRowCredentials,
  restoreRowsCredentials,
  rowsToSnapshot,
  snapshotToRows,
} from "../src/lib/workspaceRows.ts";

function sampleSnapshot() {
  return {
    version: 1,
    seeded: true,
    collections: [
      {
        id: "c1",
        name: "用户服务",
        auth: { type: "bearer", token: "local-token" },
        updatedAt: 100,
        items: [
          {
            id: "r1",
            folder: "auth",
            name: "登录",
            method: "POST",
            url: "{{baseUrl}}/login",
            protocol: "http",
            updatedAt: 111,
            headers: [{ id: "h1", key: "X", value: "1", enabled: true }],
            auth: { type: "inherit" },
          },
        ],
      },
    ],
    environments: [
      { id: "e1", name: "测试", variables: [{ key: "baseUrl", value: "http://t" }], updatedAt: 5 },
    ],
    activeEnvironmentId: "e1",
    cases: [
      {
        id: "k1",
        requestId: "r1",
        name: "正向",
        group: "正向",
        enabled: true,
        request: { id: "r1-copy" },
        updatedAt: 333,
      },
    ],
    scenarios: [],
    suites: [],
    docPages: [],
    dataModels: [],
    scriptLibrary: [],
    codeTemplates: [],
    history: [{ id: "h9", at: 1 }],
    trash: [],
    settings: { timeoutSecs: 30, followRedirects: true, verifyTls: true },
  };
}

test("snapshotToRows 把集合拆成 folder + request 行，标量列独立", () => {
  const rows = snapshotToRows(sampleSnapshot());
  assert.equal(rows.folders.length, 1);
  assert.equal(rows.folders[0].id, "c1");
  assert.equal(rows.folders[0].name, "用户服务");
  assert.equal(rows.folders[0].auth.token, "local-token");
  assert.equal(rows.folders[0].position, 0);
  assert.equal(rows.folders[0].updatedAt, 100);

  assert.equal(rows.requests.length, 1);
  const request = rows.requests[0];
  assert.equal(request.id, "r1");
  assert.equal(request.folderId, "c1");
  assert.equal(request.folderPath, "auth");
  assert.equal(request.method, "POST");
  assert.equal(request.url, "{{baseUrl}}/login");
  assert.equal(request.protocol, "http");
  assert.equal(request.position, 0);
  // headers / auth 等剩余结构留在 data payload 中，不重复出现在列上。
  assert.deepEqual(request.data.headers, [{ id: "h1", key: "X", value: "1", enabled: true }]);
  assert.equal(request.data.auth.type, "inherit");
  assert.equal(request.data.id, undefined);
  assert.equal(request.data.method, undefined);

  assert.equal(rows.cases.length, 1);
  assert.equal(rows.cases[0].requestId, "r1");
  assert.equal(rows.cases[0].caseGroup, "正向");
  assert.equal(rows.cases[0].enabled, true);
  assert.deepEqual(rows.cases[0].data.request, { id: "r1-copy" });

  assert.equal(rows.environments.length, 1);
  assert.equal(rows.meta.activeEnvironmentId, "e1");
  assert.equal(rows.meta.seeded, true);
});

test("rowsToSnapshot 重组后与原共享域等价（本机域保持 base 不变）", () => {
  const snapshot = sampleSnapshot();
  const rows = snapshotToRows(snapshot);
  const rebuilt = rowsToSnapshot(rows, snapshot);

  assert.deepEqual(rebuilt.collections, snapshot.collections);
  assert.deepEqual(rebuilt.environments, snapshot.environments);
  assert.deepEqual(rebuilt.cases, snapshot.cases);
  assert.equal(rebuilt.activeEnvironmentId, "e1");
  assert.equal(rebuilt.seeded, true);
  // 本机域：来自 base，不进行协议。
  assert.deepEqual(rebuilt.history, snapshot.history);
  assert.deepEqual(rebuilt.trash, []);
  assert.deepEqual(rebuilt.settings, snapshot.settings);
});

test("mergeRows：远端更新的行胜出，且凭据空位回填本地真实值", () => {
  const local = snapshotToRows(sampleSnapshot());
  // 模拟另一个协作者在 999 更新了同一接口（凭据已被置空）。
  const remote = {
    folders: [
      {
        id: "c1",
        name: "用户服务",
        auth: { type: "bearer", token: "" },
        position: 0,
        updatedAt: 999,
      },
    ],
    requests: [
      {
        id: "r1",
        folderId: "c1",
        folderPath: "auth",
        name: "登录",
        method: "PUT",
        url: "{{baseUrl}}/login",
        protocol: "http",
        position: 0,
        updatedAt: 999,
        data: { headers: [{ id: "h2", key: "Y", value: "2", enabled: true }] },
      },
    ],
    environments: [],
    cases: [],
    scenarios: [],
    suites: [],
    artifacts: [],
    meta: {},
  };

  const outcome = mergeRows(local, remote);
  // 本地无更新：localChanges 为空。
  assert.equal(outcome.localChanges.requests.length, 0);
  assert.equal(outcome.localChanges.folders.length, 0);
  // 远端获胜行进入合并结果，凭据空位回填本地 token。
  const mergedFolder = outcome.remote.folders[0];
  assert.equal(mergedFolder.updatedAt, 999);
  assert.equal(mergedFolder.auth.token, "local-token");
  const mergedRequest = outcome.remote.requests[0];
  assert.equal(mergedRequest.method, "PUT");
  assert.deepEqual(mergedRequest.data.headers, [
    { id: "h2", key: "Y", value: "2", enabled: true },
  ]);
});

test("mergeRows：本地更新的行进入 localChanges 待上传；本地独有行也上传", () => {
  const local = snapshotToRows(sampleSnapshot());
  local.requests[0].updatedAt = 500; // 本地比远端新
  const remote = {
    folders: [],
    requests: [
      {
        id: "r1",
        folderId: "c1",
        folderPath: "auth",
        name: "登录",
        method: "POST",
        url: "{{baseUrl}}/login",
        protocol: "http",
        position: 0,
        updatedAt: 111,
        data: {},
      },
    ],
    environments: [],
    cases: [],
    scenarios: [],
    suites: [],
    artifacts: [],
    meta: {},
  };

  const outcome = mergeRows(local, remote);
  assert.equal(outcome.localChanges.requests.length, 1);
  assert.equal(outcome.localChanges.requests[0].updatedAt, 500);
  // 本地独有（远端没有的 id）也要上传——新建的集合行。
  assert.equal(outcome.localChanges.folders.length, 1);
});

test("mergeRows：远端软删墓碑传播删除，被删行不再回传", () => {
  const local = snapshotToRows(sampleSnapshot());
  const remote = {
    folders: [],
    requests: [
      {
        id: "r1",
        folderId: "c1",
        folderPath: "auth",
        name: "登录",
        method: "POST",
        url: "",
        protocol: "http",
        position: 0,
        updatedAt: 2000,
        deleted: true,
        data: {},
      },
    ],
    environments: [],
    cases: [],
    scenarios: [],
    suites: [],
    artifacts: [],
    meta: {},
  };

  const outcome = mergeRows(local, remote);
  assert.deepEqual(outcome.removed, ["r1"]);
  assert.equal(outcome.remote.requests.length, 0);
  // 墓碑更新的行不会被再次上传覆盖删除标记。
  assert.equal(outcome.localChanges.requests.length, 0);

  // 重组时墓碑行不进入本地快照。
  const rebuilt = rowsToSnapshot(outcome.remote, sampleSnapshot());
  assert.equal(rebuilt.collections[0].items.length, 0);
});

test("mergeRows：本地比墓碑更新时复活该行而不是静默丢弃", () => {
  const local = snapshotToRows(sampleSnapshot());
  local.requests[0].updatedAt = 2500; // 本地修改晚于远端墓碑（2000）
  const remote = {
    folders: [],
    requests: [
      {
        id: "r1",
        folderId: "c1",
        folderPath: "auth",
        name: "登录",
        method: "POST",
        url: "",
        protocol: "http",
        position: 0,
        updatedAt: 2000,
        deleted: true,
        data: {},
      },
    ],
    environments: [],
    cases: [],
    scenarios: [],
    suites: [],
    artifacts: [],
    meta: {},
  };

  const outcome = mergeRows(local, remote);
  assert.deepEqual(outcome.removed, [], "本地较新时不传播删除");
  assert.equal(outcome.localChanges.requests.length, 1, "本地行待上传以复活");
  assert.equal(outcome.localChanges.requests[0].updatedAt, 2500);
  assert.equal(outcome.remote.requests.length, 1, "合并结果保留本地行");

  // 重组后接口仍在本地快照里（LWW：服务端会用上传行覆盖墓碑）。
  const rebuilt = rowsToSnapshot(outcome.remote, sampleSnapshot());
  assert.equal(rebuilt.collections[0].items.length, 1);
});

test("snapshotToRows 把本地墓碑写成 deleted 行，rowsToSnapshot 读回", () => {
  const base = sampleSnapshot();
  const snapshot = {
    ...base,
    collections: [{ ...base.collections[0], items: [] }],
    cases: [],
    tombstones: [
      { kind: "request", id: "r1", updatedAt: 900 },
      { kind: "docPage", id: "d1", updatedAt: 901 },
    ],
  };

  const rows = snapshotToRows(snapshot);
  const deletedRequest = rows.requests.find((row) => row.id === "r1");
  assert.equal(deletedRequest.deleted, true);
  assert.equal(deletedRequest.updatedAt, 900);
  assert.equal(deletedRequest.name, "", "墓碑行不需要 name");
  const deletedDoc = rows.artifacts.find((row) => row.id === "d1");
  assert.equal(deletedDoc.deleted, true);
  assert.equal(deletedDoc.kind, "docPage");

  const rebuilt = rowsToSnapshot(rows, snapshot);
  assert.deepEqual(
    rebuilt.tombstones.map((item) => `${item.kind}:${item.id}`).sort(),
    ["docPage:d1", "request:r1"],
  );
  assert.equal(rebuilt.collections[0].items.length, 0);
});

test("snapshotToRows 不会为活行重复生成墓碑", () => {
  const snapshot = {
    ...sampleSnapshot(),
    tombstones: [{ kind: "request", id: "r1", updatedAt: 900 }],
  };
  const rows = snapshotToRows(snapshot);
  assert.equal(rows.requests.filter((row) => row.id === "r1").length, 1);
  assert.notEqual(rows.requests[0].deleted, true, "活行优先于同 id 墓碑");
});

test("mergeRows：本地墓碑比远端活行新时上传删除，重组后不复活", () => {
  const base = sampleSnapshot();
  base.collections = [{ ...base.collections[0], items: [] }];
  base.cases = [];
  const local = snapshotToRows({
    ...base,
    tombstones: [{ kind: "request", id: "r1", updatedAt: 3000 }],
  });
  const remote = snapshotToRows(sampleSnapshot());
  remote.requests[0].updatedAt = 500;

  const outcome = mergeRows(local, remote);
  assert.deepEqual(outcome.removed, [], "本地墓碑更新，不按远端活行删除");
  assert.equal(outcome.localChanges.requests.length, 1);
  assert.equal(outcome.localChanges.requests[0].deleted, true, "墓碑随同步上传");
  const rebuilt = rowsToSnapshot(outcome.remote, base);
  assert.equal(rebuilt.collections[0].items.length, 0, "墓碑保留时不复活旧行");
});

test("缺 updatedAt 的实体拆行时保留 0，不再用当前时间伪装成最新", () => {
  const snapshot = {
    ...sampleSnapshot(),
    collections: [{ id: "c2", name: "无时间戳", items: [] }],
  };
  const rows = snapshotToRows(snapshot);
  assert.equal(rows.folders[0].updatedAt, 0);
});

test("restoreRowCredentials 回填请求 auth / 敏感 Header / KeyValue 空位", () => {
  const localRow = {
    id: "r1",
    updatedAt: 1,
    folderId: "c1",
    folderPath: "",
    name: "登录",
    method: "POST",
    url: "/login",
    protocol: "http",
    position: 0,
    data: {
      auth: { type: "bearer", token: "real-token" },
      headers: [
        {
          id: "h1",
          key: "Authorization",
          value: "Bearer abcdefghijklmnop1234",
          enabled: true,
        },
      ],
      variables: [{ id: "v1", key: "apiKey", value: "real-secret", enabled: true }],
    },
  };
  // 模拟 stripForUpload 之后的远端行：结构保留，凭据被清空。
  const redactedRow = {
    ...localRow,
    data: {
      auth: { ...localRow.data.auth, token: "" },
      // KeyValue 的名字命中敏感规则时整格清空（不是模式替换）。
      headers: [{ ...localRow.data.headers[0], value: "" }],
      variables: [{ ...localRow.data.variables[0], value: "" }],
    },
  };

  assert.deepEqual(restoreRowCredentials(redactedRow, localRow), localRow);

  const restored = restoreRowsCredentials(
    {
      folders: [],
      requests: [redactedRow],
      environments: [],
      cases: [],
      scenarios: [],
      suites: [],
      artifacts: [],
    },
    {
      folders: [],
      requests: [localRow],
      environments: [],
      cases: [],
      scenarios: [],
      suites: [],
      artifacts: [],
    },
  );
  assert.equal(restored.requests[0].data.auth.token, "real-token");
  assert.equal(restored.requests[0].data.headers[0].value, "Bearer abcdefghijklmnop1234");
  assert.equal(restored.requests[0].data.variables[0].value, "real-secret");
});

test("mergeRows：相等时间戳时墓碑优先（远端墓碑删除本地活行）", () => {
  const local = snapshotToRows(sampleSnapshot());
  local.requests[0].updatedAt = 2000;
  const remote = {
    folders: [],
    requests: [
      {
        id: "r1",
        folderId: "c1",
        folderPath: "auth",
        name: "",
        method: "",
        url: "",
        protocol: "http",
        position: 0,
        updatedAt: 2000,
        deleted: true,
        data: {},
      },
    ],
    environments: [],
    cases: [],
    scenarios: [],
    suites: [],
    artifacts: [],
    meta: {},
  };

  const outcome = mergeRows(local, remote);
  assert.deepEqual(outcome.removed, ["r1"], "并列时删除胜出");
  assert.equal(outcome.localChanges.requests.length, 0, "不上传会被墓碑覆盖的旧行");
  assert.equal(outcome.remote.requests.length, 0);
});

test("mergeRows：相等时间戳时本地墓碑优先于远端活行并上传", () => {
  const base = sampleSnapshot();
  base.collections = [{ ...base.collections[0], items: [] }];
  base.cases = [];
  const local = snapshotToRows({
    ...base,
    tombstones: [{ kind: "request", id: "r1", updatedAt: 2000 }],
  });
  const remote = snapshotToRows(sampleSnapshot());
  remote.requests[0].updatedAt = 2000;

  const outcome = mergeRows(local, remote);
  assert.deepEqual(outcome.removed, []);
  assert.equal(outcome.localChanges.requests.length, 1);
  assert.equal(outcome.localChanges.requests[0].deleted, true, "并列时墓碑仍要上传");
  const rebuilt = rowsToSnapshot(outcome.remote, base);
  assert.equal(rebuilt.collections[0].items.length, 0, "本地墓碑保留删除结果");
});

test("mergeRows：双方都活且时间戳相等时以服务端为准且不上传", () => {
  const local = snapshotToRows(sampleSnapshot());
  const remote = snapshotToRows(sampleSnapshot());
  local.requests[0].updatedAt = 2000;
  remote.requests[0].updatedAt = 2000;
  remote.requests[0].method = "PATCH";
  remote.requests[0].name = "远端命名";

  const outcome = mergeRows(local, remote);
  assert.equal(outcome.localChanges.requests.length, 0, "并列时客户端不上传");
  const merged = outcome.remote.requests.find((row) => row.id === "r1");
  assert.equal(merged.method, "PATCH", "服务端版本胜出");
  assert.equal(merged.name, "远端命名");
});

test("mergeRows：远端活行比本地墓碑新时以远端为准（删除后重建）", () => {
  const base = sampleSnapshot();
  base.collections = [{ ...base.collections[0], items: [] }];
  base.cases = [];
  const local = snapshotToRows({
    ...base,
    tombstones: [{ kind: "request", id: "r1", updatedAt: 1000 }],
  });
  const remote = snapshotToRows(sampleSnapshot());
  remote.requests[0].updatedAt = 2500;
  remote.requests[0].method = "PATCH";

  const outcome = mergeRows(local, remote);
  assert.deepEqual(outcome.removed, []);
  assert.equal(outcome.localChanges.requests.length, 0, "远端更新，不需要上传");
  const rebuilt = rowsToSnapshot(outcome.remote, base);
  assert.equal(rebuilt.collections[0].items.length, 1, "远端活行复活本地墓碑");
  assert.equal(rebuilt.collections[0].items[0].method, "PATCH");
  assert.deepEqual(rebuilt.tombstones, [], "旧墓碑被远端更新覆盖后清除");
});

