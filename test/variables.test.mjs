import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyPathVariables,
  pathVariableKeys,
  resolveRequestUrl,
  variablesFrom,
} from "../src/lib/template.ts";
import {
  collectVariableSuggestions,
  filterVariableSuggestions,
} from "../src/lib/variables.ts";
import { DYNAMIC_VARIABLES, dynamicValue } from "../src/lib/dynamic.ts";
import { emptyRequest, normalizeRequest } from "../src/lib/defaults.ts";

// -------------------------------------------------- path variable keys ----

test("pathVariableKeys finds :name and {name} in the URL path, de-duplicated", () => {
  assert.deepEqual(
    pathVariableKeys("{{baseUrl}}/users/:id/posts/{postId}?q=1#top"),
    ["id", "postId"],
  );
  assert.deepEqual(pathVariableKeys("https://h/a/:x/b/:x/c/{x}"), ["x"]);
  assert.deepEqual(pathVariableKeys("https://h/orders/{order-id}/files/:fileId.json"), [
    "order-id",
    "fileId",
  ]);
});

test("pathVariableKeys never mistakes URLs for path variables", () => {
  assert.deepEqual(pathVariableKeys("https://api.example.com/v1/users"), []);
  assert.deepEqual(pathVariableKeys("https://api.example.com:8443/v1/users"), []);
  assert.deepEqual(pathVariableKeys("http://[::1]:8080/users"), []);
  assert.deepEqual(pathVariableKeys("https://user:pass@example.com/{{version}}/items"), []);
  assert.deepEqual(pathVariableKeys("https://h/users?redirect=:id&tag={tag}"), []);
  assert.deepEqual(pathVariableKeys("127.0.0.1:8080"), []);
  assert.deepEqual(pathVariableKeys("ws://127.0.0.1:8789/echo"), []);
});

// ----------------------------------------------- applyPathVariables ----

test("applyPathVariables substitutes both placeholder styles", () => {
  assert.equal(
    applyPathVariables("{{baseUrl}}/users/:id/posts/{postId}?q=1", {
      id: "42",
      postId: "abc",
    }),
    "{{baseUrl}}/users/42/posts/abc?q=1",
  );
});

test("applyPathVariables keeps empty / unknown values visible", () => {
  assert.equal(
    applyPathVariables("https://h/users/:id/posts/{postId}", { id: "" }),
    "https://h/users/:id/posts/{postId}",
  );
  assert.equal(
    applyPathVariables("https://h/users/:id", {}),
    "https://h/users/:id",
  );
});

test("applyPathVariables only touches the path, not query or template vars", () => {
  assert.equal(
    applyPathVariables("https://h/users/:id?next=:id", { id: "9" }),
    "https://h/users/9?next=:id",
  );
  assert.equal(
    applyPathVariables("{{baseUrl}}/users/{{userId}}", { userId: "7" }),
    "{{baseUrl}}/users/{{userId}}",
  );
});

test("applyPathVariables inserts values verbatim so {{}} survives for Rust", () => {
  assert.equal(
    applyPathVariables("https://h/users/:id", { id: "{{userId}}" }),
    "https://h/users/{{userId}}",
  );
  assert.equal(
    applyPathVariables("https://h/users/:id", { id: "a/b" }),
    "https://h/users/a/b",
  );
});

// ------------------------------------------------------ resolveRequestUrl ----

test("resolveRequestUrl applies path variables before {{}} substitution", () => {
  const pathVars = [
    { id: "p1", key: "id", value: "{{userId}}", enabled: true },
    { id: "p2", key: "off", value: "ignored", enabled: false },
  ];
  assert.equal(
    resolveRequestUrl(
      "{{baseUrl}}/users/:id/off/:off",
      pathVars,
      { baseUrl: "https://api.example.com", userId: "u-100" },
    ),
    "https://api.example.com/users/u-100/off/:off",
  );
});

// ------------------------------------------------------- suggestions ----

test("collectVariableSuggestions merges environment, path and dynamic variables", () => {
  const suggestions = collectVariableSuggestions({
    environmentVariables: [
      { id: "1", key: "baseUrl", value: "https://h", enabled: true },
      { id: "2", key: "off", value: "ignored", enabled: false },
    ],
    url: "https://h/users/:id/posts/{postId}",
  });
  assert.deepEqual(
    suggestions.slice(0, 3).map((item) => [item.key, item.insert, item.source]),
    [
      ["baseUrl", "{{baseUrl}}", "environment"],
      ["id", ":id", "path"],
      ["postId", ":postId", "path"],
    ],
  );
  assert.ok(suggestions.some((item) => item.key === "$timestamp" && item.source === "dynamic"));
  assert.ok(!suggestions.some((item) => item.key === "off"), "disabled env vars are excluded");
});

test("collectVariableSuggestions does not duplicate a name shared by env and path", () => {
  const suggestions = collectVariableSuggestions({
    environmentVariables: [{ id: "1", key: "id", value: "7", enabled: true }],
    url: "https://h/users/:id",
  });
  assert.equal(suggestions.filter((item) => item.key === "id").length, 1);
  assert.equal(suggestions.find((item) => item.key === "id").source, "environment");
});

test("filterVariableSuggestions ranks prefix matches first and caps the list", () => {
  const all = collectVariableSuggestions({ url: "https://h/users/:tokenId" });
  const filtered = filterVariableSuggestions(all, "token", 5);
  assert.ok(filtered.length <= 5);
  assert.ok(filtered[0].key.toLowerCase().startsWith("token"));
  assert.equal(filterVariableSuggestions(all, "", 3).length, 3);
});

test("every catalogued dynamic token is actually resolvable", () => {
  assert.ok(DYNAMIC_VARIABLES.length > 15);
  for (const item of DYNAMIC_VARIABLES) {
    assert.notEqual(dynamicValue(item.key), null, `${item.key} is not a valid dynamic token`);
  }
});

// ---------------------------------------------------------- defaults ----

test("emptyRequest / normalizeRequest carry a normalised pathVariables field", () => {
  assert.deepEqual(emptyRequest().pathVariables, []);
  const normalized = normalizeRequest({
    url: "https://h/users/:id",
    pathVariables: [{ key: "id", value: "5" }],
  });
  assert.deepEqual(normalized.pathVariables, [
    { id: "path:id", key: "id", value: "5", enabled: true },
  ]);
  assert.deepEqual(normalizeRequest({ url: "x" }).pathVariables, []);
});

test("variablesFrom only exposes enabled rows with a non-empty key", () => {
  assert.deepEqual(
    variablesFrom([
      { id: "1", key: "a", value: "1", enabled: true },
      { id: "2", key: "b", value: "2", enabled: false },
      { id: "3", key: "  ", value: "3", enabled: true },
    ]),
    { a: "1" },
  );
});
