import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DYNAMIC_VARIABLES, dynamicValue, Prng } from "../src/lib/dynamic.ts";
import { POSTMAN_DYNAMIC_VARIABLES } from "../src/lib/dynamicPostman.ts";
import { missingVariables, substitute } from "../src/lib/template.ts";

test("wall-clock dynamic tokens reflect the current moment", () => {
  const before = Math.floor(Date.now() / 1000);
  const timestamp = Number(dynamicValue("$timestamp"));
  const after = Math.floor(Date.now() / 1000);
  assert.ok(timestamp >= before && timestamp <= after, `got ${timestamp}`);

  assert.match(dynamicValue("$isoDate"), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.match(dynamicValue("$date"), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(dynamicValue("$time"), /^\d{2}:\d{2}:\d{2}$/);
  assert.ok(/^\d{13,}$/.test(dynamicValue("$timestampMs")));
});

test("random dynamic tokens generate valid values", () => {
  assert.match(dynamicValue("$email"), /^[a-z.]+@[a-z.]+$/);
  assert.match(dynamicValue("$cname"), /^[\u4e00-\u9fa5]{2,4}$/);
  assert.match(dynamicValue("$phone"), /^1[3-9]\d{9}$/);
  assert.match(dynamicValue("$idCard"), /^\d{17}[\dX]$/);
  assert.match(dynamicValue("$guid"), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(dynamicValue("$uuid"), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(dynamicValue("$ip"), /^\d{1,3}(\.\d{1,3}){3}$/);
  assert.match(dynamicValue("$url"), /^https:\/\/[a-z.]+\/[a-z0-9/]+$/);
  assert.ok(["true", "false"].includes(dynamicValue("$boolean")));
  assert.match(dynamicValue("$randomInt(10,20)"), /^\d+$/);
  const int = Number(dynamicValue("$randomInt(10,20)"));
  assert.ok(int >= 10 && int <= 20, `got ${int}`);
  assert.match(dynamicValue("$randomFloat(0,100)"), /^\d+\.\d{2}$/);
  assert.match(dynamicValue("$ctitle"), /^[\u4e00-\u9fa5]+$/);
  assert.ok(dynamicValue("$cparagraph").endsWith("。"));
  assert.match(dynamicValue("$string(5)"), /^[a-zA-Z]{5}$/);
});

test("each dynamic call is independent and seeded from crypto", () => {
  const rng = new Prng();
  const a = rng.range(0, 1_000_000);
  const b = rng.range(0, 1_000_000);
  assert.notEqual(a, b, "both draws landed on the same value");
  // Range bounds are inclusive.
  const rng2 = new Prng();
  assert.ok(rng2.range(5, 5) === 5);
});

test("unknown or malformed $tokens are not dynamic", () => {
  assert.equal(dynamicValue("$nope"), null);
  assert.equal(dynamicValue("{{$}}"), null);
  assert.equal(dynamicValue("$email(unclosed"), null);
  assert.equal(dynamicValue("baseUrl"), null);
});

test("substitute resolves user variables, dynamic built-ins, and keeps unknowns", () => {
  const out = substitute(
    "{{baseUrl}}/log?ts={{$timestamp}}&mail={{$email}}&weird={{$nope}}&miss={{missing}}",
    { baseUrl: "https://api.example.com" },
  );
  assert.ok(out.startsWith("https://api.example.com/log?ts="), out);
  assert.match(out, /mail=[a-z.]+@[a-z.]+/);
  assert.ok(out.includes("{{$nope}}"), "unknown $token kept verbatim");
  assert.ok(out.includes("{{missing}}"), "missing plain variable kept verbatim");
});

test("substitute prefers user-defined variables over dynamic built-ins", () => {
  assert.equal(substitute("{{$timestamp}}", { $timestamp: "1700000000" }), "1700000000");
});

test("missingVariables ignores the dynamic namespace entirely", () => {
  assert.deepEqual(
    missingVariables("{{a}}/{{$uuid}}/{{$email}}/{{$nope}}", {}),
    ["a"],
  );
});

// ---------------------------------------------- Postman dynamic variables ----

test("Postman catalogue is complete and every token resolves", () => {
  assert.equal(POSTMAN_DYNAMIC_VARIABLES.length, 115);
  assert.ok(DYNAMIC_VARIABLES.length > 130);
  assert.equal(
    new Set(DYNAMIC_VARIABLES.map((item) => item.key)).size,
    DYNAMIC_VARIABLES.length,
    "catalogue has duplicate keys",
  );
  for (const item of POSTMAN_DYNAMIC_VARIABLES) {
    assert.notEqual(dynamicValue(item.key), null, `${item.key} is not resolvable`);
    assert.ok(item.group && item.description, `${item.key} lacks autocomplete hints`);
  }
});

test("Postman tokens generate values in the documented shape", () => {
  const samples = {
    $isoTimestamp: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    $randomUUID: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    $randomAlphaNumeric: /^[A-Za-z0-9]$/,
    $randomHexColor: /^#[0-9a-f]{6}$/,
    $randomIPV6: /^(?:[0-9a-f]{4}:){7}[0-9a-f]{4}$/,
    $randomMACAddress: /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/,
    $randomPassword: /^[A-Za-z0-9]{15}$/,
    $randomSemver: /^\d+\.\d+\.\d+$/,
    $randomPhoneNumber: /^\d{3}-\d{3}-\d{4}$/,
    $randomLatitude: /^-?\d+\.\d{4}$/,
    $randomLongitude: /^-?\d+\.\d{4}$/,
    $randomBankAccount: /^\d{8}$/,
    $randomCreditCardMask: /^\d{4}$/,
    $randomBitcoin: /^3[A-Za-z0-9]{26}$/,
    $randomPrice: /^\d+\.\d{2}$/,
    $randomLoremSlug: /^[a-z]+-[a-z]+-[a-z]+$/,
  };
  for (const [key, pattern] of Object.entries(samples)) {
    assert.match(dynamicValue(key), pattern, key);
  }
  assert.ok(["true", "false"].includes(dynamicValue("$randomBoolean")));
  assert.ok(dynamicValue("$randomEmail").includes("@"));
  assert.match(dynamicValue("$randomExampleEmail"), /@example\.(com|net|org)$/);
  assert.ok(dynamicValue("$randomImageDataUri").startsWith("data:image/svg+xml"));
  assert.ok(dynamicValue("$randomLoremParagraphs").includes("\n\n"));
  assert.ok(!Number.isNaN(Date.parse(dynamicValue("$randomDateFuture"))));
  assert.equal(dynamicValue("$randomWords(4)").split(" ").length, 4);
  assert.equal(dynamicValue("$randomPassword(20)").length, 20);
});

test("substitute resolves several Postman tokens in one pass", () => {
  const out = substitute("{{$randomUUID}}|{{$randomHexColor}}|{{$randomIPV6}}|{{$nope}}", {});
  const parts = out.split("|");
  assert.equal(parts.length, 4);
  assert.match(parts[0], /^[0-9a-f-]{36}$/);
  assert.match(parts[1], /^#[0-9a-f]{6}$/);
  assert.match(parts[2], /^[0-9a-f:]{39}$/);
  assert.equal(parts[3], "{{$nope}}");
});

test("Rust mirror exposes the same Postman tokens and word lists", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const rustPath = resolve(root, "src-tauri/crates/reqora-core/src/service/postman.rs");
  // npm package ships src/ only; the mirror is a repository-only invariant.
  if (!existsSync(rustPath)) return;
  const rust = readFileSync(rustPath, "utf8");
  const ts = readFileSync(resolve(root, "src/lib/dynamicPostman.ts"), "utf8");

  for (const item of POSTMAN_DYNAMIC_VARIABLES) {
    const name = item.key.slice(1);
    // isoTimestamp is handled by the wall-clock switch in dynamic.rs.
    if (name === "isoTimestamp") continue;
    assert.ok(rust.includes(`"${name}"`), `${name} is missing in the Rust mirror`);
  }

  const rustName = (key) => key.replace(/([A-Z])/g, "_$1").toUpperCase();
  const wordsBlock = ts.split("const WORDS = {")[1].split("} as const;")[0];
  let checked = 0;
  for (const line of wordsBlock.split("\n")) {
    const match = /^\s+(\w+): (\[.*\]),?\s*$/.exec(line);
    if (!match) continue;
    const constant = rustName(match[1]);
    const mirror = new RegExp(`const ${constant}: &\\[&str\\] = &(\\[.*\\]);`).exec(rust);
    assert.ok(mirror, `${constant} is missing in the Rust mirror`);
    assert.deepEqual(JSON.parse(mirror[1]), JSON.parse(match[2]), `${constant} differs`);
    checked += 1;
  }
  assert.ok(checked > 40, `only ${checked} word lists were compared`);
});
