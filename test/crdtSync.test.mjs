// 同步协议 v2 回归测试：两个线上缺陷（删除复活 / 重复点击假冲突）+ 收敛不变量。
//
// 用内存「哑日志」服务端完整跑状态机，不需要浏览器、Tauri 或真实 MySQL：
// 服务端只做 seq 排序 + hash 去重 + genesis/snapshot，与线上实现同构。
import test from "node:test";
import assert from "node:assert/strict";

import * as C from "../src/lib/crdtDoc.ts";
import {
  crdtConflictsToEntries,
  normalizeCrdtState,
  resolveCrdtConflictRemote,
  runCrdtSync,
} from "../src/lib/crdtSync.ts";
import { createCloudCrdtTransport } from "../src/lib/cloudCrdt.ts";
import { GIT_CRDT_FILE, parseCrdtFile } from "../src/lib/gitCrdt.ts";
import { planGitSync, snapshotToGitFiles } from "../src/lib/gitNative.ts";
import { normalizeSnapshot, seedSnapshot } from "../src/lib/defaults.ts";

const PROJECT = 7;

const rows = (requests = []) => ({
  folders: [],
  requests,
  environments: [],
  cases: [],
  scenarios: [],
  suites: [],
  artifacts: [],
});

const request = (id, name, at) => ({
  id,
  updatedAt: at,
  folderId: "f1",
  folderPath: "",
  name,
  method: "GET",
  url: "/x",
  protocol: "http",
  position: 0,
  data: {},
});

const tombstone = (id, at) => ({ id, updatedAt: at, deleted: true });

/** 与 CrdtSyncService 同构的内存实现：追加日志、hash 唯一、seq 游标、快照。 */
class MemoryCrdtServer {
  constructor() {
    this.genesis = null;
    this.snapshot = null;
    this.records = [];
    this.byHash = new Map();
    this.seq = 0;
    this.snapshotSeqs = [];
  }

  info() {
    return {
      genesis: this.genesis,
      snapshot: this.snapshot,
      heads: [],
      cursor: this.seq,
      version: this.seq,
    };
  }

  async createGenesis(genesis) {
    if (!this.genesis) this.genesis = genesis;
    return this.info();
  }

  async changes(since, limit = 500) {
    const page = this.records.filter((record) => record.seq > since).slice(0, limit);
    return {
      changes: page.map((record) => ({
        seq: record.seq,
        hash: record.hash,
        payload: record.payload,
      })),
      cursor: page.length ? page[page.length - 1].seq : Math.max(0, since),
      version: this.seq,
    };
  }

  async postChanges(changes) {
    const accepted = [];
    const duplicates = [];
    for (const bytes of changes) {
      const hash = C.changeHash(bytes);
      if (this.byHash.has(hash)) {
        duplicates.push(hash);
        continue;
      }
      this.seq += 1;
      const record = { seq: this.seq, hash, payload: C.bytesToBase64(bytes) };
      this.records.push(record);
      this.byHash.set(hash, record);
      accepted.push(hash);
    }
    return { accepted, duplicates, cursor: this.seq, version: this.seq };
  }

  async postSnapshot(doc, heads, seq) {
    this.snapshot = { doc, seq };
    this.snapshotSeqs.push(seq);
  }

  transport() {
    return {
      bootstrap: () => Promise.resolve(this.info()),
      createGenesis: (g) => this.createGenesis(g),
      changes: (s, l) => this.changes(s, l),
      postChanges: (c) => this.postChanges(c),
      postSnapshot: (d, h, s) => this.postSnapshot(d, h, s),
    };
  }
}

/** 离线通道：拉取恒为空，提交只记进 sink，稍后统一补投到主服务端。 */
function offlineTransport(info, sink) {
  return {
    bootstrap: () => Promise.resolve({ ...info, snapshot: null }),
    createGenesis: (g) => Promise.resolve({ ...info, genesis: g }),
    changes: (since) => Promise.resolve({ changes: [], cursor: since, version: 0 }),
    postChanges: (changes) => {
      sink.push(...changes);
      return Promise.resolve({
        accepted: changes.map(C.changeHash),
        duplicates: [],
        cursor: 0,
        version: 0,
      });
    },
    postSnapshot: () => Promise.resolve(),
  };
}

const sync = (state, desired, server) =>
  runCrdtSync({
    state,
    cloudProjectId: PROJECT,
    desired,
    transport: server.transport(),
  });

// ------------------------------------------------------------ 基础不变量 ----

test("共享 genesis 是所有副本收敛的前提，change 按 hash 幂等", () => {
  const actorA = C.newActorId();
  const actorB = C.newActorId();
  const genesis = C.createGenesis(actorA);
  const a = C.initFromGenesis(genesis, actorA);
  const b = C.initFromGenesis(genesis, actorB);
  assert.deepEqual(C.crdtHeads(a), C.crdtHeads(b));

  const put = C.applyLocalRows(a, rows([request("r1", "one", 1)]), actorA);
  assert.equal(put.changes.length, 1);
  assert.match(C.changeHash(put.changes[0]), /^[0-9a-f]{64}$/);

  let replica = C.applyRemoteChanges(b, put.changes, actorB);
  assert.equal(C.projectRows(replica).requests.length, 1);
  const headsBefore = C.crdtHeads(replica);
  replica = C.applyRemoteChanges(replica, put.changes, actorB);
  assert.deepEqual(C.crdtHeads(replica), headsBefore, "重放同一 change 不改变 heads");
  assert.equal(C.applyLocalRows(replica, C.projectRows(replica), actorB).changes.length, 0);
});

test("快照 base64 往返后换 actorId 仍可继续写入", () => {
  const actor = C.newActorId();
  let doc = C.initFromGenesis(C.createGenesis(actor), actor);
  doc = C.applyLocalRows(doc, rows([request("r1", "one", 1)]), actor).doc;
  const encoded = C.bytesToBase64(C.saveCrdtDoc(doc));
  const reloaded = C.loadCrdtDoc(C.base64ToBytes(encoded), C.newActorId());
  assert.deepEqual(C.crdtHeads(reloaded), C.crdtHeads(doc));
  const edited = C.applyLocalRows(
    reloaded,
    rows([request("r1", "two", 2)]),
    C.newActorId(),
  );
  assert.equal(edited.changes.length, 1);
  assert.equal(C.projectRows(edited.doc).requests[0].name, "two");
});

// ------------------------------------------------- 缺陷 1：删除不复活 ----

test("本地删除同步后不复活，另一副本拉取后也保持删除（连续多次点击）", async () => {
  const server = new MemoryCrdtServer();
  const initial = rows([request("r1", "one", 1)]);

  // 副本 A 建立数据，副本 B 首次同步看到同一行。
  const outA = await sync(null, initial, server);
  assert.equal(outA.supported, true);
  assert.equal(outA.rows.requests.length, 1);
  let outB = await sync(null, rows(), server);
  assert.equal(outB.rows.requests.length, 1, "B 首次同步应拉到 r1");

  // A 本地删除（墓碑行显式表达删除），删除作为一等 CRDT change 上传。
  const deleted = await sync(outA.state, rows([tombstone("r1", 2)]), server);
  assert.equal(deleted.rows.requests.length, 0);
  assert.equal(deleted.stats.remove, 1);

  // B 仍持有旧行集（模拟真实：上一轮投影已写回本地快照），
  // 但本地没有新编辑，因此绝不能把它重新 put 回去。
  for (let click = 0; click < 4; click += 1) {
    outB = await sync(outB.state, outB.rows, server);
    assert.equal(outB.rows.requests.length, 0, `第 ${click + 1} 次拉取后 r1 不应复活`);
    assert.equal(outB.conflicts.length, 0);
    assert.equal(outB.stats.put, 0, "没有本地编辑就不该产生 put");
  }
  assert.ok(server.records.length >= 2, "删除 change 必须进追加日志");
});

// ------------------------------------------- 缺陷 2：重复点击假冲突 ----

test("同一份数据连续同步 3 次：无冲突、无新 change、游标稳定", async () => {
  const server = new MemoryCrdtServer();
  const data = rows([request("r1", "one", 1), request("r2", "two", 1)]);
  let outcome = await sync(null, data, server);
  assert.equal(outcome.conflicts.length, 0);
  const seqAfterFirst = server.seq;

  for (let click = 0; click < 3; click += 1) {
    outcome = await sync(outcome.state, outcome.rows, server);
    assert.equal(outcome.conflicts.length, 0, `第 ${click + 2} 次点击不应报冲突`);
    assert.equal(outcome.stats.put + outcome.stats.remove, 0);
    assert.equal(outcome.stats.pushed, 0, "不应重复提交任何 change");
    assert.equal(server.seq, seqAfterFirst, "日志不应因重复点击增长");
  }
  assert.deepEqual(C.crdtHeads(C.loadCrdtDoc(C.base64ToBytes(outcome.state.doc), outcome.state.actorId)),
    outcome.state.heads);
});

// --------------------------------------------------------- 并发与裁决 ----

test("并发双改：getConflicts 拿到两个候选，裁决后所有副本收敛", async () => {
  const server = new MemoryCrdtServer();
  const base = rows([request("r1", "base", 1)]);
  const outA = await sync(null, base, server);
  const outB = await sync(null, rows(), server);

  const sink = [];
  const info = server.info();
  const left = await runCrdtSync({
    state: outA.state,
    cloudProjectId: PROJECT,
    desired: rows([request("r1", "L", 2)]),
    transport: offlineTransport(info, sink),
  });
  const right = await runCrdtSync({
    state: outB.state,
    cloudProjectId: PROJECT,
    desired: rows([request("r1", "R", 3)]),
    transport: offlineTransport(info, sink),
  });
  await server.postChanges(sink);

  const pulled = await sync(left.state, left.rows, server);
  assert.equal(pulled.conflicts.length, 1);
  assert.equal(pulled.conflicts[0].kind, "concurrent-edit");
  assert.equal(pulled.conflicts[0].candidates.length, 2);
  const names = pulled.conflicts[0].candidates.map((row) => row.name).sort();
  assert.deepEqual(names, ["L", "R"]);

  const entry = crdtConflictsToEntries(pulled.conflicts)[0];
  assert.equal(entry.domain, "requests");
  assert.equal(entry.base, null, "CRDT 没有祖先行，字段合并 UI 应安全退化");

  const winner = pulled.conflicts[0].candidates.find((row) => row.name === "L");
  const resolvedState = await resolveCrdtConflictRemote({
    state: pulled.state,
    domain: "requests",
    id: "r1",
    resolution: { type: "row", row: winner },
    transport: server.transport(),
  });
  const settled = await sync(resolvedState, rows([winner]), server);
  assert.equal(settled.conflicts.length, 0, "裁决后冲突必须消失");
  const settledRight = await sync(right.state, right.rows, server);
  assert.equal(settledRight.conflicts.length, 0);
  assert.deepEqual(settledRight.state.heads, settled.state.heads, "两副本 heads 收敛");
  assert.equal(settledRight.rows.requests[0].name, "L");
});

test("删除 vs 编辑并发：识别为 delete-vs-edit，删除优先裁决后收敛", async () => {
  const server = new MemoryCrdtServer();
  const base = rows([request("r1", "base", 1)]);
  const outA = await sync(null, base, server);
  const outB = await sync(null, rows(), server);

  const sink = [];
  const info = server.info();
  const deleting = await runCrdtSync({
    state: outA.state,
    cloudProjectId: PROJECT,
    desired: rows([tombstone("r1", 2)]),
    transport: offlineTransport(info, sink),
  });
  const editing = await runCrdtSync({
    state: outB.state,
    cloudProjectId: PROJECT,
    desired: rows([request("r1", "edited", 3)]),
    transport: offlineTransport(info, sink),
  });
  await server.postChanges(sink);

  const merged = await sync(deleting.state, deleting.rows, server);
  assert.equal(merged.conflicts.length, 1);
  assert.equal(merged.conflicts[0].kind, "delete-vs-edit");
  assert.equal(
    merged.rows.requests.length,
    1,
    "Automerge add-wins 会让 key 复活，必须显式识别为冲突而不是静默恢复",
  );

  const resolvedState = await resolveCrdtConflictRemote({
    state: merged.state,
    domain: "requests",
    id: "r1",
    resolution: { type: "delete" },
    transport: server.transport(),
  });
  const settled = await sync(resolvedState, rows(), server);
  assert.equal(settled.rows.requests.length, 0, "删除优先后行不应存在");
  assert.equal(settled.conflicts.length, 0);
  const settledOther = await sync(editing.state, editing.rows, server);
  assert.equal(settledOther.conflicts.length, 0);
  assert.deepEqual(settledOther.state.heads, settled.state.heads);
});

// ------------------------------------------------- 离线补投 / 状态健壮 ----

test("离线变更上线后按 deps 补投，游标不跳跃、不漏投", async () => {
  const server = new MemoryCrdtServer();
  const outA = await sync(null, rows([request("r1", "one", 1)]), server);
  const outB = await sync(null, rows(), server);

  const sink = [];
  const offline = await runCrdtSync({
    state: outA.state,
    cloudProjectId: PROJECT,
    desired: rows([request("r1", "offline-edit", 5), request("r2", "new", 5)]),
    transport: offlineTransport(server.info(), sink),
  });
  assert.equal(sink.length, 1);
  await server.postChanges(sink);

  const pulled = await sync(outB.state, outB.rows, server);
  assert.equal(pulled.rows.requests.length, 2);
  assert.equal(pulled.conflicts.length, 0);
  assert.equal(pulled.state.cursor, server.seq);
  assert.equal(offline.state.cursor >= 0, true);
});

test("重放整批 change 只记一次（hash 幂等键）", async () => {
  const server = new MemoryCrdtServer();
  const outcome = await sync(null, rows([request("r1", "one", 1)]), server);
  const replay = server.records.map((record) => C.base64ToBytes(record.payload));
  const result = await server.postChanges(replay);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.duplicates.length, replay.length);
  assert.equal(server.records.length, replay.length);
  assert.equal(outcome.conflicts.length, 0);
});

test("bootstrap 快照的 seq 不超过客户端实际拉取位置", async () => {
  const server = new MemoryCrdtServer();
  let state = null;
  for (let i = 0; i < 3; i += 1) {
    const outcome = await sync(state, rows([request(`r${i}`, `n${i}`, i + 1)]), server);
    state = outcome.state;
  }
  assert.ok(server.snapshotSeqs.length > 0);
  for (const seq of server.snapshotSeqs) {
    assert.ok(seq <= server.seq, "快照不得声称包含尚未拉取的 change");
    assert.ok(seq >= 0);
  }
  // 新副本从快照 bootstrap 仍能看到全部历史。
  const newcomer = await sync(normalizeCrdtState(null, PROJECT), rows(), server);
  assert.equal(newcomer.rows.requests.length, 3);
  assert.equal(newcomer.conflicts.length, 0);
});

test("旧服务端（无 bootstrap 端点）返回 supported=false，交给 legacy 回退", async () => {
  const legacyTransport = {
    bootstrap: () => Promise.resolve(null),
    createGenesis: () => Promise.reject(new Error("must not be called")),
    changes: () => Promise.reject(new Error("must not be called")),
    postChanges: () => Promise.reject(new Error("must not be called")),
  };
  const outcome = await runCrdtSync({
    state: null,
    cloudProjectId: PROJECT,
    desired: rows([request("r1", "one", 1)]),
    transport: legacyTransport,
  });
  assert.equal(outcome.supported, false);
  assert.equal(outcome.rows, null);
  assert.equal(outcome.conflicts.length, 0);
});

// ---------------------------------------------------------- REST 契约 ----

test("cloudCrdt transport：404 能力探测回退，POST /changes 带 hash+payload", async () => {
  const calls = [];
  const json = (data, status = 200) =>
    new Response(JSON.stringify({ code: status === 200 ? 0 : 1004, message: "x", data }), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/crdt/bootstrap") && init?.method !== "POST") {
      return json(null, 404);
    }
    return json({ accepted: ["deadbeef"], duplicates: [], cursor: 1, version: 1 });
  };
  const transport = createCloudCrdtTransport(PROJECT, {
    baseUrl: "http://cloud.test",
    fetchFn,
    retries: 0,
  });
  assert.equal(await transport.bootstrap(), null, "旧服务端 404 必须静默回退");

  const actor = C.newActorId();
  let doc = C.initFromGenesis(C.createGenesis(actor), actor);
  const change = C.applyLocalRows(doc, rows([request("r1", "one", 1)]), actor).changes[0];
  const result = await transport.postChanges([change]);
  assert.deepEqual(result.accepted, ["deadbeef"]);
  const post = calls.find((call) => call.url.endsWith("/crdt/changes") && call.init?.method === "POST");
  assert.ok(post, "应提交到 /crdt/changes");
  const body = JSON.parse(post.init.body);
  assert.equal(body.changes.length, 1);
  assert.equal(body.changes[0].hash, C.changeHash(change));
  assert.equal(body.changes[0].payload, C.bytesToBase64(change));
  assert.ok(!JSON.stringify(body).includes("Bearer"), "请求体不得夹带凭据");
});

// ---------------------------------------------------- Git-native 通道 ----

test("Git 通道带 reqora.crdt.yaml 时走 CRDT：删除不复活、重复同步收敛", () => {
  const snap = normalizeSnapshot(seedSnapshot());
  const targetId = snap.collections[0].items[0].id;
  const files = snapshotToGitFiles(snap, true);
  assert.ok(files[GIT_CRDT_FILE], "显式启用后应生成 CRDT 文件");
  assert.ok(parseCrdtFile(files[GIT_CRDT_FILE]), "CRDT 文件必须可无损还原");
  assert.equal(Object.keys(files).length, 9, "原 8 份 YAML 保持不变，只多一份 CRDT");

  const first = planGitSync(snap, files);
  assert.equal(first.conflicts.length, 0);
  assert.ok(first.rows.requests.some((row) => row.id === targetId));

  const baseline = { dir: "test-dir", files, rows: first.rows, conflicts: [], at: 1 };
  const deleted = {
    ...snap,
    collections: snap.collections.map((collection) => ({
      ...collection,
      items: collection.items.filter((item) => item.id !== targetId),
    })),
    tombstones: [{ kind: "request", id: targetId, updatedAt: Date.now() }],
  };
  const afterDelete = planGitSync(deleted, files, { baseline });
  assert.equal(afterDelete.conflicts.length, 0);
  assert.ok(
    !afterDelete.rows.requests.some((row) => row.id === targetId),
    "Git 通道的删除也不能被本地缓存或三方合并复活",
  );
  assert.ok(afterDelete.files[GIT_CRDT_FILE]);

  const settled = planGitSync(deleted, afterDelete.files, {
    baseline: { ...baseline, files: afterDelete.files, rows: afterDelete.rows },
  });
  assert.equal(settled.conflicts.length, 0, "重复同步不应产生假冲突");
  assert.ok(!settled.rows.requests.some((row) => row.id === targetId));
});
