import type {
  ScenarioDbAssert,
  ApiCase,
  CaseGroup,
  AuthSpec,
  CodeTemplate,
  Environment,
  KeyValue,
  ParamMeta,
  RequestDoc,
  RequestDraft,
  ResponseExample,
  ScenarioStepCondition,
  ScenarioStep,
  DataModel,
  DocPage,
  McpServerConfig,
  NamedDbConnection,
  RequestRevision,
  ScriptSnippet,
  TestScenario,
  TestSuite,
  TombstoneKind,
  WorkspaceSnapshot,
  WorkspaceTombstone,
} from "../types";
// Explicit .ts extensions: Node's native type stripping (bun run test) needs real
// file paths; Vite/tsc bundler resolution accepts them too.
import { DEFAULT_MERGE_CONFIG } from "./sse.ts";
import { normalizeRevisions } from "./revisions.ts";
import { uid } from "./id.ts";
import { builtinCodeTemplates } from "./codeTemplate.ts";
import { builtinDocPages, normalizeDocPages } from "./docPages.ts";
import {
  emptyDoc as emptyDocBase,
  emptyParamMeta as emptyParamMetaBase,
} from "./docDefaults.ts";
import { normalizeResponseParams } from "./responseParams.ts";

export function emptyRow(): KeyValue {
  return { id: uid(), key: "", value: "", enabled: true };
}

export function emptyParamMeta(): ParamMeta {
  return emptyParamMetaBase();
}

export function emptyResponseExample(): ResponseExample {
  return {
    id: uid(),
    name: "响应示例",
    status: 200,
    contentType: "application/json",
    body: "",
    description: "",
    params: [],
  };
}

export function emptyDoc(): RequestDoc {
  return emptyDocBase();
}

export function emptyRequest(): RequestDraft {
  return {
    id: uid(),
    name: "未命名请求",
    description: "",
    folder: "",
    protocol: "http",
    httpVersion: "auto",
    method: "GET",
    url: "",
    pathVariables: [],
    headers: [emptyRow()],
    query: [emptyRow()],
    body: { type: "none" },
    auth: { type: "none" },
    preScript: "",
    postScript: "",
    assertions: [],
    stream: "auto",
    doc: emptyDoc(),
    updatedAt: 0,
  };
}

const DOC_STATUSES = new Set(["开发中", "联调中", "已完成", "已废弃"]);

/**
 * Snapshots written by older versions have no script/assertion fields.
 * Fill them in on load so the editor never sees `undefined` and saving never
 * drops a field the user just typed.
 */
export function normalizeRequest(
  input: Partial<RequestDraft> | null | undefined,
): RequestDraft {
  // A malformed row (e.g. an interrupted MCP create_case) may have no request
  // payload at all. Normalising it to an empty draft keeps load/import from
  // throwing — that used to leave the WebView stuck on "loading workspace".
  const raw: Partial<RequestDraft> =
    input && typeof input === "object" ? input : {};
  const doc = raw.doc ?? emptyDoc();
  // `__collection` is a transient auth-resolution cache injected by the MCP
  // request finder. It embeds the whole collection and, when copied into a
  // case, explodes a few KiB of case data into tens of MiB. Never persist it.
  const { __collection: _ignored, ...clean } = raw as Partial<RequestDraft> & {
    __collection?: unknown;
  };
  return {
    ...emptyRequest(),
    ...clean,
    headers: Array.isArray(raw.headers) ? raw.headers : [emptyRow()],
    query: Array.isArray(raw.query) ? raw.query : [emptyRow()],
    // Old snapshots have no pathVariables; normalise to a stable row shape so
    // the editor never sees undefined and saving never drops typed values.
    pathVariables: Array.isArray(raw.pathVariables)
      ? raw.pathVariables
          .filter((item: Partial<KeyValue>) => !!item && typeof item.key === "string")
          .map((item: Partial<KeyValue>) => ({
            id: typeof item.id === "string" && item.id ? item.id : `path:${item.key}`,
            key: item.key as string,
            value: typeof item.value === "string" ? item.value : "",
            enabled: item.enabled !== false,
            // Keep the tri-state upload-redaction override. Omit the key when
            // unset so stableStringify does not see an extra `secret: undefined`.
            ...(item.secret === undefined ? {} : { secret: item.secret }),
          }))
      : [],
    body: raw.body ?? { type: "none" },
    auth: raw.auth ?? { type: "none" },
    description: raw.description ?? "",
    folder: raw.folder ?? "",
    protocol:
      raw.protocol === "http" || raw.protocol === "ws" || raw.protocol === "tcp" ||
      raw.protocol === "mqtt" || raw.protocol === "soap"
        ? raw.protocol
        : "http",
    preScript: raw.preScript ?? "",
    postScript: raw.postScript ?? "",
    assertions: Array.isArray(raw.assertions) ? raw.assertions : [],
    stream: raw.stream === "on" || raw.stream === "off" ? raw.stream : "auto",
    doc: {
      ...emptyDoc(),
      ...doc,
      status: DOC_STATUSES.has(doc.status) ? doc.status : "开发中",
      tags: Array.isArray(doc.tags) ? doc.tags : [],
      paramMeta: doc.paramMeta && typeof doc.paramMeta === "object" ? doc.paramMeta : {},
      // 旧版快照的响应示例没有字段定义：补空数组，保证编辑表格永远有稳定形状。
      // 只用确定性默认值：归一化不能凭空生成随机 id，否则同一份快照两次读取
      // 会被判定为内容不同（协作空间 diff / 修订历史指纹）。
      responses: Array.isArray(doc.responses)
        ? doc.responses
            .filter(
              (item): item is ResponseExample =>
                !!item && typeof item === "object" && !Array.isArray(item),
            )
            .map((item, index) => ({
              ...item,
              id: typeof item.id === "string" && item.id ? item.id : `response-${index + 1}`,
              name: typeof item.name === "string" ? item.name : "响应示例",
              status: typeof item.status === "number" ? item.status : 200,
              contentType: typeof item.contentType === "string" ? item.contentType : "application/json",
              body: typeof item.body === "string" ? item.body : "",
              description: typeof item.description === "string" ? item.description : "",
              params: normalizeResponseParams(item.params),
            }))
        : [],
      updatedAt: typeof doc.updatedAt === "number" ? doc.updatedAt : 0,
    },
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
    contentUpdatedAt:
      typeof raw.contentUpdatedAt === "number"
        ? raw.contentUpdatedAt
        : typeof raw.updatedAt === "number"
          ? raw.updatedAt
          : 0,
  };
}

const CASE_GROUP_SET = new Set(["正向", "负向", "边界值", "安全性", "其他"]);

export function normalizeCase(raw: ApiCase): ApiCase {
  const group: CaseGroup = CASE_GROUP_SET.has(raw.group) ? raw.group : "其他";
  const lastRun = raw.lastRun;
  return {
    ...raw,
    request: normalizeRequest(raw.request),
    group,
    enabled: raw.enabled !== false,
    description: raw.description ?? "",
    expectedStatus: typeof raw.expectedStatus === "number" ? raw.expectedStatus : undefined,
    syncedAt: typeof raw.syncedAt === "number" ? raw.syncedAt : 0,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
    lastRun:
      lastRun && typeof lastRun.at === "number"
        ? lastRun
        : undefined,
  };
}

const SCENARIO_SOURCE_SET = new Set(["json", "header", "status"]);

function normalizeScenarioStep(raw: ScenarioStep): ScenarioStep {
  const source: ScenarioStep["source"] =
    raw.source?.kind === "inline"
      ? { kind: "inline", request: normalizeRequest(raw.source.request) }
      : raw.source?.kind === "db"
        ? {
            kind: "db",
            db: {
              url: typeof raw.source.db?.url === "string" ? raw.source.db.url : "",
              connectionId:
                typeof raw.source.db?.connectionId === "string" && raw.source.db.connectionId
                  ? raw.source.db.connectionId
                  : undefined,
              sql: typeof raw.source.db?.sql === "string" ? raw.source.db.sql : "",
              mode: raw.source.db?.mode === "execute" ? "execute" : "query",
              maxRows:
                typeof raw.source.db?.maxRows === "number" ? raw.source.db.maxRows : undefined,
              extracts: (raw.source.db?.extracts ?? []).map((extract: { id?: string; varName?: string; column?: string; row?: number }) => ({
                id: extract.id || uid(),
                varName: typeof extract.varName === "string" ? extract.varName : "",
                column: typeof extract.column === "string" ? extract.column : "",
                row: typeof extract.row === "number" ? extract.row : 0,
              })),
              asserts: (raw.source.db?.asserts ?? []).map((assertion: { id?: string; target?: string; row?: number; column?: string; op?: string; value?: string }) => ({
                id: assertion.id || uid(),
                target: (assertion.target === "cell"
                  ? "cell"
                  : "rows") as ScenarioDbAssert["target"],
                row: typeof assertion.row === "number" ? assertion.row : 0,
                column: typeof assertion.column === "string" ? assertion.column : "",
                op: (typeof assertion.op === "string"
                  ? assertion.op
                  : "eq") as ScenarioDbAssert["op"],
                value: typeof assertion.value === "string" ? assertion.value : "",
              })),
            },
          }
      : raw.source?.kind === "wait"
        ? {
            kind: "wait",
            ms:
              typeof raw.source.ms === "number" && Number.isFinite(raw.source.ms)
                ? Math.min(Math.max(Math.floor(raw.source.ms), 0), 60000)
                : 1000,
          }
        : { kind: "case", caseId: String(raw.source?.caseId ?? "") };
  const repeat =
    raw.repeat && (typeof raw.repeat.count === "number" || typeof raw.repeat.over === "string")
      ? {
          count: typeof raw.repeat.count === "number" ? raw.repeat.count : undefined,
          over: typeof raw.repeat.over === "string" ? raw.repeat.over : undefined,
          itemVar: typeof raw.repeat.itemVar === "string" ? raw.repeat.itemVar : undefined,
          indexVar: typeof raw.repeat.indexVar === "string" ? raw.repeat.indexVar : undefined,
        }
      : undefined;
  const condition =
    raw.condition && typeof raw.condition.varName === "string" && raw.condition.varName.trim()
      ? {
          varName: raw.condition.varName,
          op: ([
            "eq",
            "ne",
            "gt",
            "gte",
            "lt",
            "lte",
            "contains",
            "exists",
          ].includes(raw.condition.op)
            ? raw.condition.op
            : "eq") as ScenarioStepCondition["op"],
          value: typeof raw.condition.value === "string" ? raw.condition.value : "",
        }
      : undefined;
  return {
    ...raw,
    name: typeof raw.name === "string" ? raw.name : "步骤",
    enabled: raw.enabled !== false,
    source,
    extracts: (raw.extracts ?? []).map((extract) => ({
      ...extract,
      id: extract.id || uid(),
      varName: typeof extract.varName === "string" ? extract.varName : "",
      source: SCENARIO_SOURCE_SET.has(extract.source) ? extract.source : "json",
      path: typeof extract.path === "string" ? extract.path : "",
    })),
    continueOnFailure: raw.continueOnFailure === true,
    repeat,
    condition,
  };
}

export function normalizeScenario(raw: TestScenario): TestScenario {
  const lastRun = raw.lastRun;
  const dataSet =
    raw.dataSet && Array.isArray(raw.dataSet.columns) && Array.isArray(raw.dataSet.rows)
      ? {
          columns: raw.dataSet.columns.filter(
            (column: unknown): column is string => typeof column === "string" && column.trim() !== "",
          ),
          rows: raw.dataSet.rows.filter(
            (row: unknown): row is Record<string, string> =>
              row !== null && typeof row === "object" && !Array.isArray(row),
          ),
        }
      : undefined;
  return {
    ...raw,
    name: typeof raw.name === "string" ? raw.name : "未命名场景",
    description: typeof raw.description === "string" ? raw.description : "",
    steps: (raw.steps ?? []).map(normalizeScenarioStep),
    dataSet: dataSet && dataSet.columns.length > 0 ? dataSet : undefined,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
    lastRun:
      lastRun && typeof lastRun.at === "number" && Array.isArray(lastRun.steps)
        ? lastRun
        : undefined,
  };
}

/**
 * A collection has no parent: `inherit` and malformed values degrade to none.
 * OAuth2 / AWS SigV4 / mTLS 等新变体按 type 字符串原样透传，不降级为 none。
 */
function normalizeCollectionAuth(raw: unknown): AuthSpec {
  if (!raw || typeof raw !== "object") return { type: "none" };
  const auth = raw as Record<string, unknown>;
  if (typeof auth.type !== "string" || auth.type === "inherit") return { type: "none" };
  return auth as unknown as AuthSpec;
}

const TOMBSTONE_KINDS = new Set<TombstoneKind>([
  "folder",
  "request",
  "environment",
  "case",
  "scenario",
  "suite",
  "docPage",
  "dataModel",
  "scriptSnippet",
  "codeTemplate",
]);

/** 墓碑只保留合法 kind + 非空 id；同 id 多次删除取最新时间。 */
function normalizeTombstones(raw: unknown): WorkspaceTombstone[] {
  if (!Array.isArray(raw)) return [];
  const merged = new Map<string, WorkspaceTombstone>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Partial<WorkspaceTombstone>;
    if (typeof candidate.kind !== "string" || !TOMBSTONE_KINDS.has(candidate.kind as TombstoneKind)) {
      continue;
    }
    if (typeof candidate.id !== "string" || !candidate.id) continue;
    const updatedAt =
      typeof candidate.updatedAt === "number" && candidate.updatedAt > 0 ? candidate.updatedAt : 0;
    const key = `${candidate.kind}:${candidate.id}`;
    const previous = merged.get(key);
    if (!previous || updatedAt > previous.updatedAt) {
      merged.set(key, { kind: candidate.kind as TombstoneKind, id: candidate.id, updatedAt });
    }
  }
  return [...merged.values()];
}

export function normalizeSnapshot(raw: WorkspaceSnapshot): WorkspaceSnapshot {
  const base = emptySnapshot();
  return {
    ...base,
    ...raw,
    collections: (raw.collections ?? []).map((collection) => ({
      ...collection,
      auth: normalizeCollectionAuth(collection.auth),
      items: (collection.items ?? []).map((item) => normalizeRequest(item)),
    })),
    environments: (raw.environments ?? []).map((environment: Environment) => ({
      ...environment,
      variables: Array.isArray(environment.variables) ? environment.variables : [],
      // 旧快照没有全局 Header 字段，补空数组避免 UI / 合并逻辑读到 undefined。
      headers: Array.isArray(environment.headers) ? environment.headers : [],
    })),
    history: (raw.history ?? []).map((entry) => ({
      ...entry,
      request: normalizeRequest(entry.request),
    })),
    cases: (raw.cases ?? []).map(normalizeCase),
    scenarios: (raw.scenarios ?? []).map(normalizeScenario),
    trash: (raw.trash ?? []).map((entry) => ({
      ...entry,
      deletedAt: typeof entry.deletedAt === "number" ? entry.deletedAt : 0,
    })),
    mcpServers: (raw.mcpServers ?? []).map((server) => ({
      ...server,
      args: Array.isArray(server.args) ? server.args : [],
      env: server.env ?? {},
      headers: server.headers ?? {},
    })),
    dataModels: (raw.dataModels ?? []).map((model) => ({
      ...model,
      name: typeof model.name === "string" ? model.name : "未命名模型",
      description: typeof model.description === "string" ? model.description : "",
      schemaText: typeof model.schemaText === "string" ? model.schemaText : "",
      updatedAt: typeof model.updatedAt === "number" ? model.updatedAt : 0,
    })),
    suites: (raw.suites ?? []).map((suite) => ({      ...suite,
      name: typeof suite.name === "string" ? suite.name : "未命名套件",
      description: typeof suite.description === "string" ? suite.description : "",
      items: (suite.items ?? [])
        .filter(
          (item: { kind?: unknown; refId?: unknown }) =>
            (item?.kind === "case" || item?.kind === "scenario") && typeof item.refId === "string",
        )
        .map((item: { id?: string; kind: "case" | "scenario"; refId: string }) => ({
          id: item.id || uid(),
          kind: item.kind,
          refId: item.refId,
        })),
      createdAt: typeof suite.createdAt === "number" ? suite.createdAt : 0,
      updatedAt: typeof suite.updatedAt === "number" ? suite.updatedAt : 0,
      lastRun:
        suite.lastRun && typeof suite.lastRun.at === "number" && Array.isArray(suite.lastRun.items)
          ? suite.lastRun
          : undefined,
    })),
    revisions: normalizeRevisions(raw.revisions),
    scriptLibrary: (raw.scriptLibrary ?? []).map((snippet) => ({
      ...snippet,
      name: typeof snippet.name === "string" ? snippet.name : "未命名片段",
      description: typeof snippet.description === "string" ? snippet.description : "",
      code: typeof snippet.code === "string" ? snippet.code : "",
    })),
    codeTemplates: (raw.codeTemplates ?? [])
      .filter((item: CodeTemplate) => !!item && typeof item.id === "string")
      .map((item: CodeTemplate) => ({
        ...item,
        name: typeof item.name === "string" ? item.name : "未命名模板",
        description: typeof item.description === "string" ? item.description : "",
        content: typeof item.content === "string" ? item.content : "",
        language: typeof item.language === "string" ? item.language : "",
      })),
    // 旧快照没有公共章节；归一化后 UI 与导出都不必处理 undefined。
    docPages: normalizeDocPages(raw.docPages),
    dbConnections: (raw.dbConnections ?? [])
      .filter(
        (item: { id?: unknown; name?: unknown; url?: unknown }) =>
          typeof item?.id === "string" &&
          typeof item?.name === "string" &&
          typeof item?.url === "string",
      )
      .map((item: { id: string; name: string; url: string; description?: unknown }) => ({
        id: item.id,
        name: item.name,
        url: item.url,
        description: typeof item.description === "string" ? item.description : "",
      })),
    tombstones: normalizeTombstones(raw.tombstones),
    settings: {
      ...base.settings,
      ...(raw.settings ?? {}),
      sseMerge: { ...DEFAULT_MERGE_CONFIG, ...(raw.settings?.sseMerge ?? {}) },
      globalPreScript:
        typeof raw.settings?.globalPreScript === "string" ? raw.settings.globalPreScript : "",
      globalPostScript:
        typeof raw.settings?.globalPostScript === "string" ? raw.settings.globalPostScript : "",
      proxyUrl:
        typeof raw.settings?.proxyUrl === "string" ? raw.settings.proxyUrl : "",
    },
    theme: raw.theme === "dark" ? "dark" : "light",
  };
}

export function emptySnapshot(): WorkspaceSnapshot {
  return {
    version: 1,
    seeded: false,
    collections: [],
    environments: [],
    activeEnvironmentId: null,
    history: [],
    cases: [],
    scenarios: [],
    trash: [],
    mcpServers: [],
    dataModels: [],
    suites: [],
    revisions: {},
    scriptLibrary: [],
    codeTemplates: [],
    docPages: [],
    dbConnections: [],
    settings: { timeoutSecs: 30, followRedirects: true, verifyTls: true, manageCookies: true, httpVersion: "auto" },
    theme: "light",
  };
}

/** First-run sample data, deliberately built around {{variables}} and scripts. */
export function seedSnapshot(): WorkspaceSnapshot {
  const environmentId = uid();
  const collectionId = uid();
  const postRequestId = uid();
  const now = Date.now();

  const postRequest: RequestDraft = {
    ...emptyRequest(),
    id: postRequestId,
    name: "POST JSON 示例",
    description: "演示前置脚本注入请求头与变量",
    updatedAt: now,
    method: "POST",
    url: "{{baseUrl}}/post",
    headers: [
      {
        id: uid(),
        key: "X-Client",
        value: "Reqora",
        enabled: true,
      },
      emptyRow(),
    ],
    body: { type: "json", content: '{\n  "hello": "world"\n}' },
    preScript:
      '// 前置脚本：在请求交给 Rust 发出之前执行\nsetHeader("X-Trace-Id", uuid());\nsetVar("sentAt", String(now()));\nlog("prepared at " + getVar("sentAt"));',
    postScript:
      'test("返回 2xx", function () {\n  assert(response.status < 400, "status " + response.status);\n});',
    assertions: [
      {
        id: uid(),
        enabled: true,
        name: "延迟低于 3000ms",
        source: "latency",
        path: "$",
        op: "lt",
        value: "3000",
      },
    ],
    doc: {
      summary: "回显请求体，用于验证 JSON 提交链路",
      description:
        "## 接口说明\n\n把请求体原样回显，用于验证 `{{baseUrl}}` 变量替换、前置脚本注入与断言链路。\n\n- `hello` 字段会出现在响应的 `json` 中\n- 前置脚本注入 `X-Trace-Id`",
      owner: "平台组",
      status: "已完成",
      tags: ["回显", "调试"],
      paramMeta: {},
      responses: [
        {
          id: uid(),
          name: "成功响应",
          status: 200,
          contentType: "application/json",
          body: '{\n  "args": {},\n  "data": "{\\"hello\\":\\"world\\"}",\n  "json": { "hello": "world" }\n}',
          description: "httpbin.org /post 的标准回显结构",
        },
      ],
      updatedAt: now,
    },
  };

  const makeCase = (
    name: string,
    group: CaseGroup,
    patch: Partial<RequestDraft>,
    expectedStatus: number | undefined,
    description: string,
  ): ApiCase => {
    const at = Date.now();
    return {
      id: uid(),
      requestId: postRequestId,
      name,
      group,
      description,
      enabled: true,
      request: { ...normalizeRequest(postRequest), ...patch, id: uid(), name: "请求" },
      expectedStatus,
      syncedAt: now,
      createdAt: at,
      updatedAt: at,
    };
  };

  const happyCase = makeCase(
    "正常提交",
    "正向",
    { body: { type: "json", content: '{\n  "hello": "world"\n}' } },
    200,
    "标准字段，期望 200 且 json.hello 回显",
  );
  const emptyCase = makeCase(
    "空对象请求体",
    "边界值",
    { body: { type: "json", content: "{}" } },
    200,
    "空 JSON 也应被回显",
  );
  const badCase = makeCase(
    "非法 JSON 请求体",
    "负向",
    { body: { type: "json", content: "{not-json}" } },
    undefined,
    "服务端应返回 4xx 或网关报错；用于观察错误链路",
  );

  const scenarioStep = (name: string, caseId: string, extracts: ScenarioStep["extracts"]): ScenarioStep => ({
    id: uid(),
    name,
    enabled: true,
    source: { kind: "case", caseId },
    extracts,
    continueOnFailure: false,
  });

  const scenario: TestScenario = {
    id: uid(),
    name: "示例场景 · 回显链路",
    description:
      "跨接口的测试场景演示：第 1 步提取响应字段到场景变量，第 2 步通过 {{greeting}} 引用上一步结果。",
    steps: [
      scenarioStep("提交并提取回显字段", happyCase.id, [
        { id: uid(), varName: "greeting", source: "json", path: "$.json.hello" },
      ]),
      scenarioStep("空对象也应 200", emptyCase.id, []),
      scenarioStep("非法 JSON 观察 4xx", badCase.id, []),
    ],
    createdAt: now,
    updatedAt: now,
  };

  return {
    version: 1,
    seeded: true,
    trash: [],
    collections: [
      {
        id: collectionId,
        name: "示例集合",
        items: [
          {
            ...emptyRequest(),
            name: "GET 请求示例",
            description: "演示变量替换与响应断言",
            url: "{{baseUrl}}/get",
            query: [
              { id: uid(), key: "page", value: "1", enabled: true },
              emptyRow(),
            ],
            assertions: [
              {
                id: uid(),
                enabled: true,
                name: "状态码 200",
                source: "status",
                path: "$",
                op: "eq",
                value: "200",
              },
            ],
            postScript:
              '// 后置脚本：读取 response、写日志、跑命名测试\nlog("status = " + response.status);\ntest("响应成功", function () {\n  assert(response.ok, "服务器返回 " + response.status);\n});',
            doc: {
              ...emptyDoc(),
              summary: " GET 回显查询参数",
              description: "把 query 参数回显在 `args` 里，用于验证变量替换。",
              status: "已完成",
              updatedAt: now,
            },
            updatedAt: now,
          },
          postRequest,
          {
            ...emptyRequest(),
            name: "Bearer 鉴权示例",
            description: "凭据用环境变量，不写死在请求里",
            updatedAt: now,
            url: "{{baseUrl}}/headers",
            auth: { type: "bearer", token: "{{token}}" },
          },
          {
            ...emptyRequest(),
            name: "SSE 流式示例（先启动本地服务）",
            description: "运行 node examples/sse-server.mjs 后发送，体验实时合并与时间线",
            folder: "流式/SSE",
            updatedAt: now,
            method: "POST",
            url: "{{sseUrl}}/v1/chat/completions",
            stream: "on",
            headers: [
              { id: uid(), key: "Content-Type", value: "application/json", enabled: true },
              { id: uid(), key: "Accept", value: "text/event-stream", enabled: true },
              emptyRow(),
            ],
            body: {
              type: "json",
              content:
                '{\n  "model": "demo",\n  "stream": true,\n  "messages": [{"role": "user", "content": "写一句关于春天的话"}]\n}',
            },
            postScript:
              '// 流式结束后 response.sse 里是已提前拼接好的文本\nlog("merged length = " + (response.sse ? response.sse.mergedText.length : 0));\ntest("合并出可读文本", function () {\n  assert(response.sse && response.sse.mergedText.length > 0, "没有合并文本");\n});',
            assertions: [
              {
                id: uid(),
                enabled: true,
                name: "状态码 200",
                source: "status",
                path: "$",
                op: "eq",
                value: "200",
              },
            ],
          },
          {
            ...emptyRequest(),
            name: "WebSocket 回显示例",
            description: "连接后发送任意 JSON 消息，服务器会原样回显（需先启动回显服务）",
            folder: "流式/WS",
            protocol: "ws",
            updatedAt: now,
            url: "ws://127.0.0.1:8789/echo",
            headers: [emptyRow()],
          },
        ],
      },
    ],
    cases: [happyCase, emptyCase, badCase],
    scenarios: [scenario],
    environments: [
      {
        id: environmentId,
        name: "示例环境",
        variables: [
          {
            id: uid(),
            key: "baseUrl",
            value: "https://httpbin.org",
            enabled: true,
          },
          { id: uid(), key: "token", value: "demo-token", enabled: true },
          { id: uid(), key: "sseUrl", value: "http://127.0.0.1:8788", enabled: true },
          emptyRow(),
        ],
        headers: [emptyRow()],
      },
    ],
    activeEnvironmentId: environmentId,
    history: [],
    codeTemplates: builtinCodeTemplates(),
    docPages: builtinDocPages(),
    settings: { timeoutSecs: 30, followRedirects: true, verifyTls: true, manageCookies: true, httpVersion: "auto" },
    theme: "light",
  };
}

// ---------------------------------------------- 模块级空集合常量 ----
//
// zustand selector 里写 `snapshot.dataModels ?? []`，字段缺失时每次调用都会
// 产生新数组引用，useSyncExternalStore 判定状态变化 → 无限重渲染
// （React #185，曾表现为数据目录为空时启动白屏）。统一用这里的冻结常量。

export const EMPTY_DATA_MODELS = Object.freeze([]) as unknown as DataModel[];
export const EMPTY_DOC_PAGES = Object.freeze([]) as unknown as DocPage[];
export const EMPTY_MCP_SERVERS = Object.freeze([]) as unknown as McpServerConfig[];
export const EMPTY_SUITES = Object.freeze([]) as unknown as TestSuite[];
export const EMPTY_DB_CONNECTIONS = Object.freeze([]) as unknown as NamedDbConnection[];
export const EMPTY_SCRIPT_LIBRARY = Object.freeze([]) as unknown as ScriptSnippet[];
export const EMPTY_REVISIONS = Object.freeze({}) as Record<string, RequestRevision[]>;
