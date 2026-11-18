// T2.3 单向 Git 镜像：稳定性 / 排序 / 脱敏 / 输入不变 / --check 退出码。
// 不跑全量 test/*.test.mjs，只针对本文件与 bench.test.mjs。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GIT_MIRROR_DOMAINS,
  GIT_MIRROR_MANIFEST,
  GIT_MIRROR_MANIFEST_FILE,
  GIT_MIRROR_UNSYNCED,
  renderGitMirror,
} from "../src/lib/gitMirror.ts";
import {
  buildMirrorPlan,
  compareMirror,
  parseMirrorArgs,
  usage,
  writeMirrorAtomic,
} from "../bin/git-mirror.mjs";
import { rmTemp } from "../scripts/rm-temp.mjs";

const CLI = fileURLToPath(new URL("../bin/git-mirror.mjs", import.meta.url));

// --------------------------------------------------------------- fixtures ----

/** 覆盖 7 个域 + 各类凭据 + 本机专属域哨兵 + 时间戳。 */
function makeSnapshot(collectionOrder = "abc") {
  const collections = [
    {
      id: "col-a",
      name: "A",
      auth: { type: "bearer", token: "COLLECTION_BEARER_SECRET" },
      folders: ["空目录"],
      updatedAt: 1700000000001,
      items: [
        {
          id: "req-a",
          name: "接口 A",
          method: "GET",
          url: "https://api.example.com/a?token=URL_TOKEN_SECRET",
          updatedAt: 1700000000002,
          headers: [
            { id: "h-a1", key: "X-Api-Key", value: "HEADER_API_SECRET", enabled: true },
            { id: "h-a2", key: "Cookie", value: "COOKIE_SECRET_VALUE", enabled: true },
            { id: "h-a3", key: "Content-Type", value: "application/json", enabled: true },
          ],
          query: [],
          body: { type: "json", content: '{"x":1}' },
          auth: { type: "bearer", token: "REQUEST_BEARER_SECRET" },
          preScript: "const t = 'sk-live-ABCD1234SCRIPTSECRET5678';",
          description: "普通描述",
        },
      ],
    },
    {
      id: "col-b",
      name: "B",
      items: [
        {
          id: "req-b",
          name: "接口 B",
          method: "POST",
          url: "https://api.example.com/b",
          updatedAt: 1700000000003,
          headers: [],
          query: [],
          body: { type: "none" },
          auth: { type: "none" },
        },
      ],
    },
    { id: "col-c", name: "C", items: [] },
  ];
  const ordered =
    collectionOrder === "abc"
      ? collections
      : [collections[2], collections[0], collections[1]];
  return {
    version: 1,
    seeded: false,
    activeEnvironmentId: "env-1",
    collections: ordered,
    environments: [
      {
        id: "env-1",
        name: "生产",
        updatedAt: 1700000000004,
        variables: [
          { id: "v-secret", key: "apiToken", value: "ENV_SECRET_VARIABLE_VALUE", enabled: true, secret: true },
          { id: "v-plain", key: "baseUrl", value: "https://api.example.com", enabled: true },
        ],
        headers: [],
      },
    ],
    cases: [
      {
        id: "case-1",
        requestId: "req-a",
        group: "正向",
        name: "用例 1",
        enabled: true,
        updatedAt: 1700000000005,
        request: {
          id: "req-a",
          name: "接口 A",
          method: "GET",
          url: "https://api.example.com/a",
          headers: [],
          query: [],
          body: { type: "none" },
          auth: { type: "basic", username: "u", password: "CASE_BASIC_PASSWORD" },
        },
        expectedStatus: 200,
        syncedAt: 1,
        createdAt: 1,
      },
    ],
    scenarios: [{ id: "scn-1", name: "场景 1", updatedAt: 1700000000006, steps: [], createdAt: 1 }],
    suites: [
      {
        id: "suite-1",
        name: "套件 1",
        updatedAt: 1700000000007,
        items: [],
        createdAt: 1,
        lastRun: { at: 1700000000999, total: 0, passed: 0, failed: 0, skipped: 0, timeMs: 0, items: [] },
      },
    ],
    docPages: [
      {
        id: "doc-1",
        title: "鉴权",
        slug: "auth",
        group: "guide",
        body: "token=DOC_BODY_TOKEN_SECRET 与 password: DOC_BODY_PASSWORD",
        updatedAt: 1700000000008,
      },
    ],
    dataModels: [{ id: "dm-1", name: "User", description: "d", schemaText: "{}", updatedAt: 1700000000009 }],
    scriptLibrary: [{ id: "sl-1", name: "片段", description: "d", code: "console.log(1)", updatedAt: 1700000000010 }],
    codeTemplates: [{ id: "ct-1", name: "模板", description: "d", content: "x", updatedAt: 1700000000011 }],
    history: [
      {
        id: "hist-1",
        at: 1,
        name: "h",
        method: "GET",
        url: "HISTORY_UNIQUE_SENTINEL",
        status: 200,
        timeMs: 1,
        request: { id: "req-a", name: "x", method: "GET", url: "x", headers: [], query: [], body: { type: "none" }, auth: { type: "none" } },
      },
    ],
    trash: [
      {
        id: "trash-1",
        deletedAt: 1,
        payload: {
          kind: "request",
          request: { id: "req-a", name: "x", method: "GET", url: "TRASH_UNIQUE_SENTINEL", headers: [], query: [], body: { type: "none" }, auth: { type: "none" } },
          collectionId: "col-a",
          collectionName: "A",
        },
      },
    ],
    tombstones: [{ kind: "request", id: "DELETED_TOMBSTONE_SENTINEL", updatedAt: 1700000000012 }],
    settings: { timeoutSecs: 30, aiApiKey: "SETTINGS_AI_KEY_SECRET", cloudBaseUrl: "https://cloud.example.com" },
    theme: "dark",
    mcpServers: [
      { name: "m", transport: "stdio", command: "x", args: [], env: { TOKEN: "MCP_ENV_SECRET" }, url: "", headers: {} },
    ],
  };
}

const EXPECTED_FILES = [
  "reqora.collections.yaml",
  "reqora.requests.yaml",
  "reqora.environments.yaml",
  "reqora.cases.yaml",
  "reqora.scenarios.yaml",
  "reqora.suites.yaml",
  "reqora.artifacts.yaml",
];

// --------------------------------------------------------------- 纯逻辑 ----

test("7 个域产出 7 份文件，命名与 GIT_MIRROR_DOMAINS 一致", () => {
  const out = renderGitMirror(makeSnapshot());
  assert.deepEqual(Object.keys(out), EXPECTED_FILES);
  assert.equal(GIT_MIRROR_DOMAINS.length, 7);
  assert.deepEqual(
    GIT_MIRROR_DOMAINS.map((domain) => domain.file),
    EXPECTED_FILES,
  );
  for (const text of Object.values(out)) {
    assert.ok(text.startsWith("# reqora.git-mirror.v1"), "每份文件带稳定 schema 头");
    assert.ok(text.includes("schema: \"reqora.git-mirror.v1\""));
    assert.ok(text.endsWith("\n"), "以换行结尾");
  }
});

test("同一输入连续两次 render 字节一致（无时间戳 / 随机值）", () => {
  const snapshot = makeSnapshot();
  const first = renderGitMirror(snapshot);
  const second = renderGitMirror(snapshot);
  assert.deepEqual(first, second);
  for (const file of EXPECTED_FILES) {
    assert.ok(
      Buffer.from(first[file], "utf8").equals(Buffer.from(second[file], "utf8")),
      `${file} 字节一致`,
    );
  }
  const all = Object.values(first).join("\n");
  // 时间戳字段被剔除：输入里的 updatedAt 值不得出现在输出
  assert.ok(!all.includes("1700000000002"), "updatedAt 被剔除");
  assert.ok(!all.includes("1700000000999"), "运行态 lastRun 被剔除");
});

test("按 id 稳定排序，且输入数组顺序不影响产物", () => {
  const abc = renderGitMirror(makeSnapshot("abc"));
  const cba = renderGitMirror(makeSnapshot("cba"));
  assert.deepEqual(abc, cba, "打乱集合顺序后产物仍一致（按 id 排序）");
  const ids = [...abc["reqora.collections.yaml"].matchAll(/^\s*- id: "([^"]+)"/gm)].map(
    (match) => match[1],
  );
  assert.deepEqual(ids, ["col-a", "col-b", "col-c"]);
});

test("脱敏：私密值 / token / Cookie / 凭据 / 本机专属域都不出现；私密变量只写变量名", () => {
  const out = renderGitMirror(makeSnapshot());
  const all = Object.values(out).join("\n");
  const secrets = [
    "ENV_SECRET_VARIABLE_VALUE",
    "HEADER_API_SECRET",
    "COOKIE_SECRET_VALUE",
    "COLLECTION_BEARER_SECRET",
    "REQUEST_BEARER_SECRET",
    "URL_TOKEN_SECRET",
    "sk-live-ABCD1234SCRIPTSECRET5678",
    "CASE_BASIC_PASSWORD",
    "DOC_BODY_TOKEN_SECRET",
    "DOC_BODY_PASSWORD",
    "SETTINGS_AI_KEY_SECRET",
    "MCP_ENV_SECRET",
    "HISTORY_UNIQUE_SENTINEL",
    "TRASH_UNIQUE_SENTINEL",
    "DELETED_TOMBSTONE_SENTINEL",
  ];
  for (const secret of secrets) {
    assert.ok(!all.includes(secret), `秘密不得出现：${secret}`);
  }
  // 私密变量只保留变量名（值被丢弃），变量名仍可见
  assert.ok(out["reqora.environments.yaml"].includes("apiToken"), "变量名 apiToken 被保留");
  assert.ok(!out["reqora.environments.yaml"].includes("ENV_SECRET_VARIABLE_VALUE"));
  // 敏感 header 只写键名
  assert.ok(out["reqora.requests.yaml"].includes("X-Api-Key"), "header 名被保留");
  assert.ok(!out["reqora.requests.yaml"].includes("HEADER_API_SECRET"));
});

test("不修改输入（不写 updatedAt，深拷贝后打码）", () => {
  const snapshot = makeSnapshot();
  const before = structuredClone(snapshot);
  renderGitMirror(snapshot);
  renderGitMirror(snapshot);
  assert.deepEqual(snapshot, before, "输入快照逐字段不变");
});

test("GIT_MIRROR_UNSYNCED 明确列出本机专属 / 不镜像域", () => {
  for (const key of ["history", "trash", "revisions", "tombstones", "syncBaseline", "settings", "cookies", "secretVariableValues"]) {
    assert.ok(GIT_MIRROR_UNSYNCED.includes(key), `应列出 ${key}`);
  }
  assert.ok(GIT_MIRROR_MANIFEST.includes("SQLite"));
  assert.ok(GIT_MIRROR_MANIFEST.includes("只写不读"));
  for (const file of EXPECTED_FILES) assert.ok(GIT_MIRROR_MANIFEST.includes(file));
});

test("buildMirrorPlan 含 8 个文件（7 YAML + MANIFEST）；compareMirror 与原子写入", () => {
  const root = mkdtempSync(join(tmpdir(), "reqora-gitmirror-"));
  try {
    const plan = buildMirrorPlan(makeSnapshot());
    assert.equal(Object.keys(plan).length, 8);
    assert.ok(plan[GIT_MIRROR_MANIFEST_FILE]);

    // 空目录 → 全部 missing
    const empty = compareMirror(join(root, "none"), plan);
    assert.equal(empty.ok, false);
    assert.equal(empty.diffs.length, 8);

    const outDir = join(root, "out");
    const written = writeMirrorAtomic(outDir, plan);
    assert.equal(written.length, 8);
    assert.equal(compareMirror(outDir, plan).ok, true);
    // 原子写入不残留 .tmp
    assert.ok(!readdirSync(outDir).some((name) => name.endsWith(".tmp")));
    // MANIFEST 内容正确落盘
    assert.equal(readFileSync(join(outDir, GIT_MIRROR_MANIFEST_FILE), "utf8"), GIT_MIRROR_MANIFEST);
    // 篡改一个文件 → changed
    const target = join(outDir, "reqora.collections.yaml");
    writeFileSync(target, `${readFileSync(target, "utf8")}\n# tampered\n`, "utf8");
    const changed = compareMirror(outDir, plan);
    assert.equal(changed.ok, false);
    assert.ok(changed.diffs.some((diff) => diff.reason === "changed"));
  } finally {
    rmTemp(root);
  }
});

test("parseMirrorArgs 与 usage 反映只写不读语义", () => {
  const args = parseMirrorArgs(["--out", "/tmp/x", "--check", "--help", "--snapshot", "/tmp/s.json"]);
  assert.equal(args.check, true);
  assert.equal(args.help, true);
  // parseMirrorArgs 会把路径 resolve 成绝对路径；Windows 上 `/tmp/s.json`
  // 会变成 `<当前盘符>:\tmp\s.json`，断言必须用同一套规则而非硬编码 POSIX 路径。
  assert.equal(args.out, resolve("/tmp/x"));
  assert.equal(args.snapshot, resolve("/tmp/s.json"));
  assert.ok(usage().includes("只写不读"));
  assert.ok(usage().includes("--check"));
});

// --------------------------------------------------------------- CLI ----

function runCli(extraArgs) {
  return spawnSync(process.execPath, [CLI, ...extraArgs], { encoding: "utf8" });
}

test("CLI --help 退出 0 且不加载工作区", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("只写不读"));
  assert.ok(result.stdout.includes("--check"));
});

test("CLI --check：文件一致退出 0，篡改 / 缺失退出 1", () => {
  const root = mkdtempSync(join(tmpdir(), "reqora-gitmirror-cli-"));
  try {
    const snapshot = makeSnapshot();
    const snapFile = join(root, "snapshot.json");
    const outDir = join(root, "out");
    writeFileSync(snapFile, JSON.stringify(snapshot), "utf8");
    writeMirrorAtomic(outDir, buildMirrorPlan(snapshot));

    const check = () => runCli(["--snapshot", snapFile, "--out", outDir, "--check"]);

    assert.equal(check().status, 0, "一致时退出 0");

    const target = join(outDir, "reqora.requests.yaml");
    writeFileSync(target, `${readFileSync(target, "utf8")}\n# tampered\n`, "utf8");
    assert.equal(check().status, 1, "内容不一致时退出 1");

    writeMirrorAtomic(outDir, buildMirrorPlan(snapshot));
    rmSync(join(outDir, GIT_MIRROR_MANIFEST_FILE));
    assert.equal(check().status, 1, "文件缺失时退出 1");
  } finally {
    rmTemp(root);
  }
});
