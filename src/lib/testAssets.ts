/**
 * reqora.test.v1 测试资产投影（T2.1）。
 *
 * 纯数据变换：只接收 `redactedExportSnapshot` 处理过的快照，产出可 diff 的
 * 文档对象。渲染仍由 exportFormats.ts 的 `renderExport` 走 `toYaml` +
 * `egressText`，本模块不提供任何渲染入口、不绕过脱敏闸门。
 *
 * 字段命名一律对齐 src/types.ts；缺失的可选字段显式省略而不是补默认值；
 * 时间戳 / 运行历史 / 本机凭据值一律不带出（可 diff、可离线阅读）。
 */
import { buildMockRules } from "./mock.ts";
import { isPrivateVariable } from "./privateValues.ts";
import { SENSITIVE_NAME } from "./redact.ts";
import type {
  ApiCase,
  AssertionSpec,
  AuthSpec,
  BodySpec,
  FormPart,
  KeyValue,
  RequestDraft,
  ScenarioDataSet,
  ScenarioDbConfig,
  ScenarioStep,
  ScenarioStepSource,
  TestScenario,
  TestSuite,
  WorkspaceSnapshot,
} from "../types";

export const TEST_ASSETS_SCHEMA = "reqora.test.v1";

export type TestAssetsDocument = Record<string, unknown>;
type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 缺失字段一律省略，不给快照编造默认值。 */
export function omitUndefined(record: Json): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function projectRow(row: KeyValue): Json {
  return omitUndefined({
    id: row.id,
    key: row.key,
    value: row.value,
    enabled: row.enabled,
    secret: row.secret,
  });
}

function projectFormPart(part: FormPart): Json {
  return omitUndefined({
    id: part.id,
    key: part.key,
    // 文件字节是本机内容，不带出；只保留结构标记。
    value: part.file ? "" : part.value,
    enabled: part.enabled,
    secret: part.secret,
    file: part.file,
    fileName: part.fileName,
    contentType: part.contentType,
  });
}

function projectBody(body: BodySpec): Json {
  switch (body.type) {
    case "json":
      return { type: "json", content: body.content };
    case "raw":
      return { type: "raw", content: body.content, contentType: body.contentType };
    case "graphql":
      return { type: "graphql", query: body.query, variables: body.variables };
    case "formUrlEncoded":
      return { type: "formUrlEncoded", items: (body.items ?? []).map(projectRow) };
    case "formData":
      return { type: "formData", items: (body.items ?? []).map(projectFormPart) };
    case "binary":
      // data 是 base64 文件字节，明确省略，只留文件名与类型。
      return { type: "binary", fileName: body.fileName, contentType: body.contentType };
    default:
      return { type: "none" };
  }
}

/** 鉴权值一律占位符；只放行非敏感的结构字段（type / 端点 / region 等）。 */
function placeholderAuth(auth: AuthSpec): Json {
  switch (auth.type) {
    case "bearer":
      return { type: "bearer", token: "{{token}}" };
    case "basic":
      return { type: "basic", username: "{{username}}", password: "{{password}}" };
    case "apiKey":
      return { type: "apiKey", key: auth.key, value: "{{apiKey}}", location: auth.location };
    case "oauth2":
      return omitUndefined({
        type: "oauth2", grant: auth.grant, tokenUrl: auth.tokenUrl,
        scope: auth.scope, accessToken: "{{token}}",
      });
    case "awsSigV4":
      return {
        type: "awsSigV4", accessKeyId: "<redacted>", secretAccessKey: "<redacted>",
        region: auth.region, service: auth.service,
      };
    case "mtls":
      return omitUndefined({
        type: "mtls", serverName: auth.serverName, minTlsVersion: auth.minTlsVersion,
      });
    default:
      return { type: auth.type };
  }
}

function projectAssertion(assertion: AssertionSpec): Json {
  return omitUndefined({
    id: assertion.id,
    enabled: assertion.enabled,
    name: assertion.name,
    source: assertion.source,
    path: assertion.path,
    op: assertion.op,
    value: assertion.value,
  });
}

/** 用例里的「请求可编辑快照」：保留编辑所需字段，省略 doc / 时间戳 / 本机字节。 */
function projectRequest(request: RequestDraft): Json {
  return omitUndefined({
    id: request.id,
    name: request.name,
    method: request.method,
    url: request.url,
    folder: request.folder,
    description: request.description,
    protocol: request.protocol,
    headers: (request.headers ?? []).map(projectRow),
    query: (request.query ?? []).map(projectRow),
    body: projectBody(request.body),
    auth: placeholderAuth(request.auth),
    preScript: request.preScript,
    postScript: request.postScript,
    assertions: (request.assertions ?? []).map(projectAssertion),
  });
}

function projectCase(caseItem: ApiCase): Json {
  return omitUndefined({
    id: caseItem.id,
    requestId: caseItem.requestId,
    name: caseItem.name,
    group: caseItem.group,
    description: caseItem.description,
    enabled: caseItem.enabled,
    expectedStatus: caseItem.expectedStatus,
    request: caseItem.request ? projectRequest(caseItem.request) : undefined,
    // syncedAt / createdAt / updatedAt / lastRun 属于本机时间与运行历史，省略。
  });
}

function projectStepSource(source: ScenarioStepSource): Json {
  switch (source.kind) {
    case "case":
      return { kind: "case", caseId: source.caseId };
    case "inline":
      return { kind: "inline", request: projectRequest(source.request) };
    case "wait":
      return { kind: "wait", ms: source.ms };
    case "db":
      return { kind: "db", db: projectDbConfig(source.db) };
  }
}

function projectDbConfig(db: ScenarioDbConfig): Json {
  return omitUndefined({
    // url 是带凭据的直连串，明确省略；命名连接 id 可保留。
    connectionId: db.connectionId,
    sql: db.sql,
    mode: db.mode,
    maxRows: db.maxRows,
    extracts: (db.extracts ?? []).map((item) => omitUndefined({
      id: item.id, varName: item.varName, column: item.column, row: item.row,
    })),
    asserts: (db.asserts ?? []).map((item) => omitUndefined({
      id: item.id, target: item.target, row: item.row, column: item.column,
      op: item.op, value: item.value,
    })),
  });
}

function projectStep(step: ScenarioStep): Json {
  return omitUndefined({
    id: step.id,
    name: step.name,
    enabled: step.enabled,
    source: step.source ? projectStepSource(step.source) : undefined,
    extracts: (step.extracts ?? []).map((item) => omitUndefined({
      id: item.id, varName: item.varName, source: item.source, path: item.path,
    })),
    continueOnFailure: step.continueOnFailure,
    repeat: step.repeat ? omitUndefined({
      count: step.repeat.count, over: step.repeat.over,
      itemVar: step.repeat.itemVar, indexVar: step.repeat.indexVar,
    }) : undefined,
    condition: step.condition ? omitUndefined({
      varName: step.condition.varName, op: step.condition.op, value: step.condition.value,
    }) : undefined,
  });
}

function projectDataSet(dataSet: ScenarioDataSet): Json {
  return {
    columns: [...dataSet.columns],
    rows: dataSet.rows.map((row) => ({ ...row })),
  };
}

function projectScenario(scenario: TestScenario): Json {
  return omitUndefined({
    id: scenario.id,
    name: scenario.name,
    description: scenario.description,
    steps: (scenario.steps ?? []).map(projectStep),
    dataSet: scenario.dataSet ? projectDataSet(scenario.dataSet) : undefined,
    // createdAt / updatedAt / lastRun 省略。
  });
}

function projectSuite(suite: TestSuite): Json {
  return omitUndefined({
    id: suite.id,
    name: suite.name,
    description: suite.description,
    items: (suite.items ?? []).map((item) => omitUndefined({
      id: item.id, kind: item.kind, refId: item.refId,
    })),
    // createdAt / updatedAt / lastRun 省略。
  });
}

/** 断言规则的扁平索引：用例请求 + 场景内联请求，保持文档顺序、不去重。 */
function collectAssertions(safe: WorkspaceSnapshot): Json[] {
  const out: Json[] = [];
  const push = (request: RequestDraft | undefined): void => {
    for (const assertion of request?.assertions ?? []) out.push(projectAssertion(assertion));
  };
  for (const caseItem of safe.cases ?? []) push(caseItem.request);
  for (const scenario of safe.scenarios ?? []) {
    for (const step of scenario.steps ?? []) {
      if (step.source?.kind === "inline") push(step.source.request);
    }
  }
  return out;
}

function variableNames(safe: WorkspaceSnapshot): { all: string[]; privateNames: string[] } {
  const all = new Set<string>();
  const privateNames = new Set<string>();
  for (const environment of safe.environments ?? []) {
    for (const row of environment.variables ?? []) {
      const key = String(row?.key ?? "").trim();
      if (!key) continue;
      all.add(key);
      if (isPrivateVariable(row) || SENSITIVE_NAME.test(key)) privateNames.add(key);
    }
  }
  return { all: [...all].sort(), privateNames: [...privateNames].sort() };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";
}

/** Mock 规则由脱敏快照派生；覆盖 buildMockRules 的随机 id 为确定性 id。 */
function projectMockRules(safe: WorkspaceSnapshot): Json[] {
  return buildMockRules(safe, {}).map((rule, index) => omitUndefined({
    id: `mock-${index}-${slug(rule.method)}-${slug(rule.path)}`,
    method: rule.method,
    path: rule.path,
    status: rule.status,
    contentType: rule.contentType,
    body: rule.body,
    delayMs: rule.delayMs,
    description: rule.description,
    smart: rule.smart,
    conditions: (rule.conditions ?? []).map((item) => omitUndefined({
      source: item.source, key: item.key, op: item.op, value: item.value,
    })),
  }));
}

/** 从脱敏后的快照构造 reqora.test.v1 文档。 */
export function buildTestAssets(safe: WorkspaceSnapshot): TestAssetsDocument {
  const names = variableNames(safe);
  return omitUndefined({
    schema: TEST_ASSETS_SCHEMA,
    version: 1,
    generated_from: "Reqora",
    cases: (safe.cases ?? []).map(projectCase),
    scenarios: (safe.scenarios ?? []).map(projectScenario),
    suites: (safe.suites ?? []).map(projectSuite),
    assertionRules: collectAssertions(safe),
    scriptLibrary: (safe.scriptLibrary ?? []).map((snippet) => omitUndefined({
      id: snippet.id, name: snippet.name, description: snippet.description, code: snippet.code,
    })),
    globalPreScript: safe.settings?.globalPreScript,
    globalPostScript: safe.settings?.globalPostScript,
    mockRules: projectMockRules(safe),
    csvDataSets: (safe.scenarios ?? [])
      .filter((scenario) => !!scenario.dataSet)
      .map((scenario) => ({
        scenarioId: scenario.id,
        dataSet: projectDataSet(scenario.dataSet as ScenarioDataSet),
      })),
    privateVariableNames: names.privateNames,
    environmentVariableNames: names.all,
  });
}

// ------------------------------------------------------------- 解码侧 ----

function recordArray(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export interface DecodedTestAssets {
  document: TestAssetsDocument;
  cases: Json[];
  scenarios: Json[];
  suites: Json[];
  assertionRules: Json[];
  scriptLibrary: Json[];
  mockRules: Json[];
  csvDataSets: Json[];
  privateVariableNames: string[];
  environmentVariableNames: string[];
}

/** 解析后的文档做形状校验与分组，供 transfer.ts 的 importTestAssets 复用。 */
export function decodeTestAssets(data: unknown): DecodedTestAssets {
  if (!isRecord(data) || data.schema !== TEST_ASSETS_SCHEMA) {
    throw new Error("无法解析 reqora.test.v1：缺少 schema: reqora.test.v1");
  }
  return {
    document: data,
    cases: recordArray(data.cases),
    scenarios: recordArray(data.scenarios),
    suites: recordArray(data.suites),
    assertionRules: recordArray(data.assertionRules),
    scriptLibrary: recordArray(data.scriptLibrary),
    mockRules: recordArray(data.mockRules),
    csvDataSets: recordArray(data.csvDataSets),
    privateVariableNames: stringArray(data.privateVariableNames),
    environmentVariableNames: stringArray(data.environmentVariableNames),
  };
}
