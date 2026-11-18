import test from "node:test";
import assert from "node:assert/strict";
import {
  applyEnvMerge,
  diffKeyValueLists,
  mergeGlobalHeaders,
} from "../src/lib/environment.ts";

const row = (key, value, enabled = true) => ({ id: `id-${key}`, key, value, enabled });

test("mergeGlobalHeaders：请求内显式头优先，大小写不敏感", () => {
  const request = [row("X-Tenant", "local"), row("", "ignored")];
  const global = [row("x-tenant", "global"), row("X-Trace", "g-1")];
  const merged = mergeGlobalHeaders(request, global);
  assert.equal(merged.length, 3);
  assert.equal(merged.find((item) => item.key.toLowerCase() === "x-tenant").value, "local");
  assert.equal(merged.find((item) => item.key === "X-Trace").value, "g-1");
  // 入参不被修改
  assert.equal(request.length, 2);
});

test("mergeGlobalHeaders：跳过禁用的、空键的和重复的全局行", () => {
  const merged = mergeGlobalHeaders([], [
    row("A", "1"),
    row("A", "2"),
    row("", "3"),
    row("B", "4", false),
  ]);
  assert.deepEqual(merged.map((item) => item.key), ["A"]);
  assert.equal(merged[0].value, "1");
  assert.equal(merged[0].enabled, true);
  assert.notEqual(merged[0].id, "id-A");
});

test("mergeGlobalHeaders：没有可追加项时原样返回入参", () => {
  const request = [row("A", "1")];
  assert.equal(mergeGlobalHeaders(request, undefined), request);
  assert.equal(mergeGlobalHeaders(request, [row("a", "2")]), request);
  assert.equal(mergeGlobalHeaders(request, []), request);
});

test("diffKeyValueLists：区分仅来源 / 仅目标 / 值不同 / 一致", () => {
  const diff = diffKeyValueLists(
    [row("token", "src"), row("baseUrl", "https://a"), row("same", "x")],
    [row("token", "dst"), row("localOnly", "y"), row("same", "x")],
  );
  const byKey = Object.fromEntries(diff.map((item) => [item.key, item.status]));
  assert.deepEqual(byKey, {
    token: "different",
    baseUrl: "only-source",
    same: "same",
    localOnly: "only-target",
  });
  assert.equal(diff.find((item) => item.key === "token").sourceValue, "src");
  assert.equal(diff.find((item) => item.key === "token").targetValue, "dst");
});

test("diffKeyValueLists：Header 大小写不敏感、变量区分大小写", () => {
  const headerDiff = diffKeyValueLists([row("X-Token", "1")], [row("x-token", "1")], true);
  assert.equal(headerDiff.length, 1);
  assert.equal(headerDiff[0].status, "same");
  const varDiff = diffKeyValueLists([row("token", "1")], [row("Token", "1")]);
  assert.equal(varDiff.length, 2);
});

test("applyEnvMerge：只追加选中项，不改动目标其他行", () => {
  const target = [row("keep", "v"), row("token", "target")];
  const source = [row("token", "source"), row("newKey", "n")];
  const merged = applyEnvMerge(target, source, ["newKey"], false);
  assert.deepEqual(merged.map((item) => item.key), ["keep", "token", "newKey"]);
  assert.equal(merged[1].value, "target");
  assert.equal(merged[2].value, "n");
});

test("applyEnvMerge：overwrite 才覆盖同名项", () => {
  const target = [row("token", "target")];
  const source = [row("token", "source")];
  assert.equal(applyEnvMerge(target, source, ["token"], false)[0].value, "target");
  assert.equal(applyEnvMerge(target, source, ["token"], true)[0].value, "source");
  assert.deepEqual(applyEnvMerge(target, source, [], true), target);
});

test("applyEnvMerge：目标存在同名的禁用空行时会被填上", () => {
  const target = [row("token", "", false)];
  const source = [row("token", "source")];
  const merged = applyEnvMerge(target, source, ["token"], false);
  assert.equal(merged[0].value, "source");
  assert.equal(merged[0].enabled, true);
});
