import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { rmTemp } from "../scripts/rm-temp.mjs";

const CLI = fileURLToPath(new URL("../bin/evidence.mjs", import.meta.url));

function workspace() {
  return mkdtempSync(join(tmpdir(), "reqora-gate-"));
}

function invoke(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 30_000 });
}

function report(dir, name, steps, extra = {}) {
  const file = join(dir, `${name}.report.json`);
  writeFileSync(file, JSON.stringify({ name, steps, ...extra }));
  return file;
}

function okStep(id) {
  return { stepId: id, name: `步骤 ${id}`, ok: true, skipped: false, status: 200, timeMs: 5 };
}

function outputOf(result) {
  return JSON.parse(result.stdout);
}

function clean(dir) {
  rmTemp(dir);
}

// -------------------------------------------------------------- T1.3 -----

test("T1.3 四种失败夹具均 exit 1", async (t) => {
  const cases = [
    {
      name: "断言失败",
      steps: [okStep("s1"), { ...okStep("s2"), ok: false, failed: 1 }],
      expected: "assertion",
    },
    {
      name: "步骤异常",
      steps: [{ ...okStep("s1"), ok: false, status: null, error: "找不到步骤引用的用例" }],
      expected: "exception",
    },
    {
      name: "网络错误",
      steps: [{ ...okStep("s1"), ok: false, status: null, error: "fetch failed (ECONNREFUSED)" }],
      expected: "network",
    },
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, () => {
      const dir = workspace();
      try {
        const from = report(dir, "fixture", fixture.steps);
        const result = invoke([
          "build", "--from", from, "--evidence", join(dir, "run.json"), "--gate",
          "--engine", "node-fetch", "--run-id", "r1",
          "--started-at", "2026-11-14T03:00:00.000Z",
        ]);
        assert.equal(result.status, 1, `应 exit 1，实际 ${result.status}；${result.stderr}`);
        const output = outputOf(result);
        assert.equal(output.gate, "fail");
        assert.ok(output.failures.some((item) => item.failure_class === fixture.expected));
        assert.equal(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).schema, "reqora.run.v1");
      } finally {
        clean(dir);
      }
    });
  }
});

test("T1.3 证据写不出也要 exit 1（CI 不允许假绿）", () => {
  const dir = workspace();
  try {
    const from = report(dir, "fixture", [okStep("s1")]);
    // 让「证据文件的父目录」变成一个普通文件，mkdir 必然失败。
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory");
    const result = invoke([
      "build", "--from", from, "--evidence", join(blocker, "run.json"), "--gate",
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /证据写入失败/);
    assert.equal(outputOf(result).failure_class, "evidence-write");
  } finally {
    clean(dir);
  }
});

test("T1.3 报告读不到（CLI 崩溃 / 网络中断）也 exit 1 并留下说明性证据", () => {
  const dir = workspace();
  try {
    const result = invoke([
      "build", "--from", join(dir, "missing.json"), "--evidence", join(dir, "run.json"), "--gate",
    ]);
    assert.equal(result.status, 1);
    const output = outputOf(result);
    assert.equal(output.failures.length, 1);
    const evidence = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
    assert.equal(evidence.steps[0].id, "cli-run");
    assert.match(evidence.steps[0].error, /无法读取报告/);
  } finally {
    clean(dir);
  }
});

test("T1.3 无 --gate 时向后兼容：步骤失败不强制非零退出", () => {
  const dir = workspace();
  try {
    const from = report(dir, "fixture", [{ ...okStep("s1"), ok: false, failed: 1 }]);
    const result = invoke(["build", "--from", from, "--evidence", join(dir, "run.json")]);
    assert.equal(result.status, 0, `原 CLI 行为不受影响；${result.stderr}`);
    assert.equal(outputOf(result).gateway, "disabled");
  } finally {
    clean(dir);
  }
});

test("T1.3 skipped 显式列出且不计入 passed", () => {
  const dir = workspace();
  try {
    const from = report(dir, "fixture", [
      okStep("s1"),
      { ...okStep("s2"), ok: false, skipped: true, note: "条件未满足" },
    ]);
    const result = invoke([
      "build", "--from", from, "--evidence", join(dir, "run.json"), "--gate",
    ]);
    assert.equal(result.status, 0, "跳过本身不该让门禁变红");
    const output = outputOf(result);
    assert.equal(output.summary.passed, 1);
    assert.equal(output.summary.skipped, 1);
    assert.equal(output.skipped.length, 1);
    assert.match(output.skipped[0].reason, /条件未满足/);
  } finally {
    clean(dir);
  }
});

// -------------------------------------------------------------- T1.4 -----

test("T1.4 --baseline 输出新增失败与契约漂移，波动不阻塞门禁", () => {
  const dir = workspace();
  try {
    const baselineReport = report(dir, "baseline", [
      { ...okStep("s1"), body: '{"id":42,"name":"order"}' },
    ]);
    const currentReport = report(dir, "current", [
      { ...okStep("s1"), body: '{"id":"oops"}' },
      {
        ...okStep("s2"),
        ok: false,
        assertions: [{ id: "a1", name: "含 orderId", ok: false, message: "响应缺少字段 orderId" }],
      },
    ]);
    const base = invoke([
      "build", "--from", baselineReport, "--evidence", join(dir, "baseline.json"),
      "--run-id", "base", "--started-at", "2026-11-14T03:00:00.000Z",
    ]);
    assert.equal(base.status, 0);
    const current = invoke([
      "build", "--from", currentReport, "--evidence", join(dir, "current.json"),
      "--baseline", join(dir, "baseline.json"), "--gate",
      "--run-id", "cur", "--started-at", "2026-11-14T03:01:00.000Z",
    ]);
    assert.equal(current.status, 1, "新增失败要让 CI 变红");
    const diff = outputOf(current).baseline_diff;
    assert.ok(diff.added_failures.some((item) => item.key === "s2:a1"));
    const kinds = new Set(diff.contract_drift.map((item) => item.kind));
    assert.ok(kinds.has("field_removed"));
    assert.ok(kinds.has("type_changed"));
  } finally {
    clean(dir);
  }
});

test("T1.4 explain 子命令定位到具体失败步骤与断言", () => {
  const dir = workspace();
  try {
    const from = report(dir, "fixture", [
      okStep("s1"),
      okStep("s2"),
      {
        ...okStep("s3"),
        ok: false,
        assertions: [{ id: "a1", name: "断言 X", ok: false, message: "响应缺少字段 Y" }],
      },
    ]);
    const build = invoke(["build", "--from", from, "--evidence", join(dir, "run.json")]);
    assert.equal(build.status, 0);
    const explain = invoke(["explain", "--evidence", join(dir, "run.json")]);
    assert.equal(explain.status, 0);
    assert.match(explain.stdout, /第 3 步/);
    assert.match(explain.stdout, /断言 X/);
  } finally {
    clean(dir);
  }
});

// -------------------------------------------------------------- T1.5 -----

test("T1.5 history 子命令从证据文件派生归档、趋势与失败频次", () => {
  const dir = workspace();
  try {
    for (let index = 0; index < 6; index += 1) {
      const from = report(dir, `r${index}`, [okStep("s1")]);
      const result = invoke([
        "build", "--from", from, "--evidence", join(dir, `run-${index}.json`),
        "--run-id", `run-${index}`,
        "--started-at", new Date(1_700_000_000_000 + index * 1000).toISOString(),
      ]);
      assert.equal(result.status, 0);
    }
    const history = invoke(["history", "--evidence-dir", dir, "--limit", "3"]);
    assert.equal(history.status, 0);
    const parsed = outputOf(history);
    assert.equal(parsed.total, 6);
    assert.equal(parsed.runs.length, 3);
    assert.equal(parsed.runs[0].run_id, "run-5");
    assert.equal(parsed.pass_rate_trend.length, 6);
    assert.equal(parsed.pass_rate_trend[0].pass_rate, 100);
  } finally {
    clean(dir);
  }
});

test("T1.3 diff 子命令可用两份证据独立比对", () => {
  const dir = workspace();
  try {
    const a = invoke([
      "build", "--from", report(dir, "a", [okStep("s1")]),
      "--evidence", join(dir, "a.json"), "--run-id", "a",
    ]);
    const b = invoke([
      "build", "--from", report(dir, "b", [{ ...okStep("s2"), ok: false }]),
      "--evidence", join(dir, "b.json"), "--run-id", "b",
    ]);
    assert.equal(a.status, 0);
    assert.equal(b.status, 0);
    const result = invoke(["diff", "--evidence", join(dir, "b.json"), "--baseline", join(dir, "a.json")]);
    assert.equal(result.status, 0);
    assert.ok(outputOf(result).added_failures.length > 0);
  } finally {
    clean(dir);
  }
});
