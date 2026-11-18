import type { ApiCase, SuiteItem, SuiteItemResult, TestScenario, TestSuite } from "../types.ts";
import { uid } from "./id.ts";

/**
 * 测试套件（P0-4）：把用例 / 场景组合成一次批量回归。纯函数 + 工厂，
 * 运行编排与聚合在 store 里完成（复用 runCase / runScenario 的既有链路）。
 */

export function newSuite(name = "新套件"): TestSuite {
  const now = Date.now();
  return { id: uid(), name, description: "", items: [], createdAt: now, updatedAt: now };
}

export function suiteItem(kind: SuiteItem["kind"], refId: string): SuiteItem {
  return { id: uid(), kind, refId };
}

/** 套件成员的展示名（用例 / 场景可能已被删除）。 */
export function suiteItemName(
  item: SuiteItem,
  cases: ApiCase[],
  scenarios: TestScenario[],
): string | null {
  const source = item.kind === "case" ? cases : scenarios;
  const found = source.find((candidate) => candidate.id === item.refId);
  return found ? found.name : null;
}

/**
 * 聚合套件运行结果：逐项折叠为 SuiteItemResult，再汇总 passed / failed /
 * skipped。单项 ok = failed === 0 且未跳过。
 */
export function summarizeSuite(
  items: SuiteItem[],
  results: (SuiteItemResult | null)[],
  timeMs: number,
): TestSuite["lastRun"] {
  const itemResults: SuiteItemResult[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const result = results[index];
    const item = items[index];
    if (!result) {
      itemResults.push({
        itemId: item.id,
        kind: item.kind,
        refId: item.refId,
        name: item.refId,
        ok: false,
        skipped: true,
        passed: 0,
        failed: 0,
        timeMs: 0,
        error: "成员未运行（被删除或被跳过）",
      });
    } else {
      itemResults.push(result);
    }
  }
  const counted = itemResults.filter((item) => !item.skipped);
  return {
    at: Date.now(),
    total: itemResults.length,
    passed: counted.filter((item) => item.ok).length,
    failed: counted.filter((item) => !item.ok).length,
    skipped: itemResults.length - counted.length,
    timeMs,
    items: itemResults,
  };
}
