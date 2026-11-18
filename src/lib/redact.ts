/**
 * Share-snapshot redaction.
 *
 * `stripForUpload()` used to drop only top-level local-only fields. That left
 * credentials inside `collections[].items[].auth`, `cases[].request`,
 * `scenarios[].steps[].source.request`, `revisions[].snapshot` and environment
 * variables untouched — anyone importing the shared snapshot received them.
 *
 * This module produces a **new** deep copy with every credential-shaped value
 * removed. It never mutates the input: the desktop keeps its in-memory
 * workspace as the single source of truth, and `persist()` must never write
 * redacted values back to disk.
 *
 * Design:
 * - Structured fields (auth, KeyValue rows, DB configs, named secret keys) are
 *   blanked deterministically, keeping the shape so collaborators can see which
 *   values they need to fill in.
 * - Free text (docs, scripts, response examples, bodies, URLs) additionally
 *   gets well-known credential patterns replaced AND, on top of that, a
 *   fail-closed layer: any value whose key name looks credential-shaped is
 *   masked regardless of the value's shape, and unknown-key high-entropy
 *   strings are masked too. See `redactFreeText()`.
 *
 * `KeyValue.secret` is a tri-state override:
 *   true      → always redact
 *   false     → always share (explicit opt-in for a harmless value whose name
 *               happens to look sensitive)
 *   undefined → decide from the key name
 */

export type AnyRecord = Record<string, unknown>;

/**
 * Names that carry a credential by convention. Deliberately excludes bare
 * `key` / `value` / `url` — those are structural fields handled separately,
 * and blanking them would destroy the shared snapshot.
 */
export const SENSITIVE_NAME =
  /(authorization|proxy-authorization|cookie|set-cookie|api[_-]?key|token|secret|password|passwd|pwd|credential|private[_-]?key|client[_-]?secret|access[_-]?key|session[_-]?id)/i;

/** Auth fields that are safe to share (identifiers, endpoints, scopes). */
const AUTH_SAFE_FIELDS = new Set([
  "type",
  "location",
  "key",
  "username",
  "tokenUrl",
  "authUrl",
  "authorizationUrl",
  "accessTokenUrl",
  "scope",
  "audience",
  "realm",
  "callbackUrl",
  "redirectUri",
  "grant",
  "region",
  "service",
  "tokenType",
  "tokenPrefix",
  "clientAuth",
  "minTlsVersion",
  "serverName",
]);

/**
 * 新增凭据字段默认置空（fail-closed）：只有显式列进 AUTH_SAFE_FIELDS 的
 * 非敏感字段才放行。下面两个集合是双保险——即使某字段被误加进白名单，
 * 只要命中凭据清单仍会被强制置空；transport 清单用于 soap/mqtt 子树。
 */
const AUTH_SECRET_FIELDS = new Set([
  "clientSecret", "secretAccessKey", "sessionToken", "accessToken", "refreshToken",
  "code", "codeVerifier", "keyPem", "certPem", "caPem", "p12Base64", "passphrase",
  "password", "username", "value", "token",
  // OAuth2 `state` is registered in authProviders.AUTH_SECRET_FIELDS and is
  // reported by isSecretAuthField(); keep the upload/export gate fail-closed
  // and consistent with the MCP maskAuth() boundary instead of allow-listing it.
  "state",
]);

const TRANSPORT_SECRET_FIELDS = new Set(["username", "password"]);

/**
 * Well-known credential shapes in arbitrary text. Every pattern must be long
 * and specific enough that template placeholders (`{{token}}`) and ordinary
 * English words are left alone.
 *
 * T0.2: this loop is kept as the first, repo-wide 出口 — its exact output
 * (`<redacted…>` markers) is part of the restoreRedacted() round-trip contract.
 * The fail-closed layers below run on top of it and never rewrite those
 * markers, so all existing behaviour is preserved.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // PEM 私钥整段（RSA / EC / PKCS#8）：从 BEGIN 到 END 一次性替换。
  [/-----BEGIN (?:RSA |EC |)?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |)?PRIVATE KEY-----/g, "<redacted-private-key>"],
  // AWS 会话令牌头 / 刷新令牌参数：仅保留键名，值占位。
  [/x-amz-security-token\s*[:=]\s*[A-Za-z0-9+/=_-]{8,}/gi, "x-amz-security-token: <redacted>"],
  [/\brefresh_token=[^\s&"'`]+/gi, "refresh_token=<redacted>"],
  // AKIA / ASIA 访问密钥 ID 由下方 (?:AKIA|ASIA)[0-9A-Z]{16} 统一覆盖。
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "<redacted-jwt>"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "<redacted-key>"],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, "<redacted-key>"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer <redacted>"],
  [
    /\b(?:mysql|mariadb|postgresql|postgres|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^\s"'`<>]+/gi,
    "<redacted-connection>",
  ],
  // ?token=..., &api_key=..., ?signature=...
  [/([?&][\w.-]*(?:token|key|secret|password|signature|sig)[\w.-]*=)[^&#\s"'`<>]+/gi, "$1<redacted>"],
  // https://user:password@host — but not a plain https://host
  [/(\/\/)[^/@\s"'`]+:[^/@\s"'`]+@/g, "$1<redacted>@"],
];

/** 已知前缀但历史正则未覆盖的形态（fail-closed 的第一层补充）。 */
const EXTRA_SECRET_PATTERNS: Array<[RegExp, string]> = [
  [
    /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AIza[0-9A-Za-z_-]{30,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{30,})\b/g,
    "<redacted-key>",
  ],
];

/**
 * 自由文本中的敏感键名（T0.2 fail-closed）。比结构化字段的 SENSITIVE_NAME
 * 更宽：自由文本没有形状信息，只要键名命中，值就默认打码——这就是
 * 「未知形态默认打码」。中文键名同样覆盖。
 */
const SENSITIVE_KEY_WORD =
  /(?:authorization|proxy-authorization|cookie|set-cookie|api[_-]?key|token|secret|password|passwd|pwd|credential|private[_-]?key|access[_-]?key|client[_-]?secret|refresh[_-]?token|connection[_-]?string|dsn|bearer|密钥|口令|密码|令牌|凭据)/i;

/** 按键名选语义占位符，尽量保留「这是什么凭据」的上下文。 */
function placeholderForKey(key: string): string {
  const k = key.replace(/^["']|["']$/g, "").toLowerCase();
  if (/passwd|password|pwd|口令|密码/.test(k)) return "{{password}}";
  if (/cookie/.test(k)) return "{{cookie}}";
  if (/authorization|bearer/.test(k)) return "{{authorization}}";
  if (/credential|凭据/.test(k)) return "{{credential}}";
  if (/connection|dsn/.test(k)) return "{{connection_string}}";
  if (/token|令牌/.test(k)) return "{{token}}";
  if (/secret/.test(k)) return "{{secret}}";
  if (/key|密钥/.test(k)) return "{{key}}";
  return "{{secret}}";
}

/**
 * 不应被改写的值：已脱敏标记、模板占位符、注入哨兵、纯标点、HTTP 认证
 * 方案词、普通 URL。跳过它们是「幂等」与「保留非敏感上下文」的关键。
 */
function isSafeValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  // 已脱敏 / 模板 / 哨兵一律原样保留 —— 这是幂等性的保证。
  if (/<redacted[^>]*>|\[REDACTED\]|\{\{[^}]*\}\}|\u0000/.test(trimmed)) return true;
  // 纯标点（例如 `x == y` 里的 `=`）不是凭据。
  if (!/[A-Za-z0-9\u4e00-\u9fa5]/.test(trimmed)) return true;
  // 认证方案词与平凡字面量属于上下文，不是密钥。
  if (/^(?:bearer|basic|digest|ntlm|hawk|oauth|token|aws4-hmac-sha256|none|null|true|false|undefined)$/i.test(trimmed)) return true;
  // 普通 URL（query 里的密钥已由 SECRET_PATTERNS 处理）。
  if (/^(?:https?|wss?|ftp):\/\/[^\s"'`<>@]*$/i.test(trimmed)) return true;
  // `https:` 被当作键时剩下的 `//host/path` 也是普通 URL 路径，不打码。
  if (/^\/\/[^\s<>"'`]*$/.test(trimmed)) return true;
  return false;
}

/** 未知键名的高熵串兜底：长、混合大小写+数字、纯 base64/hex、已知前缀。 */
const LONG_TOKEN = /[A-Za-z0-9+/=_-]{24,}/g;

function isRandomLooking(token: string): boolean {
  // UUID 形式的项目 id 是结构字段，不是凭据。
  if (/^\{?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}?$/.test(token)) return false;
  if (/^(?:eyJ|sk-|pk-|rk-|AKIA|ASIA|gh[pousr]_|glpat-|xox[baprs]-|AIza|SG\.|npm_)/.test(token)) return true;
  const hasUpper = /[A-Z]/.test(token);
  const hasLower = /[a-z]/.test(token);
  const hasDigit = /[0-9]/.test(token);
  const hasBase64Punct = /[+=]/.test(token); // `/` 是 URL 路径分隔符，不算高熵标点
  if (/^[0-9a-fA-F]+$/.test(token) && token.length >= 32) return true;
  // 普通标识符 / 自然语言：长小写词run且无 base64 标点，放行。
  if (!hasBase64Punct && /[a-z]{8}/.test(token)) return false;
  if (hasUpper && hasLower && hasDigit) return true;
  if (token.length >= 28 && (hasBase64Punct || (hasUpper && hasLower))) return true;
  return false;
}

/** 只打码值内部的高熵片段，保留同一行上的其它非敏感内容。 */
function scrubValueTokens(value: string): string {
  LONG_TOKEN.lastIndex = 0;
  return value.replace(LONG_TOKEN, (token: string, offset: number) => {
    if (!isRandomLooking(token)) return token;
    // URL 路径里的长 hex id 属于结构，不打码。
    if (offset > 0 && value[offset - 1] === "/") return token;
    return "<redacted-secret>";
  });
}

/**
 * 长驼峰 / snake 代码标识符（如 `getUserInfoByAccessTokenAndScope`）即使含
 * token 也只是普通变量名，不是凭据字段；避免把 `= 1;` 这类代码打码。
 */
function looksLikeCodeIdentifier(key: string): boolean {
  const clean = key.replace(/^["']|["']$/g, "");
  // 长名字 + 驼峰或下划线分词，且含普通小写词根 —— 是代码变量名而非凭据字段。
  return (
    clean.length >= 20 &&
    /[a-z]{3}/.test(clean) &&
    (/[a-z][A-Z]/.test(clean) || clean.includes("_"))
  );
}

/** 返回替换值；`null` 表示整个匹配原样保留。 */
function maskedValue(key: string, value: string): string | null {
  if (isSafeValue(value)) return null;
  const cleanKey = key.replace(/^["']|["']$/g, "");
  if (SENSITIVE_KEY_WORD.test(cleanKey) && !looksLikeCodeIdentifier(cleanKey)) {
    return placeholderForKey(cleanKey);
  }
  const scrubbed = scrubValueTokens(value);
  return scrubbed === value ? null : scrubbed;
}

// 注意：分隔符只用 [ \t]*，绝不能跨行 —— 否则 YAML 的 `bearerAuth:\n  type:` 会
// 被当成一条赋值，把下一行的 `type: ` 当值吞掉，破坏导出格式的可回导性。
// `"key": "value"` / `'key': 'value'`（JSON、curl -H 的带引号值）。
const QUOTED_ASSIGNMENT = /(["'])([^"']{1,80})\1([ \t]*(?::=?|=|：)[ \t]*)(["'`])([^"'`]*)\4/g;
// 裸键 + 带引号值：`token="abc"` / YAML `password: "abc"`。
const BARE_QUOTED_ASSIGNMENT = /([A-Za-z_\u4e00-\u9fa5][\w.\-\u4e00-\u9fa5]*)([ \t]*(?::=?|=|：)[ \t]*)(["'`])([^"'`]*)\3/g;
// `Header: value` / YAML `key: value` —— 值取到行尾或引号。
const LINE_ASSIGNMENT = /([A-Za-z_\u4e00-\u9fa5][\w.\-\u4e00-\u9fa5]*)([ \t]*[:：][ \t]*)([^\r\n<>"'`]+)/g;
// `key=value` / `?token=...&...` —— 裸值在分隔符处停止。
const PLAIN_ASSIGNMENT = /([A-Za-z_\u4e00-\u9fa5][\w.\-\u4e00-\u9fa5]*)([ \t]*=[ \t]*)([^\s,;{}\[\]"'`&<>#]+)/g;

const PLACEHOLDER_RE = /\{\{[^{}]{0,80}\}\}/g;
const SENTINEL_RE = /\u0000RQ(\d+)\u0000/g;

/**
 * 替换自由文本中的实时凭据。
 *
 * 顺序：已知形态正则 → fail-closed 值级打码（敏感键名 + 未知键高熵兜底）。
 * 模板占位符 `{{token}}` 在处理前被替换成哨兵、处理完原样还原，因此任何
 * 一层都不会误伤它。所有层对已脱敏标记与自身产物均保持不变（幂等）。
 */
export function redactFreeText(input: string): string {
  // (0) 保护模板占位符：这是 `{{token}} 不被误伤` 的硬保证。
  const placeholders: string[] = [];
  let output = input.replace(PLACEHOLDER_RE, (match) => {
    placeholders.push(match);
    return `\u0000RQ${placeholders.length - 1}\u0000`;
  });

  // (1) 已知形态，保持原实现不变。
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    output = output.replace(pattern, replacement);
  }
  for (const [pattern, replacement] of EXTRA_SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    output = output.replace(pattern, replacement);
  }

  // (2) fail-closed 值级打码：最具体的（带引号）先跑，避免被宽松规则二次匹配。
  QUOTED_ASSIGNMENT.lastIndex = 0;
  output = output.replace(
    QUOTED_ASSIGNMENT,
    (match: string, q1: string, key: string, sep: string, q2: string, value: string) => {
      const masked = maskedValue(key, value);
      return masked === null ? match : `${q1}${key}${q1}${sep}${q2}${masked}${q2}`;
    },
  );
  BARE_QUOTED_ASSIGNMENT.lastIndex = 0;
  output = output.replace(
    BARE_QUOTED_ASSIGNMENT,
    (match: string, key: string, sep: string, quote: string, value: string) => {
      const masked = maskedValue(key, value);
      return masked === null ? match : `${key}${sep}${quote}${masked}${quote}`;
    },
  );
  LINE_ASSIGNMENT.lastIndex = 0;
  output = output.replace(
    LINE_ASSIGNMENT,
    (match: string, key: string, sep: string, value: string) => {
      const masked = maskedValue(key, value);
      return masked === null ? match : `${key}${sep}${masked}`;
    },
  );
  PLAIN_ASSIGNMENT.lastIndex = 0;
  output = output.replace(
    PLAIN_ASSIGNMENT,
    (match: string, key: string, sep: string, value: string) => {
      const masked = maskedValue(key, value);
      return masked === null ? match : `${key}${sep}${masked}`;
    },
  );

  // (3) 还原占位符。
  return output.replace(SENTINEL_RE, (_match: string, index: string) => placeholders[Number(index)] ?? "{{var}}");
}

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as AnyRecord)
    : {};
}

function isAuthRecord(key: string, value: unknown): boolean {
  return (
    key === "auth" &&
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as AnyRecord).type === "string"
  );
}

/**
 * Blank every string field of an auth object except identifiers/endpoints.
 * 字段无关：白名单外的字符串一律置空。新增凭据字段默认 fail-closed，
 * 只有显式列进 AUTH_SAFE_FIELDS 的非敏感字段才放行；扩展变体额外按
 * AUTH_SECRET_FIELDS 强制置空（含 username），避免它落在历史白名单里。
 */
export function redactAuth(auth: unknown): AnyRecord {
  const source = asRecord(auth);
  const result: AnyRecord = {};
  const extended =
    source.type === "oauth2" || source.type === "awsSigV4" || source.type === "mtls";
  for (const [key, value] of Object.entries(source)) {
    if (extended && AUTH_SECRET_FIELDS.has(key)) {
      result[key] = typeof value === "string" ? "" : value;
    } else if (AUTH_SAFE_FIELDS.has(key)) {
      result[key] = typeof value === "string" ? redactFreeText(value) : value;
    } else if (typeof value === "string") {
      result[key] = "";
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** KeyValue row shape: id / key / value / enabled (+ optional `secret`). */
function isKeyValue(record: AnyRecord): boolean {
  return (
    typeof record.id === "string" &&
    typeof record.key === "string" &&
    typeof record.value === "string"
  );
}

/** Scenario DB step: `{ url, sql, mode, ... }`. */
function isDbConfig(record: AnyRecord): boolean {
  return typeof record.sql === "string" && "url" in record;
}

/**
 * Deep-copy `input` and redact every credential-shaped value.
 * Returns `unknown` because the shape is preserved by construction; callers
 * that know they passed a snapshot can wrap it with `asRecord()`.
 */
export function redactSnapshot(input: unknown): unknown {
  return walk(input, "");
}

/**
 * Inverse of {@link redactSnapshot}: fill credential holes in `remote` from
 * the local copy, leaving everything else on the remote side.
 *
 * This is a *targeted* restore, not a union merge:
 * - A sensitive scalar is restored only when the remote value is empty.
 * - A free-text value is restored only when it is exactly what redaction
 *   would have produced for the local value; a collaborator's edit wins.
 * - Arrays are paired by index (redaction preserves length/order), so a value
 *   inserted or removed remotely is never shifted onto the wrong local row.
 *
 * Callers must pass the *same shape* as `redactSnapshot` saw (e.g. two rows
 * with the same id). When no local basis exists the remote value is kept.
 */
export function restoreRedacted(remote: unknown, local: unknown): unknown {
  return restoreWalk(remote, local, "");
}

function restoreFreeText(remote: string, local: unknown): string {
  if (typeof local !== "string") return remote;
  // `redactFreeText` is idempotent for unredacted text, so this also covers
  // the common "nothing was redacted" case without touching the value.
  return remote === redactFreeText(local) ? local : remote;
}

function restoreAuth(remote: unknown, local: unknown): AnyRecord {
  const source = asRecord(remote);
  const basis = asRecord(local);
  const result: AnyRecord = {};
  const extended =
    source.type === "oauth2" || source.type === "awsSigV4" || source.type === "mtls";
  for (const [key, value] of Object.entries(source)) {
    if (extended && AUTH_SECRET_FIELDS.has(key)) {
      // 扩展变体的凭据字段被置空，需从本地副本回填。
      result[key] =
        value === "" && typeof basis[key] === "string" && basis[key] !== ""
          ? basis[key]
          : value;
    } else if (AUTH_SAFE_FIELDS.has(key)) {
      result[key] = typeof value === "string" ? restoreFreeText(value, basis[key]) : value;
    } else if (typeof value === "string") {
      // redactAuth blanks every non-safe string field.
      result[key] =
        value === "" && typeof basis[key] === "string" && basis[key] !== ""
          ? basis[key]
          : value;
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** 与 redactTransport 对应：soap / mqtt 的 username/password 为空时从本地回填。 */
function restoreTransport(remote: AnyRecord, local: AnyRecord): AnyRecord {
  const result: AnyRecord = {};
  for (const [key, value] of Object.entries(remote)) {
    if (TRANSPORT_SECRET_FIELDS.has(key) && typeof value === "string") {
      result[key] =
        value === "" && typeof local[key] === "string" && local[key] !== "" ? local[key] : value;
    } else {
      result[key] = restoreWalk(value, local[key], key);
    }
  }
  return result;
}

function restoreWalk(remote: unknown, local: unknown, keyHint: string): unknown {
  if (typeof remote === "string") {
    if (keyHint && SENSITIVE_NAME.test(keyHint)) {
      // Sensitive named scalars are blanked outright (not pattern-rewritten).
      return remote === "" && typeof local === "string" && local !== ""
        ? local
        : remote;
    }
    return restoreFreeText(remote, local);
  }
  if (Array.isArray(remote)) {
    const basis = Array.isArray(local) ? local : [];
    return remote.map((item, index) => restoreWalk(item, basis[index], keyHint));
  }
  if (!remote || typeof remote !== "object") return remote;

  const record = remote as AnyRecord;
  const basis =
    local && typeof local === "object" && !Array.isArray(local)
      ? (local as AnyRecord)
      : {};
  const keyValue = isKeyValue(record);
  const override = keyValue ? record.secret : undefined;
  const forceShare = keyValue && override === false;
  const forceRedact =
    keyValue &&
    (override === true ||
      (override !== false && SENSITIVE_NAME.test(record.key as string)));
  const dbConfig = isDbConfig(record);
  const result: AnyRecord = {};

  for (const [key, value] of Object.entries(record)) {
    if ((key === "soap" || key === "mqtt") && value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = restoreTransport(value as AnyRecord, asRecord(basis[key]));
    } else if (isAuthRecord(key, value)) {
      result[key] = restoreAuth(value, basis[key]);
    } else if (dbConfig && key === "url") {
      result[key] =
        value === "" && typeof basis[key] === "string" && basis[key] !== ""
          ? basis[key]
          : value;
    } else if (forceShare && key === "value") {
      // Redaction kept this verbatim, so the remote value is authoritative.
      result[key] = value;
    } else if (forceRedact && key === "value") {
      result[key] =
        value === "" && typeof basis[key] === "string" && basis[key] !== ""
          ? basis[key]
          : value;
    } else {
      result[key] = restoreWalk(value, basis[key], key);
    }
  }
  return result;
}

/** soap / mqtt 子树只按字段名精确脱敏 username/password，避免误伤全局同名字段。 */
function redactTransport(value: AnyRecord): AnyRecord {
  const result: AnyRecord = {};
  for (const [key, raw] of Object.entries(value)) {
    if (TRANSPORT_SECRET_FIELDS.has(key) && typeof raw === "string") {
      result[key] = "";
    } else {
      result[key] = walk(raw, key);
    }
  }
  return result;
}

function walk(value: unknown, keyHint: string): unknown {
  if (typeof value === "string") {
    // Named scalar fields (`token`, `password`, `clientSecret`, CSV columns,
    // `Record<string,string>` env maps, ...) are blanked outright.
    if (keyHint && SENSITIVE_NAME.test(keyHint)) return "";
    return redactFreeText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, keyHint));
  }
  if (!value || typeof value !== "object") return value;

  const record = value as AnyRecord;
  const keyValue = isKeyValue(record);
  const override = keyValue ? record.secret : undefined;
  const forceShare = keyValue && override === false;
  const forceRedact =
    keyValue &&
    (override === true ||
      (override !== false && SENSITIVE_NAME.test(record.key as string)));
  const dbConfig = isDbConfig(record);
  const result: AnyRecord = {};

  for (const [key, raw] of Object.entries(record)) {
    if ((key === "soap" || key === "mqtt") && raw && typeof raw === "object" && !Array.isArray(raw)) {
      result[key] = redactTransport(raw as AnyRecord);
    } else if (isAuthRecord(key, raw)) {
      result[key] = redactAuth(raw);
    } else if (dbConfig && key === "url") {
      result[key] = "";
    } else if (forceShare && key === "value") {
      // Explicit opt-in: keep verbatim, without free-text pattern rewriting.
      result[key] = raw;
    } else if (forceRedact && key === "value") {
      result[key] = "";
    } else {
      result[key] = walk(raw, key);
    }
  }
  return result;
}
