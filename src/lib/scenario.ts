import type {
  ApiCase,
  DbQueryResult,
  RequestDraft,
  ResponseData,
  ScenarioDbConfig,
  ScenarioExtract,
  ScenarioRunSummary,
  ScenarioStep,
  ScenarioStepCondition,
  ScenarioStepRepeat,
  ScenarioStepResult,
  TestScenario,
} from "../types.ts";
import { selectPath } from "./scripts.ts";
import { substitute } from "./template.ts";
import { uid } from "./id.ts";

/**
 * Test scenarios are ordered chains of steps (a case reference or an inline
 * request). Steps share a scenario-level variable table: each step can pull
 * values out of its response (extract) and later steps read them via
 * {{varName}} — the Apifox "引用前置步骤运行结果" pattern, local-first.
 */

export function newScenario(name = "新场景"): TestScenario {
  const now = Date.now();
  return {
    id: uid(),
    name,
    description: "",
    steps: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function stepFromCase(caseItem: ApiCase, name?: string): ScenarioStep {
  return {
    id: uid(),
    name: name?.trim() || caseItem.name,
    enabled: true,
    source: { kind: "case", caseId: caseItem.id },
    extracts: [],
    continueOnFailure: false,
  };
}

export function stepFromRequest(request: RequestDraft, name?: string): ScenarioStep {
  return {
    id: uid(),
    name: name?.trim() || request.name,
    enabled: true,
    // Deep copy: an inline step owns its request definition.
    source: { kind: "inline", request: JSON.parse(JSON.stringify(request)) as RequestDraft },
    extracts: [],
    continueOnFailure: false,
  };
}

/** Resolve a step to the request it will actually send, or null if dangling. */
export function resolveStepRequest(step: ScenarioStep, cases: ApiCase[]): RequestDraft | null {
  if (step.source.kind === "db" || step.source.kind === "wait") return null;
  const source = step.source;
  if (source.kind === "inline") return source.request;
  const caseItem = cases.find((item) => item.id === source.caseId);
  return caseItem ? caseItem.request : null;
}

/**
 * The original interface id behind a case step. A case request is a copy with
 * a fresh id, so `auth: inherit` cannot be resolved from `request.id` alone —
 * pass this alongside `resolveStepRequest()` to `resolveRequestAuth()`.
 * Inline steps keep the interface id and therefore return undefined.
 */
export function resolveStepOwnerRequestId(
  step: ScenarioStep,
  cases: ApiCase[],
): string | undefined {
  const source = step.source;
  if (source.kind !== "case") return undefined;
  const caseItem = cases.find((item) => item.id === source.caseId);
  return caseItem?.requestId;
}

// ---- P0-2 场景编排：循环 / 条件 / 等待 ----

/** 每轮循环需要绑定的变量与展示标签。 */
export interface RepeatIteration {
  bindings: Record<string, string>;
  label: string;
}

/** 单步循环上限，避免场景把变量表或请求打爆。 */
export const MAX_STEP_ITERATIONS = 100;

/**
 * 由步骤的 repeat 配置计算迭代计划（纯函数）。
 * - 未配置：单次迭代，无绑定。
 * - count：固定次数，indexVar（可选）绑定 0 起下标。
 * - over：从变量表取 JSON 数组遍历，itemVar / indexVar 绑定元素与下标。
 * 抛错表示配置无效（变量缺失 / 不是数组 / 超上限），调用方应把该步标记失败。
 */
export function computeRepeatIterations(
  repeat: ScenarioStepRepeat | undefined,
  vars: Record<string, string>,
): RepeatIteration[] {
  if (!repeat || (repeat.count === undefined && !repeat.over)) {
    return [{ bindings: {}, label: "" }];
  }

  if (repeat.over) {
    const raw = vars[repeat.over];
    if (raw === undefined) {
      throw new Error(`循环遍历失败：场景变量 ${repeat.over} 不存在`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`循环遍历失败：变量 ${repeat.over} 不是合法 JSON 数组`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`循环遍历失败：变量 ${repeat.over} 的值不是数组`);
    }
    if (parsed.length > MAX_STEP_ITERATIONS) {
      throw new Error(`循环遍历失败：数组长度 ${parsed.length} 超过单步上限 ${MAX_STEP_ITERATIONS}`);
    }
    const itemVar = repeat.itemVar?.trim() || "item";
    const indexVar = repeat.indexVar?.trim();
    return parsed.map((item, index) => ({
      bindings: {
        [itemVar]: item === null || item === undefined ? "null" : typeof item === "object" ? JSON.stringify(item) : String(item),
        ...(indexVar ? { [indexVar]: String(index) } : {}),
      },
      label: `${repeat.over}[${index}]`,
    }));
  }

  const count = Math.floor(repeat.count ?? 1);
  if (!Number.isFinite(count) || count < 1) {
    throw new Error(`循环次数无效：${repeat.count}`);
  }
  if (count > MAX_STEP_ITERATIONS) {
    throw new Error(`循环次数 ${count} 超过单步上限 ${MAX_STEP_ITERATIONS}`);
  }
  const indexVar = repeat.indexVar?.trim();
  return Array.from({ length: count }, (_, index) => ({
    bindings: indexVar ? { [indexVar]: String(index) } : {},
    label: count > 1 ? `第 ${index + 1}/${count} 次` : "",
  }));
}

/** 步骤条件门评估（纯函数）：返回是否满足与说明。 */
export function evaluateStepCondition(
  condition: ScenarioStepCondition,
  vars: Record<string, string>,
): { met: boolean; actual: string | null } {
  const actual = vars[condition.varName];
  if (condition.op === "exists") {
    return { met: actual !== undefined && actual !== "", actual: actual ?? null };
  }
  if (actual === undefined) {
    return { met: false, actual: null };
  }
  return { met: compareValues(condition.op, actual, condition.value), actual };
}

/** 新建一个等待步骤（P0-2）。 */
export function newWaitStep(ms = 1000): ScenarioStep {
  return {
    id: uid(),
    name: "等待",
    enabled: true,
    source: { kind: "wait", ms },
    extracts: [],
    continueOnFailure: false,
  };
}

// ---- P0-3 数据驱动测试：CSV 数据集 ----

/** 单个 CSV 单元格上限，防止粘贴超大文件撑爆快照。 */
const MAX_CSV_CELL = 4096;
/** 单个数据集行数上限（每行一轮执行）。 */
export const MAX_DATASET_ROWS = 200;

/** 双引号感知的 CSV 行拆分（支持 "" 转义引号；逗号分隔）。 */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inQuotes) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((cell) => (cell.length > MAX_CSV_CELL ? cell.slice(0, MAX_CSV_CELL) : cell));
}

/**
 * 把 CSV 文本解析为场景数据集（纯函数）：第一行是表头（变量名列），
 * 之后每行一轮。空行跳过；列数不足的行用空串补齐。
 */
export function parseCsvDataset(text: string): {
  columns: string[];
  rows: Record<string, string>[];
  error?: string;
} {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line, index) => line.trim() !== "" || index === 0);
  const nonEmpty = lines.filter((line) => line.trim() !== "");
  if (nonEmpty.length < 2) {
    return { columns: [], rows: [], error: "数据集至少需要表头 + 1 行数据" };
  }
  const columns = splitCsvLine(nonEmpty[0]).map((cell) => cell.trim());
  if (columns.some((column) => !column)) {
    return { columns: [], rows: [], error: "表头存在空列名" };
  }
  const rows: Record<string, string>[] = [];
  for (const line of nonEmpty.slice(1)) {
    const cells = splitCsvLine(line);
    const row: Record<string, string> = {};
    columns.forEach((column, index) => {
      row[column] = cells[index] ?? "";
    });
    rows.push(row);
  }
  if (rows.length > MAX_DATASET_ROWS) {
    return {
      columns,
      rows: rows.slice(0, MAX_DATASET_ROWS),
      error: `数据行数超过上限 ${MAX_DATASET_ROWS}，已截断`,
    };
  }
  return { columns, rows };
}

/** 把数据集行渲染回 CSV 文本（编辑器展示用；值含逗号/引号时加引号转义）。 */
export function datasetToCsv(dataSet: { columns: string[]; rows: Record<string, string>[] }): string {
  const escape = (value: string) =>
    /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  const lines = [dataSet.columns.map(escape).join(",")];
  for (const row of dataSet.rows) {
    lines.push(dataSet.columns.map((column) => escape(row[column] ?? "")).join(","));
  }
  return lines.join("\n");
}

export function moveStep(steps: ScenarioStep[], stepId: string, direction: -1 | 1): ScenarioStep[] {
  const index = steps.findIndex((step) => step.id === stepId);
  const target = index + direction;
  if (index === -1 || target < 0 || target >= steps.length) return steps;
  const next = [...steps];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** Run one step's extracts against its response; returns the variable table patch. */
export function runExtracts(
  extracts: ScenarioExtract[],
  response: ResponseData | null,
): { extracted: Record<string, string>; error?: string } {
  const extracted: Record<string, string> = {};
  if (!response) return { extracted };
  for (const extract of extracts) {
    if (!extract.varName.trim()) continue;
    let value: string | undefined;
    if (extract.source === "status") {
      value = String(response.status);
    } else if (extract.source === "header") {
      const header = response.headers.find(
        (item) => item.name.toLowerCase() === extract.path.trim().toLowerCase(),
      );
      value = header?.value;
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body) as unknown;
      } catch {
        return { extracted, error: `提取「${extract.varName}」失败：响应体不是合法 JSON` };
      }
      const found = selectPath(parsed, extract.path);
      value = found === undefined || found === null ? undefined : String(found);
    }
    if (value === undefined) {
      return { extracted, error: `提取「${extract.varName}」失败：找不到 ${extract.source}:${extract.path}` };
    }
    extracted[extract.varName.trim()] = value;
  }
  return { extracted };
}

/** Aggregate per-step results into the run summary stored on the scenario. */
export function summarizeScenario(
  results: ScenarioStepResult[],
  totalSteps: number,
  timeMs: number,
): ScenarioRunSummary {
  const skippedInResults = results.filter((item) => item.skipped).length;
  // Steps never reached (chain stopped early) also count as skipped.
  const notRun = Math.max(0, totalSteps - results.length);
  const passed = results.filter((item) => item.ok).length;
  const failed = results.filter((item) => !item.ok && !item.skipped).length;
  return {
    at: Date.now(),
    total: totalSteps,
    passed,
    failed,
    skipped: skippedInResults + notRun,
    timeMs,
    steps: results,
  };
}

// ---- 数据库步骤（MySQL / PostgreSQL）----

/** 新建一个空的数据库步骤。 */
export function newDbStep(): ScenarioStep {
  return {
    id: uid(),
    name: "数据库操作",
    enabled: true,
    source: {
      kind: "db",
      db: {
        url: "",
        sql: "",
        mode: "query",
        extracts: [],
        asserts: [],
      },
    },
    extracts: [],
    continueOnFailure: false,
  };
}

/** 由步骤配置构造 db_query 请求：URL 与 SQL 都做 {{变量}} 替换。 */
export function dbSpecFromConfig(
  config: ScenarioDbConfig,
  variables: Record<string, string>,
): { url: string; sql: string; mode: "query" | "execute"; maxRows?: number } {
  return {
    url: substitute(config.url, variables),
    sql: substitute(config.sql, variables),
    mode: config.mode === "execute" ? "execute" : "query",
    maxRows: config.maxRows,
  };
}

/**
 * P2-13：按全局命名连接解析 DB 步骤的实际 URL。
 * 配置了 `connectionId` 且连接存在时用连接地址，否则回退手填 URL。
 */
export function resolveDbConnectionUrl(
  config: ScenarioDbConfig,
  connections: { id: string; url: string }[],
): string {
  if (config.connectionId) {
    const found = connections.find((item) => item.id === config.connectionId);
    if (found) return found.url;
  }
  return config.url;
}

function compareValues(op: string, actual: string, expected: string): boolean {
  const actualNumber = Number(actual);
  const expectedNumber = Number(expected);
  const numeric =
    !Number.isNaN(actualNumber) && !Number.isNaN(expectedNumber) &&
    actual.trim() !== "" && expected.trim() !== "";
  switch (op) {
    case "eq":
      return numeric ? actualNumber === expectedNumber : actual === expected;
    case "ne":
      return numeric ? actualNumber !== expectedNumber : actual !== expected;
    case "gt":
      return numeric && actualNumber > expectedNumber;
    case "gte":
      return numeric && actualNumber >= expectedNumber;
    case "lt":
      return numeric && actualNumber < expectedNumber;
    case "lte":
      return numeric && actualNumber <= expectedNumber;
    case "contains":
      return actual.includes(expected);
    default:
      return false;
  }
}

function cellAt(result: DbQueryResult, row: number, column: string): string | undefined {
  const record = result.rows[row];
  if (!record) return undefined;
  if (!(column in record)) return undefined;
  const value = record[column];
  return value === null || value === undefined ? "null" : String(value);
}

/** 执行一个数据库步骤的结果评估：提取 + 断言（纯函数）。 */
export function evaluateDbStep(
  config: ScenarioDbConfig,
  result: DbQueryResult | null,
  failure?: string,
): { extracted: Record<string, string>; passed: number; failed: number; error?: string } {
  const extracted: Record<string, string> = {};
  if (failure) {
    return { extracted, passed: 0, failed: 1, error: failure };
  }
  if (!result) {
    return { extracted, passed: 0, failed: 1, error: "数据库步骤没有返回结果" };
  }
  let passed = 0;
  let failed = 0;
  let error: string | undefined;

  for (const extract of config.extracts) {
    if (!extract.varName.trim()) continue;
    const value = cellAt(result, extract.row, extract.column.trim());
    if (value === undefined) {
      return {
        extracted,
        passed,
        failed: failed + 1,
        error: `提取「${extract.varName}」失败：第 ${extract.row} 行不存在列 ${extract.column || "(空)"}`,
      };
    }
    extracted[extract.varName.trim()] = value;
  }

  for (const assertion of config.asserts) {
    const actual =
      assertion.target === "rows"
        ? String(result.rows.length)
        : cellAt(result, assertion.row, assertion.column.trim());
    if (actual === undefined) {
      failed += 1;
      error = `断言失败：第 ${assertion.row} 行不存在列 ${assertion.column || "(空)"}`;
      continue;
    }
    if (compareValues(assertion.op, actual, assertion.value)) {
      passed += 1;
    } else {
      failed += 1;
      error = `断言失败：${assertion.target === "rows" ? "行数" : `第 ${assertion.row} 行 ${assertion.column}`} ${assertion.op} ${assertion.value}，实际 ${actual}`;
    }
  }
  return { extracted, passed, failed, error };
}
