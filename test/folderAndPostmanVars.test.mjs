/**
 * 新增能力回归测试：
 * 1. 多层级文件夹创建 / 删除 / 改名 / 跨集合移动（Collection.folders 显式空文件夹）
 * 2. 文件夹列表进入移动目标（importTarget.listFolderPaths）
 * 3. Postman 导入的变量转换（::name、已声明 :name 路径变量、{{$动态变量}} 映射）
 * 4. 空文件夹列表在行模型（同步协议）里的往返
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  createFolderInTree,
  deleteFolderInTree,
  renameFolderInTree,
  moveFolderInTree,
} from "../src/lib/collectionTree.ts";
import { listFolderPaths } from "../src/lib/importTarget.ts";
import { importPostman } from "../src/lib/transfer.ts";
import { snapshotToRows, rowsToSnapshot } from "../src/lib/workspaceRows.ts";

const collection = (overrides = {}) => ({
  id: "c1",
  name: "示例集合",
  items: [],
  ...overrides,
});

const request = (id, folder) => ({
  id,
  name: id,
  folder,
  method: "GET",
  url: "https://example.com",
  headers: [],
  query: [],
  body: { type: "none" },
  auth: { type: "none" },
  updatedAt: 0,
});

// ------------------------------------------------------- 文件夹创建 / 删除 ----

test("createFolderInTree 登记路径与全部祖先，支持多层级", () => {
  const next = createFolderInTree([collection()], "c1", "用户/订单/详情");
  const folders = next[0].folders;
  assert.deepEqual(folders.sort(), ["用户", "用户/订单", "用户/订单/详情"]);
});

test("createFolderInTree 幂等，未知集合与空路径 no-op", () => {
  const base = [collection({ folders: ["用户"] })];
  assert.equal(createFolderInTree(base, "c1", "用户"), base);
  assert.equal(createFolderInTree(base, "c1", "  "), base);
  assert.equal(createFolderInTree(base, "missing", "a"), base);
});

test("deleteFolderInTree 移除子孙路径并把请求上移到父文件夹", () => {
  const base = [
    collection({
      items: [
        request("r1", "用户/订单/详情"),
        request("r2", "用户"),
        request("r3", ""),
      ],
      folders: ["用户", "用户/订单", "用户/订单/详情", "其他"],
    }),
  ];
  const next = deleteFolderInTree(base, "c1", "用户/订单");
  assert.deepEqual(next[0].folders, ["用户", "其他"]);
  // 被删文件夹的直接请求上移到 用户；更深一层（订单/详情）保留自己的子路径。
  assert.equal(next[0].items.find((r) => r.id === "r1").folder, "用户/详情");
  assert.equal(next[0].items.find((r) => r.id === "r2").folder, "用户");
});

test("deleteFolderInTree 根层级文件夹的请求回到集合根目录", () => {
  const base = [collection({ items: [request("r1", "用户")], folders: ["用户"] })];
  const next = deleteFolderInTree(base, "c1", "用户");
  assert.deepEqual(next[0].folders, []);
  assert.equal(next[0].items[0].folder, "");
});

test("renameFolderInTree 级联改名显式文件夹列表", () => {
  const base = [collection({ folders: ["用户", "用户/订单"] })];
  const next = renameFolderInTree(base, "c1", "用户", "客户");
  assert.deepEqual(next[0].folders.sort(), ["客户", "客户/订单"]);
});

test("moveFolderInTree 跨集合移动时空文件夹跟随", () => {
  const base = [
    collection({ id: "c1", items: [], folders: ["用户", "用户/订单"] }),
    collection({ id: "c2", items: [], folders: [] }),
  ];
  const next = moveFolderInTree(
    base,
    { collectionId: "c1", path: "用户" },
    { collectionId: "c2", folder: "商城" },
  );
  assert.deepEqual(next[0].folders, []);
  assert.deepEqual(next[1].folders.sort(), ["商城", "商城/用户", "商城/用户/订单"]);
});

test("listFolderPaths 包含显式空文件夹（含祖先）", () => {
  const paths = listFolderPaths(
    [collection({ items: [request("r1", "用户/订单")], folders: ["配置"] })],
    "c1",
  );
  // listFolderPaths 对结果按 localeCompare 排序，顺序随运行 locale 变化，
  // 契约是「包含哪些路径」而非固定顺序——用集合比较，避免把排序实现细节写死。
  assert.deepEqual(new Set(paths), new Set(["配置", "用户", "用户/订单"]));
  assert.equal(paths.length, 3);
});

// ------------------------------------------------- Postman 变量转换 ----

const POSTMAN_MIXED = JSON.stringify({
  info: { name: "变量集合", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  variable: [
    { key: "baseUrl", value: "https://api.example.com" },
    { key: "token", value: "abc" },
    { key: "userId", value: "42" },
  ],
  item: [
    {
      name: "旧写法",
      request: {
        method: "GET",
        url: { raw: "::baseUrl/api/v1/users", host: ["::baseUrl"], path: ["api", "v1", "users"] },
      },
    },
    {
      name: "路径变量",
      request: {
        method: "GET",
        url: {
          raw: "{{baseUrl}}/users/:userId",
          host: ["{{baseUrl}}"],
          path: ["users", ":userId"],
          variable: [{ key: "userId", value: "42" }],
        },
      },
    },
    {
      name: "动态变量",
      request: {
        method: "GET",
        url: { raw: "{{baseUrl}}/now?ts={{$timestamp}}&id={{$randomUUID}}", host: ["{{baseUrl}}"], path: ["now"] },
      },
    },
    {
      name: "未声明路径参数",
      request: {
        method: "GET",
        url: { raw: "{{baseUrl}}/users/:id", host: ["{{baseUrl}}"], path: ["users", ":id"] },
      },
    },
  ],
});

test("Postman ::name 写法归一化为 {{name}}", () => {
  const result = importPostman(POSTMAN_MIXED);
  assert.equal(result.collections[0].items[0].url, "{{baseUrl}}/api/v1/users");
});

test("已声明且有默认值的 :name 路径变量转为 {{name}} 并登记进环境", () => {
  const result = importPostman(POSTMAN_MIXED);
  const item = result.collections[0].items[1];
  assert.equal(item.url, "{{baseUrl}}/users/{{userId}}");
  const env = result.environments[0];
  assert.ok(env.variables.some((v) => v.key === "userId" && v.value === "42"));
});

test("Postman 动态变量导入：仅毫秒时间戳改写，其余保留原生写法", () => {
  const result = importPostman(POSTMAN_MIXED);
  const item = result.collections[0].items[2];
  // query 在 parsePostmanUrl 里拆成独立数组，占位符转换同样生效。
  assert.equal(item.url, "{{baseUrl}}/now");
  assert.deepEqual(
    item.query.map((q) => [q.key, q.value]),
    [["ts", "{{$timestampMs}}"], ["id", "{{$randomUUID}}"]],
  );
});

test("未声明的 :name 保留为 Reqora 路径参数，未知动态变量给 warning", () => {
  const result = importPostman(POSTMAN_MIXED);
  // :id 没有在 url.variable 或集合变量里声明，保留为路径参数。
  assert.equal(result.collections[0].items[3].url, "{{baseUrl}}/users/:id");
  // 集合里没有未知动态变量时不应误报；再验一个带未知 token 的集合。
  const withUnknown = importPostman(
    JSON.stringify({
      info: { name: "x", schema: "v2.1.0" },
      item: [
        {
          name: "r",
          request: { method: "GET", url: { raw: "https://a.b/?x={{$randomThingy}}", host: ["a.b"] } },
        },
      ],
    }),
  );
  assert.ok(withUnknown.warnings.some((w) => w.includes("{{$randomThingy}}")));
});

// ------------------------------------------------- 行模型 folders 往返 ----

test("Collection.folders 经行模型拆行 / 重组后保留", () => {
  const snapshot = {
    collections: [
      collection({
        id: "c1",
        items: [request("r1", "用户")],
        folders: ["用户", "配置"],
        updatedAt: 123,
      }),
    ],
    environments: [],
    cases: [],
    scenarios: [],
    suites: [],
    history: [],
    trash: [],
    settings: { timeoutSecs: 30, followRedirects: true, verifyTls: true },
  };
  const rows = snapshotToRows(snapshot);
  const folderRow = rows.folders[0];
  assert.deepEqual(folderRow.data.folders, ["用户", "配置"]);
  const rebuilt = rowsToSnapshot(rows);
  assert.deepEqual(rebuilt.collections[0].folders, ["用户", "配置"]);
  // 无空文件夹时 data 是空对象，重组后不带 folders 字段。
  const rows2 = snapshotToRows({ ...snapshot, collections: [collection({ id: "c1", items: [] })] });
  assert.deepEqual(rows2.folders[0].data, {});
});
