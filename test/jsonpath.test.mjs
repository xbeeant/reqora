/**
 * Node 22 strips TypeScript types natively, so these tests import the real
 * production module — no bundler and no JSONPath dependency.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  childPath,
  collectPaths,
  formatMatchValue,
  pathPrefixes,
  queryJsonPath,
} from "../src/lib/jsonpath.ts";

const data = {
  store: {
    book: [
      { category: "reference", author: "Nigel Rees", title: "Sayings", price: 8.95, isbn: "1" },
      { category: "fiction", author: "Evelyn Waugh", title: "Sword", price: 12.99 },
      { category: "fiction", author: "Herman Melville", title: "Moby Dick", price: 8.99, isbn: "3" },
    ],
    bicycle: { color: "red", price: 19.95 },
  },
  tags: ["a", "b", "c"],
};

const paths = (expression) =>
  queryJsonPath(data, expression).matches.map((match) => match.path);

test("dot paths, bracket keys and array indices", () => {
  assert.equal(queryJsonPath(data, "$.store.book[0].title").matches[0].value, "Sayings");
  assert.deepEqual(paths("$['store']['book'][1].author"), ["$.store.book[1].author"]);
  assert.deepEqual(paths("$.tags[-1]"), ["$.tags[2]"]);
  assert.equal(queryJsonPath(data, "$.tags[-1]").matches[0].value, "c");
});

test("wildcard, recursive descent and unions", () => {
  assert.equal(paths("$.store.book[*].author").length, 3);
  assert.equal(paths("$.store.*.color").length, 1);
  assert.equal(paths("$..isbn").length, 2);
  assert.equal(paths("$..price").length, 4, "three books plus the bicycle");
  assert.equal(paths("$.store.book[0,2].title").length, 2);
  assert.equal(paths("$.store.book['title','author']").length, 0, "applied to an array root");
});

test("slices", () => {
  assert.deepEqual(paths("$.tags[0:2]"), ["$.tags[0]", "$.tags[1]"]);
  assert.deepEqual(paths("$.tags[::2]"), ["$.tags[0]", "$.tags[2]"]);
  assert.deepEqual(paths("$.tags[-2:]"), ["$.tags[1]", "$.tags[2]"]);
});

test("filters with comparisons and existence checks", () => {
  assert.equal(paths("$.store.book[?(@.price < 10)].title").length, 2);
  assert.deepEqual(paths("$.store.book[?(@.category == 'fiction')].title"), [
    "$.store.book[1].title",
    "$.store.book[2].title",
  ]);
  assert.equal(paths("$.store.book[?(@.isbn)]").length, 2);
  assert.equal(paths("$.store.book[?(@.price >= 12.99)].title").length, 1);
  assert.equal(paths("$.store.book[?(@.price > 100)]").length, 0);
});

test("invalid expressions report an error instead of throwing", () => {
  const bad = queryJsonPath(data, "$.store.book[?(@.price ~~ 1)]");
  assert.equal(bad.ok, false);
  assert.ok(bad.error);
  assert.deepEqual(bad.matches, []);
  assert.equal(queryJsonPath(data, "$.a[").ok, false);
  assert.equal(queryJsonPath(data, "").ok, false);
});

test("root expression and missing paths", () => {
  assert.equal(queryJsonPath(data, "$").matches.length, 1);
  assert.equal(queryJsonPath(data, "$").matches[0].path, "$");
  assert.deepEqual(paths("$.does.not.exist"), []);
});

test("canonical paths and ancestor sets drive tree highlighting", () => {
  assert.equal(childPath("$", "items"), "$.items");
  assert.equal(childPath("$.items", "0"), "$.items[0]");
  assert.equal(childPath("$", "a-b"), '$["a-b"]');
  assert.deepEqual(pathPrefixes("$.items[0].name"), [
    "$.items",
    "$.items[0]",
    "$.items[0].name",
  ]);
  const { exact, ancestors } = collectPaths(
    queryJsonPath(data, "$.store.book[0].title").matches,
  );
  assert.ok(exact.has("$.store.book[0].title"));
  assert.ok(ancestors.has("$.store"));
  assert.ok(ancestors.has("$.store.book[0]"));
  assert.ok(!ancestors.has("$.store.book[0].title"));
});

test("match value previews are bounded and readable", () => {
  assert.equal(formatMatchValue("Sayings"), '"Sayings"');
  assert.equal(formatMatchValue(8.95), "8.95");
  assert.equal(formatMatchValue(["a", "b"]), "Array(2)");
  assert.equal(formatMatchValue(data.store.bicycle), "{2 keys}");
  assert.ok(formatMatchValue("x".repeat(500)).endsWith("…"));
});

test("large result sets are capped", () => {
  const big = { items: Array.from({ length: 3000 }, (_, i) => ({ id: i })) };
  const result = queryJsonPath(big, "$.items[*].id");
  assert.equal(result.truncated, true);
  assert.equal(result.matches.length, 2000);
});
