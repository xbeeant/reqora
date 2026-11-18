// 云端连接配置层：配置不在快照里、token 可持久化、按本地项目隔离协作空间。
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  clearCloudSession,
  cloudBaseUrl,
  DEFAULT_CLOUD_BASE_URL,
  flushCloudConnection,
  initializeCloudConnection,
  cloudLastImport,
  cloudLastImportError,
  cloudProjectFor,
  cloudSession,
  cloudStoredUser,
  forgetCloudProject,
  isCloudServerConfigured,
  readCloudConnection,
  replaceCloudConnection,
  resetCloudConnection,
  setCloudBaseUrl,
  setCloudImportError,
  setCloudImportResult,
  setCloudProjectFor,
  setCloudSession,
  switchCloudServer,
} from "../src/lib/cloudConnection.ts";

const KEY = "reqora.cloudConnection.v1";
const SESSION_KEY = "reqora.cloudSession.v1";

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
    clear: () => map.clear(),
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
}

const user = {
  id: 1,
  username: "alice",
  email: "alice@example.com",
  displayName: "Alice",
  status: 1,
  superAdmin: false,
  roles: [],
  permissions: [],
};

beforeEach(() => {
  globalThis.localStorage = fakeStorage();
  resetCloudConnection();
});

test("未配置协作服务器时默认地址为空，占位地址不再可用", () => {
  assert.equal(readCloudConnection().baseUrl, DEFAULT_CLOUD_BASE_URL);
  assert.equal(DEFAULT_CLOUD_BASE_URL, "");
  // P0: no example.com fallback. Collaboration entry points use this gate.
  assert.equal(isCloudServerConfigured(), false);
  assert.equal(isCloudServerConfigured("https://example.com/reqora"), false);
  assert.equal(isCloudServerConfigured("https://your-server.example.com/reqora"), false);
  assert.equal(isCloudServerConfigured("not a url"), false);
  assert.equal(isCloudServerConfigured("http://127.0.0.1:8080"), true);
  assert.equal(isCloudServerConfigured("https://collab.internal/reqora"), true);
  assert.equal(cloudSession(), null);
  assert.equal(cloudStoredUser(), null);

  // 写入端原样保存（受控输入框需要能打出 http://），读取端 cloudBaseUrl() 归一化。
  assert.equal(setCloudBaseUrl("  http://127.0.0.1:8080///  "), "  http://127.0.0.1:8080///  ");
  assert.equal(readCloudConnection().baseUrl, "  http://127.0.0.1:8080///  ");
  assert.equal(cloudBaseUrl(), "http://127.0.0.1:8080");
  // 连接配置写进 localStorage，而不是工作区快照。
  assert.match(globalThis.localStorage.getItem(KEY), /127\.0\.0\.1:8080/);
});

test("登录一次后 token 只以密文落盘，模拟重启仍可解密恢复", async () => {
  // 明文必须用足够长的串：两字符的 "a1" / "r1" 有可观概率偶然出现在随机
  // base64(nonce‖ciphertext) 里，会让「密文不得含明文」变成概率性 flaky。
  // 真正的正确性由下面的「重启后能解密还原原值」保证，不靠子串碰撞。
  const ACCESS = "reqora-access-token-2026-11-14-a1";
  const REFRESH = "reqora-refresh-token-2026-11-14-r1";
  setCloudSession({ access: ACCESS, refresh: REFRESH }, user);
  assert.equal(cloudSession().access, ACCESS);
  assert.equal(cloudStoredUser().username, "alice");
  await flushCloudConnection();

  const raw = globalThis.localStorage.getItem(KEY);
  const sealed = globalThis.localStorage.getItem(SESSION_KEY);
  assert.ok(!raw.includes(ACCESS) && !raw.includes(REFRESH), "连接配置里不得出现明文 token");
  assert.ok(!raw.includes("password"), "密码绝不落盘");
  assert.match(sealed, /^reqora\.local\.enc\.v1\./, "token 必须作为密文单独存放");
  assert.ok(!sealed.includes(ACCESS) && !sealed.includes(REFRESH), "密文里不得出现明文 token");

  // 重启：新 WebView 只有同一份 localStorage + 同一把非可导出密钥。
  const fresh = fakeStorage();
  fresh.setItem(KEY, raw);
  fresh.setItem(SESSION_KEY, sealed);
  globalThis.localStorage = fresh;
  await initializeCloudConnection();
  assert.equal(cloudSession().refresh, REFRESH);
  assert.equal(cloudStoredUser().displayName, "Alice");
});

test("旧版明文 token 启动时自动迁移为密文", async () => {
  globalThis.localStorage.setItem(
    KEY,
    JSON.stringify({
      baseUrl: "http://legacy.test",
      session: { access: "old-a", refresh: "old-r" },
      user: null,
      projects: {},
      lastImport: null,
      lastImportError: null,
    }),
  );
  await initializeCloudConnection();
  assert.equal(cloudSession().access, "old-a");
  await flushCloudConnection();
  const raw = globalThis.localStorage.getItem(KEY);
  assert.ok(!raw.includes("old-a") && !raw.includes("old-r"), "明文 token 必须从旧 payload 清除");
  assert.match(globalThis.localStorage.getItem(SESSION_KEY), /^reqora\.local\.enc\.v1\./);
});

test("加密不可用时绝不退化成明文落盘", async () => {
  // 模拟一个没有 WebCrypto 的环境：token 只留在内存，不写任何明文。
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  try {
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
  } catch {
    return; // 宿主不允许改写全局 crypto，跳过该分支
  }
  try {
    resetCloudConnection();
    setCloudSession({ access: "volatile-a", refresh: "volatile-r" }, null);
    await flushCloudConnection();
    const raw = globalThis.localStorage.getItem(KEY) ?? "";
    assert.ok(!raw.includes("volatile-a") && !raw.includes("volatile-r"));
    assert.equal(globalThis.localStorage.getItem(SESSION_KEY), null);
    assert.equal(cloudSession().access, "volatile-a", "本次会话仍可用");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
    else delete globalThis.crypto;
  }
});

test("退出登录只清 token，保留地址与上次导入记录", () => {
  setCloudBaseUrl("http://127.0.0.1:8080");
  setCloudSession({ access: "a1", refresh: "r1" }, user);
  setCloudImportResult({
    at: 1234,
    version: 3,
    projectId: 7,
    projectName: "团队空间",
    localProjectId: "default",
  });
  clearCloudSession();
  assert.equal(cloudSession(), null);
  assert.equal(cloudStoredUser(), null);
  assert.equal(cloudBaseUrl(), "http://127.0.0.1:8080");
  assert.equal(cloudLastImport().version, 3);
});

test("更换后端地址会丢弃旧 token 与已解析的协作空间", () => {
  setCloudBaseUrl("http://old.test");
  setCloudSession({ access: "old-a", refresh: "old-r" }, user);
  setCloudProjectFor("default", { id: 7, name: "旧空间", slug: "reqora-default" });

  switchCloudServer("http://new.test");
  assert.equal(cloudBaseUrl(), "http://new.test");
  assert.equal(cloudSession(), null);
  assert.equal(cloudStoredUser(), null);
  assert.equal(cloudProjectFor("default"), null);
  assert.equal(cloudLastImport(), null);
});

test("协作空间按本地项目 id 分别记忆，互不串扰", () => {
  setCloudProjectFor("default", { id: 1, name: "默认空间", slug: "reqora-default" });
  setCloudProjectFor("proj-2", { id: 2, name: "第二个空间", slug: "reqora-proj-2" });
  assert.equal(cloudProjectFor("default").id, 1);
  assert.equal(cloudProjectFor("proj-2").id, 2);
  assert.equal(cloudProjectFor("missing"), null);

  forgetCloudProject("default");
  assert.equal(cloudProjectFor("default"), null);
  assert.equal(cloudProjectFor("proj-2").id, 2);
});

test("导入成功/失败记录互斥且可持久化", () => {
  setCloudImportError("上次离线");
  assert.equal(cloudLastImportError(), "上次离线");
  setCloudImportResult({
    at: 999,
    version: 4,
    projectId: 2,
    projectName: "第二个空间",
    localProjectId: "proj-2",
  });
  assert.equal(cloudLastImportError(), null);
  assert.equal(cloudLastImport().version, 4);
});

test("损坏的配置不会让启动崩溃，回落到干净状态", () => {
  globalThis.localStorage.setItem(KEY, "{not json");
  assert.deepEqual(readCloudConnection(), {
    baseUrl: DEFAULT_CLOUD_BASE_URL,
    session: null,
    user: null,
    projects: {},
    lastImport: null,
    lastImportError: null,
  });
});

test("replaceCloudConnection 会校验字段类型", () => {
  replaceCloudConnection({
    baseUrl: "http://x",
    session: { access: 1, refresh: 2 },
    user: null,
    projects: { default: { id: "bad" }, ok: { id: 5, name: "n", slug: "s" } },
    lastImport: null,
    lastImportError: null,
  });
  assert.equal(cloudSession(), null);
  assert.equal(cloudProjectFor("default"), null);
  assert.equal(cloudProjectFor("ok").id, 5);
});

test("没有 localStorage 时退化为会话内存态，功能仍可用", () => {
  globalThis.localStorage = undefined;
  const state = setCloudBaseUrl("http://memory.test");
  assert.equal(state, "http://memory.test");
  setCloudSession({ access: "m1", refresh: "m2" }, user);
  assert.equal(cloudSession().access, "m1");
  assert.equal(cloudStoredUser().username, "alice");
  clearCloudSession();
  assert.equal(cloudSession(), null);
  assert.equal(cloudBaseUrl(), "http://memory.test");
});
