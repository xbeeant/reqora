import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Braces,
  ChevronDown,
  Download,
  Eye,
  EyeOff,
  Lock,
  Play,
  Radio,
  Save,
  Square,
  Wand2,
} from "lucide-react";
import {
  missingVariables,
  pathVariableKeys,
  resolveRequestUrl,
  variablesFrom,
} from "../lib/template";
import { collectVariableSuggestions } from "../lib/variables.ts";
import { applyBulkEdit, type BulkMode, type BulkRow, type CaseStyle } from "../lib/bulkParams.ts";
import { emptyDoc, emptyParamMeta } from "../lib/defaults.ts";
import { api } from "../lib/api";
import {
  defaultAuth,
  validateAuth,
  generatePkcePair,
  buildAuthorizeUrl,
  type AuthType,
  type OAuth2Auth,
} from "../lib/authProviders";
import { useWorkspace } from "../store/workspace";
import { useT } from "../i18n";
import {
  HTTP_METHODS,
  type AssertionSpec,
  type AuthSpec,
  type BinaryBody,
  type BodySpec,
  type FormDataBody,
  type FormPart,
  type GraphQLBody,
  type HttpMethod,
  type KeyValue,
  type ParamMeta,
  type StreamMode,
} from "../types";
import { AssertionEditor } from "./AssertionEditor";
import { BinaryEditor } from "./BinaryEditor";
import { BulkEditModal } from "./BulkEditModal";
import { FormDataEditor } from "./FormDataEditor";
import { KeyValueTable } from "./KeyValueTable";
import { ScriptEditor } from "./ScriptEditor";
import { VariableInput } from "./VariableInput";
import { Badge, Button, Select, inputClass } from "./ui";

type EditorTab =
  | "params"
  | "headers"
  | "body"
  | "auth"
  | "pre"
  | "post"
  | "assertions"
  | "settings";

type BulkTarget = "query" | "headers" | "formUrlEncoded" | "formData";

const BULK_TITLES: Record<BulkTarget, string> = {
  query: "request.editor.bulk.query",
  headers: "request.editor.bulk.headers",
  formUrlEncoded: "request.editor.bulk.formUrlEncoded",
  formData: "request.editor.bulk.formData",
};

const BODY_TYPES: { value: BodySpec["type"]; label: string }[] = [
  { value: "none", label: "none" },
  { value: "json", label: "JSON" },
  { value: "raw", label: "Raw" },
  { value: "formUrlEncoded", label: "x-www-form-urlencoded" },
  { value: "formData", label: "form-data" },
  { value: "binary", label: "Binary" },
  { value: "graphql", label: "GraphQL" },
];

const LABEL_CLASS = "wb-label";
const enabledCount = (items: KeyValue[]) =>
  items.filter((item) => item.enabled && item.key.trim()).length;

const STREAM_MODES: { value: StreamMode; labelKey: string; hintKey: string }[] = [
  {
    value: "auto",
    labelKey: "request.editor.stream.auto",
    hintKey: "request.editor.stream.auto.hint",
  },
  {
    value: "on",
    labelKey: "request.editor.stream.on",
    hintKey: "request.editor.stream.on.hint",
  },
  {
    value: "off",
    labelKey: "request.editor.stream.off",
    hintKey: "request.editor.stream.off.hint",
  },
];

const HTTP_VERSIONS: { value: "auto" | "http1" | "http2" | "http3"; labelKey?: string; label?: string }[] = [
  { value: "auto", labelKey: "request.editor.httpVersion.auto" },
  { value: "http1", label: "HTTP/1.1" },
  { value: "http2", label: "HTTP/2" },
  { value: "http3", label: "HTTP/3" },
];

const OAUTH_GRANTS: { value: string; labelKey: string }[] = [
  { value: "authorizationCode", labelKey: "request.editor.oauth.grant.authorizationCode" },
  { value: "clientCredentials", labelKey: "request.editor.oauth.grant.clientCredentials" },
  { value: "password", labelKey: "request.editor.oauth.grant.password" },
  { value: "implicit", labelKey: "request.editor.oauth.grant.implicit" },
];

const OAUTH_CLIENT_AUTH: { value: string; labelKey: string }[] = [
  { value: "body", labelKey: "request.editor.oauth.clientAuth.body" },
  { value: "basic", labelKey: "request.editor.oauth.clientAuth.basic" },
];

const MIN_TLS_VERSIONS: { value: string; label: string }[] = [
  { value: "1.2", label: "TLS 1.2" },
  { value: "1.3", label: "TLS 1.3" },
];

// 这三类鉴权的字段与 types.ts 新增的 AuthSpec 变体一一对应。用宽松的本地
// 接口描述，避免与并行落地中的具体类型签名强耦合；写回时统一断言。
interface OAuth2Draft {
  type: "oauth2";
  grant: string;
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  audience: string;
  redirectUri: string;
  state: string;
  username: string;
  password: string;
  pkce: boolean;
  codeVerifier: string;
  code: string;
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresAt: number | string;
  tokenPrefix: string;
  clientAuth: string;
}

interface AwsSigV4Draft {
  type: "awsSigV4";
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  region: string;
  service: string;
  signQuery: boolean;
  expiresIn: number;
  unsignedPayload: boolean;
}

interface MtlsDraft {
  type: "mtls";
  certPem: string;
  keyPem: string;
  caPem: string;
  p12Base64: string;
  passphrase: string;
  minTlsVersion: string;
  serverName: string;
}

type FieldChange<T> = (patch: Partial<T>) => void;

function AuthField({
  label,
  children,
  full = false,
}: {
  label: string;
  children: ReactNode;
  full?: boolean;
}) {
  return (
    <div className={full ? "wb-auth-field-full" : ""}>
      <label className={LABEL_CLASS}>{label}</label>
      {children}
    </div>
  );
}

function AuthTextField({
  label,
  value,
  onChange,
  placeholder,
  password = false,
  mono = false,
  full = false,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  password?: boolean;
  mono?: boolean;
  full?: boolean;
}) {
  return (
    <div className={full ? "wb-auth-field-full" : ""}>
      <label className={LABEL_CLASS}>{label}</label>
      <input
        className={mono ? `${inputClass} font-mono` : inputClass}
        type={password ? "password" : "text"}
        value={value ?? ""}
        placeholder={placeholder}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function OAuth2Panel({
  value,
  onChange,
}: {
  value: OAuth2Draft;
  onChange: FieldChange<OAuth2Draft>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hint, setHint] = useState("");
  const t = useT();
  const isAuthCode = value.grant === "authorizationCode";
  const isImplicit = value.grant === "implicit";
  const isPassword = value.grant === "password";
  const hasToken = !!value.accessToken;

  const expiresText = (() => {
    const raw = value.expiresAt;
    if (raw === undefined || raw === null || raw === "" || raw === 0) return t("request.editor.oauth.expiresUnknown");
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n) || n <= 0) return String(raw);
    const ms = n < 1e12 ? n * 1000 : n;
    try {
      return new Date(ms).toLocaleString("zh-CN", { hour12: false });
    } catch {
      return String(raw);
    }
  })();

  const authorize = async (patch: Partial<OAuth2Draft>) => {
    setBusy(true);
    setError("");
    setHint("");
    try {
      const result = await api.oauth2Authorize({ ...value, ...patch } as OAuth2Auth);
      if (result && typeof result === "object") {
        onChange(result as Partial<OAuth2Draft>);
      }
      setHint(t("request.editor.oauth.hint.authorized"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("request.editor.oauth.error.authorize"));
    } finally {
      setBusy(false);
    }
  };

  const openAuthorize = async () => {
    setError("");
    setHint("");
    try {
      const pair = await generatePkcePair();
      const verifier = pair.verifier;
      const challenge = pair.challenge;
      const state =
        globalThis.crypto?.randomUUID?.() ??
        `st_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      const config = { ...value, codeVerifier: verifier, state };
      onChange({ codeVerifier: verifier, state });
      const url = buildAuthorizeUrl(config as OAuth2Auth, state, challenge);
      void api.openUrl(String(url));
      setHint(t("request.editor.oauth.hint.browser"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("request.editor.oauth.error.openBrowser"));
    }
  };

  return (
    <div className="space-y-3">
      <div className="wb-auth-grid">
        <AuthField label={t("request.editor.oauth.label.grant")}>
          <Select value={value.grant} onChange={(event) => onChange({ grant: event.target.value })}>
            {OAUTH_GRANTS.map((item) => (
              <option key={item.value} value={item.value}>{t(item.labelKey)}</option>
            ))}
          </Select>
        </AuthField>
        <AuthField label={t("request.editor.oauth.label.clientAuth")}>
          <Select
            value={value.clientAuth}
            onChange={(event) => onChange({ clientAuth: event.target.value })}
          >
            {OAUTH_CLIENT_AUTH.map((item) => (
              <option key={item.value} value={item.value}>{t(item.labelKey)}</option>
            ))}
          </Select>
        </AuthField>
        <AuthTextField
          label={t("request.editor.oauth.label.authUrl")}
          value={value.authUrl}
          onChange={(authUrl) => onChange({ authUrl })}
          placeholder="https://idp.example.com/oauth2/authorize"
          full
        />
        <AuthTextField
          label={t("request.editor.oauth.label.tokenUrl")}
          value={value.tokenUrl}
          onChange={(tokenUrl) => onChange({ tokenUrl })}
          placeholder="https://idp.example.com/oauth2/token"
          full
        />
        <AuthTextField label="Client ID" value={value.clientId} onChange={(clientId) => onChange({ clientId })} />
        <AuthTextField
          label="Client Secret"
          value={value.clientSecret}
          onChange={(clientSecret) => onChange({ clientSecret })}
          password
        />
        <AuthTextField label={t("request.editor.oauth.label.scope")} value={value.scope} onChange={(scope) => onChange({ scope })} placeholder="openid profile" />
        <AuthTextField label={t("request.editor.oauth.label.audience")} value={value.audience} onChange={(audience) => onChange({ audience })} />
        <AuthTextField
          label={t("request.editor.oauth.label.redirectUri")}
          value={value.redirectUri}
          onChange={(redirectUri) => onChange({ redirectUri })}
          placeholder="http://127.0.0.1/callback"
          full
        />
        <AuthTextField label={t("request.editor.oauth.label.tokenPrefix")} value={value.tokenPrefix} onChange={(tokenPrefix) => onChange({ tokenPrefix })} placeholder="Bearer" />
        {isPassword && (
          <>
            <AuthTextField label={t("request.editor.oauth.label.username")} value={value.username} onChange={(username) => onChange({ username })} />
            <AuthTextField label={t("request.editor.oauth.label.password")} value={value.password} onChange={(password) => onChange({ password })} password />
          </>
        )}
      </div>

      <label className="inline-flex items-center gap-1.5 text-[11px] text-ink-soft">
        <input
          type="checkbox"
          className="accent-brand-500"
          checked={!!value.pkce}
          onChange={(event) => onChange({ pkce: event.target.checked })}
        />
        {t("request.editor.oauth.pkce")}
      </label>

      {hasToken && (
        <div className="wb-auth-help">
          {t("request.editor.oauth.tokenInfo", {
            type: value.tokenType
              ? t("request.editor.oauth.tokenTypeSuffix", { type: value.tokenType })
              : "",
            expires: expiresText,
          })}
          {value.refreshToken ? t("request.editor.oauth.hasRefresh") : ""}
          {t("request.editor.oauth.tokenLocalOnly")}
        </div>
      )}

      <div className="wb-auth-actions">
        <Button
          size="sm"
          variant="primary"
          disabled={busy}
          onClick={() => (isAuthCode || isImplicit ? void openAuthorize() : void authorize({}))}
        >
          {busy ? t("request.editor.oauth.busy") : t("request.editor.oauth.getToken")}
        </Button>
        {isAuthCode && (
          <Button
            size="sm"
            disabled={busy || !value.code?.trim()}
            onClick={() => void authorize({ code: value.code })}
          >
            {t("request.editor.oauth.exchange")}
          </Button>
        )}
      </div>

      {isAuthCode && (
        <AuthTextField
          label={t("request.editor.oauth.label.code")}
          value={value.code}
          onChange={(code) => onChange({ code })}
          placeholder={t("request.editor.oauth.placeholder.code")}
          full
        />
      )}

      {hint && <p className="wb-auth-help">{hint}</p>}
      {error && <div className="wb-auth-error">{error}</div>}

      <p className="wb-auth-help">
        {t("request.editor.oauth.help")}
      </p>
    </div>
  );
}

function AwsSigV4Panel({
  value,
  onChange,
}: {
  value: AwsSigV4Draft;
  onChange: FieldChange<AwsSigV4Draft>;
}) {
  const t = useT();
  return (
    <div className="space-y-3">
      <div className="wb-auth-grid">
        <AuthTextField label="Access Key ID" value={value.accessKeyId} onChange={(accessKeyId) => onChange({ accessKeyId })} />
        <AuthTextField
          label="Secret Access Key"
          value={value.secretAccessKey}
          onChange={(secretAccessKey) => onChange({ secretAccessKey })}
          password
        />
        <AuthTextField
          label={t("request.editor.aws.label.sessionToken")}
          value={value.sessionToken}
          onChange={(sessionToken) => onChange({ sessionToken })}
          password
        />
        <AuthTextField label="Region" value={value.region} onChange={(region) => onChange({ region })} placeholder="us-east-1" />
        <AuthTextField label="Service" value={value.service} onChange={(service) => onChange({ service })} placeholder="execute-api / s3" />
        <AuthField label={t("request.editor.aws.label.expiresIn")}>
          <input
            className={inputClass}
            type="number"
            min={1}
            value={value.expiresIn ?? 3600}
            aria-label={t("request.editor.aws.expiresIn.aria")}
            onChange={(event) => onChange({ expiresIn: Number(event.target.value) })}
          />
        </AuthField>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <label className="inline-flex items-center gap-1.5 text-[11px] text-ink-soft">
          <input
            type="checkbox"
            className="accent-brand-500"
            checked={!!value.signQuery}
            onChange={(event) => onChange({ signQuery: event.target.checked })}
          />
          {t("request.editor.aws.signQuery")}
        </label>
        <label className="inline-flex items-center gap-1.5 text-[11px] text-ink-soft">
          <input
            type="checkbox"
            className="accent-brand-500"
            checked={!!value.unsignedPayload}
            onChange={(event) => onChange({ unsignedPayload: event.target.checked })}
          />
          {t("request.editor.aws.unsignedPayload")}
        </label>
      </div>
      <p className="wb-auth-help">
        {t("request.editor.aws.help")}
      </p>
    </div>
  );
}

function MtlsPanel({
  value,
  onChange,
}: {
  value: MtlsDraft;
  onChange: FieldChange<MtlsDraft>;
}) {
  const t = useT();
  const pick = async (field: "certPem" | "keyPem" | "caPem") => {
    try {
      const file = await api.pickAndReadText();
      if (file?.content) onChange({ [field]: file.content } as Partial<MtlsDraft>);
    } catch {
      // 用户取消选择或读取失败：保持原值，不写日志、不展示凭据内容。
    }
  };

  const pemField = (label: string, field: "certPem" | "keyPem" | "caPem", placeholder: string) => (
    <AuthField label={label} full>
      <div className="mb-1 flex justify-end">
        <button
          type="button"
          className="wb-chip !h-6 !px-2 !text-[10px]"
          onClick={() => void pick(field)}
        >
          {t("request.editor.mtls.pickFile")}
        </button>
      </div>
      <textarea
        className={`${inputClass} wb-auth-textarea`}
        value={value[field] ?? ""}
        placeholder={placeholder}
        aria-label={label}
        spellCheck={false}
        onChange={(event) => onChange({ [field]: event.target.value } as Partial<MtlsDraft>)}
      />
    </AuthField>
  );

  return (
    <div className="space-y-3">
      <div className="wb-auth-grid">
        {pemField(t("request.editor.mtls.label.certPem"), "certPem", "-----BEGIN CERTIFICATE-----")}
        {pemField(t("request.editor.mtls.label.keyPem"), "keyPem", "-----BEGIN PRIVATE KEY-----")}
        {pemField(t("request.editor.mtls.label.caPem"), "caPem", "-----BEGIN CERTIFICATE-----")}
        <AuthTextField
          label={t("request.editor.mtls.label.passphrase")}
          value={value.passphrase}
          onChange={(passphrase) => onChange({ passphrase })}
          password
        />
        <AuthField label={t("request.editor.mtls.label.minTls")}>
          <Select
            value={value.minTlsVersion ?? "1.2"}
            onChange={(event) => onChange({ minTlsVersion: event.target.value })}
          >
            {MIN_TLS_VERSIONS.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </Select>
        </AuthField>
        <AuthTextField
          label={t("request.editor.mtls.label.serverName")}
          value={value.serverName}
          onChange={(serverName) => onChange({ serverName })}
        />
        <AuthField label={t("request.editor.mtls.label.p12")} full>
          <textarea
            className={`${inputClass} wb-auth-textarea`}
            value={value.p12Base64 ?? ""}
            placeholder={t("request.editor.mtls.placeholder.p12")}
            aria-label="PKCS#12 Base64"
            spellCheck={false}
            onChange={(event) => onChange({ p12Base64: event.target.value })}
          />
        </AuthField>
      </div>
      <p className="wb-auth-help">
        {t("request.editor.mtls.help")}
      </p>
    </div>
  );
}

export function RequestEditor() {
  const t = useT();
  const [showVariableValues, setShowVariableValues] = useState(false);
  const [bulkTarget, setBulkTarget] = useState<BulkTarget | null>(null);
  // Split-button menu for send modes. Fixed positioning (like the custom
  // Select) keeps it out of the URL bar's clipping/stacking context.
  const [sendMenu, setSendMenu] = useState<{ left: number; top: number } | null>(null);
  const sendToggleRef = useRef<HTMLButtonElement>(null);

  const draft = useWorkspace((state) => state.draft);
  // 只订阅编辑器需要的域：接口编辑期间用例 / 环境以外的快照变化不再触发
  // 整个编辑器重渲染。
  const environments = useWorkspace((state) => state.snapshot.environments);
  const activeEnvironmentId = useWorkspace((state) => state.snapshot.activeEnvironmentId);
  const allCases = useWorkspace((state) => state.snapshot.cases);
  const settings = useWorkspace((state) => state.snapshot.settings);
  const scriptOutcome = useWorkspace((state) => state.scriptOutcome);
  const activeTab = useWorkspace((state) => state.activeTab);
  const setDraft = useWorkspace((state) => state.setDraft);
  const updateCase = useWorkspace((state) => state.updateCase);
  const updateDoc = useWorkspace((state) => state.updateDoc);
  const isSending = useWorkspace((state) => state.isSending);
  const send = useWorkspace((state) => state.send);
  const cancelSend = useWorkspace((state) => state.cancelSend);
  const saveRequest = useWorkspace((state) => state.saveRequest);
  const setEnvironmentModalOpen = useWorkspace((state) => state.setEnvironmentModalOpen);
  /** A frozen centre tab (run or revision) is read-only, but still sendable. */
  const readOnly = useWorkspace(
    (state) =>
      state.activeTab?.kind === "history" || state.activeTab?.kind === "revision",
  );
  const introspecting = useWorkspace((state) => state.introspecting);
  const introspectionSchema = useWorkspace((state) => state.introspectionSchema);
  const introspectionError = useWorkspace((state) => state.introspectionError);
  const introspect = useWorkspace((state) => state.introspect);
  const clearIntrospection = useWorkspace((state) => state.clearIntrospection);

  const activeEnvironment = environments.find(
    (environment) => environment.id === activeEnvironmentId,
  );
  const isCaseTab = activeTab?.kind === "case";
  // 用例标签激活时，编辑器里的名称输入框代表这条用例（而不是接口）：
  // 显示/编辑用例名，走 updateCase；接口标签下仍编辑 draft.name。
  const activeCase =
    activeTab?.kind === "case"
      ? allCases.find((item) => item.id === activeTab.id) ?? null
      : null;
  const variables = useMemo(
    () => variablesFrom(activeEnvironment?.variables ?? []),
    [activeEnvironment],
  );
  const suggestions = useMemo(
    () =>
      collectVariableSuggestions({
        environmentVariables: activeEnvironment?.variables ?? [],
        url: draft.url,
      }),
    [activeEnvironment, draft.url],
  );
  const pathKeys = useMemo(() => pathVariableKeys(draft.url), [draft.url]);
  // One row per placeholder found in the URL; values live in the draft so
  // they survive saving / tab switching / project switching.
  const pathRows = useMemo<KeyValue[]>(() => {
    const stored = draft.pathVariables ?? [];
    return pathKeys.map((key) => {
      const found = stored.find((item) => item.key === key);
      return found ?? { id: `path:${key}`, key, value: "", enabled: true };
    });
  }, [pathKeys, draft.pathVariables]);
  const unfilledPathKeys = pathRows
    .filter((row) => !row.value.trim())
    .map((row) => row.key);
  const resolvedPreview = useMemo(
    () => resolveRequestUrl(draft.url, pathRows, variables),
    [draft.url, pathRows, variables],
  );
  const setPathValue = (key: string, value: string) => {
    const rows = draft.pathVariables ?? [];
    const kept = rows.filter((item) => item.key !== key);
    const previous = rows.find((item) => item.key === key);
    setDraft({
      pathVariables:
        value === ""
          ? kept
          : [
              ...kept,
              {
                id: `path:${key}`,
                key,
                value,
                enabled: true,
                // Rebuilding the row must not drop the upload-redaction override.
                ...(previous?.secret === undefined ? {} : { secret: previous.secret }),
              },
            ],
    });
  };
  const streamMode: StreamMode = draft.stream ?? "auto";
  const cycleStreamMode = () => {
    const index = STREAM_MODES.findIndex((item) => item.value === streamMode);
    setDraft({ stream: STREAM_MODES[(index + 1) % STREAM_MODES.length].value });
  };
  const unresolved = useMemo(
    () => missingVariables(JSON.stringify(draft), variables),
    [draft, variables],
  );
  const warningText = [
    unresolved.length
      ? t("request.editor.warn.unresolved", { count: unresolved.length })
      : "",
    unfilledPathKeys.length
      ? t("request.editor.warn.pathUnfilled", { count: unfilledPathKeys.length })
      : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const protocol = draft.protocol ?? "http";
  // SOAP 走 HTTP 发送链，保留 Body 页；WS / TCP / MQTT 没有请求体。
  const showBody = protocol === "http" || protocol === "soap";
  // 进入无 Body 的协议时把子标签移开，离开时恢复 Body 编辑器。
  const [tab, setTab] = useState<EditorTab>("params");
  useEffect(() => {
    if (!showBody && tab === "body") setTab("params");
  }, [showBody, tab]);

  const body = draft.body;
  const auth = draft.auth;
  const isAdvancedAuth = ["oauth2", "awsSigV4", "mtls"].includes(auth.type);
  const authErrors = isAdvancedAuth ? validateAuth(auth) ?? [] : [];
  const setBody = (next: BodySpec) => setDraft({ body: next });
  const setAuth = (next: AuthSpec) => setDraft({ auth: next });
  const setAssertions = (items: AssertionSpec[]) => setDraft({ assertions: items });

  const rowsForBulk = (target: BulkTarget): KeyValue[] => {
    if (target === "query") return draft.query;
    if (target === "headers") return draft.headers;
    return draft.body.type === "formUrlEncoded" || draft.body.type === "formData"
      ? draft.body.items
      : [];
  };

  const applyBulk = ({
    rows,
    caseStyle,
    mode,
  }: {
    rows: BulkRow[];
    caseStyle: CaseStyle;
    mode: BulkMode;
  }) => {
    const target = bulkTarget;
    if (!target) return;
    const current = rowsForBulk(target);
    // File parts hold base64 bytes; they must never show up in the text editor
    // or be overwritten by a pasted key with the same name.
    const fileParts =
      target === "formData" ? (current as FormPart[]).filter((part) => part.file === true) : [];
    // `applyBulkEdit` reuses the id of rows with the same key, so the doc
    // metadata (`q:<id>` / `h:<id>` / `b:<id>`) keeps pointing at them.
    const { items, descriptions } = applyBulkEdit({
      existing: target === "formData" ? current.filter((item) => !(item as FormPart).file) : current,
      rows,
      caseStyle,
      mode,
    });

    if (target === "query") setDraft({ query: items });
    else if (target === "headers") setDraft({ headers: items });
    else if (target === "formUrlEncoded") setBody({ type: "formUrlEncoded", items });
    else {
      const parts: FormPart[] = [
        ...items.map((item) => ({ ...item, file: false, fileName: "", contentType: "" })),
        // Append keeps previously picked files; replace clears the whole form.
        ...(mode === "append" ? fileParts : []),
      ];
      setBody({ type: "formData", items: parts });
    }

    // The "带描述" column feeds the doc's parameter descriptions. Doc edits
    // are metadata and save immediately, without bumping request.updatedAt.
    const prefix = target === "query" ? "q" : target === "headers" ? "h" : "b";
    const base = draft.doc ?? emptyDoc();
    const paramMeta: Record<string, ParamMeta> = { ...base.paramMeta };
    let changed = false;
    for (const [id, description] of Object.entries(descriptions)) {
      const key = `${prefix}:${id}`;
      const current = paramMeta[key] ?? emptyParamMeta();
      if (current.description === description) continue;
      paramMeta[key] = { ...current, description };
      changed = true;
    }
    if (changed) updateDoc({ paramMeta });
    setBulkTarget(null);
  };

  const jsonError = useMemo(() => {
    if (body.type !== "json" || !body.content.trim()) return null;
    try {
      JSON.parse(body.content);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "JSON 无效";
    }
  }, [body]);

  const formatJson = () => {
    if (body.type !== "json") return;
    try {
      setBody({ type: "json", content: JSON.stringify(JSON.parse(body.content), null, 2) });
    } catch {
      // jsonError already explains the problem; the raw body stays untouched.
    }
  };

  const tabs: { key: EditorTab; label: string; badge?: number }[] = [
    { key: "params", label: "Params", badge: enabledCount(draft.query) },
    { key: "headers", label: "Headers", badge: enabledCount(draft.headers) },
    ...(!showBody
      ? []
      : [
          { key: "body" as EditorTab, label: "Body", badge: body.type === "none" ? undefined : 1 },
        ]),
    { key: "auth", label: "Auth", badge: auth.type === "none" ? undefined : 1 },
    { key: "pre", label: "Pre-request Script", badge: draft.preScript?.trim() ? 1 : undefined },
    { key: "post", label: t("request.editor.tab.post"), badge: draft.postScript?.trim() ? 1 : undefined },
    { key: "assertions", label: "Assertions", badge: draft.assertions?.length },
    { key: "settings", label: "Settings" },
  ];

  // WebSocket / TCP requests are debugged from their dedicated panels; the URL
  // bar keeps the resolver + settings, but the HTTP send button is meaningless.
  const isWs = protocol === "ws";
  const isTcp = protocol === "tcp";
  const isMqtt = protocol === "mqtt";
  const isSoap = protocol === "soap";
  // MQTT 由专属面板发布 / 订阅，没有「发送 / 历史 / 压测」这些 HTTP 动作。
  const hideHttpActions = isWs || isMqtt;

  const toggleSendMenu = () => {
    if (isSending) return;
    if (sendMenu) {
      setSendMenu(null);
      return;
    }
    const rect = sendToggleRef.current?.getBoundingClientRect();
    if (!rect) return;
    setSendMenu({ left: Math.max(8, rect.right - 248), top: rect.bottom + 6 });
  };

  return (
    <section className="wb-pane h-full">
      <div className="wb-req-bar">
        {isWs ? (
          <span
            className="inline-flex h-[34px] w-[62px] shrink-0 items-center justify-center rounded-[7px] border border-surface-border bg-surface-muted text-[11px] font-bold wb-method-ws"
            title={t("request.editor.title.ws")}
          >
            WS
          </span>
        ) : isTcp ? (
          <span
            className="inline-flex h-[34px] w-[62px] shrink-0 items-center justify-center rounded-[7px] border border-surface-border bg-surface-muted text-[11px] font-bold wb-method-ws"
            title={t("request.editor.title.tcp")}
          >
            TCP
          </span>
        ) : isMqtt ? (
          <span
            className="inline-flex h-[34px] w-[62px] shrink-0 items-center justify-center rounded-[7px] border border-surface-border bg-surface-muted text-[11px] font-bold wb-method-ws"
            title={t("request.editor.title.mqtt")}
          >
            MQTT
          </span>
        ) : (
          <Select
            className="wb-method-select !px-2"
            value={draft.method}
            disabled={readOnly}
            aria-label={t("request.editor.method.aria")}
            onChange={(event) => setDraft({ method: event.target.value as HttpMethod })}
          >
            {HTTP_METHODS.map((method) => (
              <option key={method} value={method}>
                <span className={`wb-method-${method.toLowerCase()}`}>{method}</span>
              </option>
            ))}
          </Select>
        )}
        <VariableInput
          className="wb-url-input"
          value={draft.url}
          onChange={(url) => setDraft({ url })}
          disabled={readOnly}
          suggestions={suggestions}
          placeholder={
            isWs
              ? t("request.editor.url.placeholder.ws")
              : isTcp
                ? t("request.editor.url.placeholder.tcp")
                : isMqtt
                  ? t("request.editor.url.placeholder.mqtt")
                  : isSoap
                    ? t("request.editor.url.placeholder.soap")
                    : t("request.editor.url.placeholder.http")
          }
          ariaLabel={
            isWs
              ? t("request.editor.url.aria.ws")
              : isTcp
                ? t("request.editor.url.aria.tcp")
                : isMqtt
                  ? t("request.editor.url.aria.mqtt")
                  : isSoap
                    ? t("request.editor.url.aria.soap")
                    : t("request.editor.url.aria.http")
          }
          spellCheck={false}
        />
        {!hideHttpActions && (
          <div className="wb-send-group">
            <button
              type="button"
              className={`wb-btn ${isSending ? "wb-btn-danger" : "wb-btn-primary"}`}
              onClick={() => (isSending ? cancelSend() : void send())}
            >
              {isSending ? (
                <>
                  <Square className="h-3.5 w-3.5" />
                  {t("request.editor.cancel")}
                </>
              ) : (
                <>
                  <Play className="h-3.5 w-3.5" />
                  {t("request.editor.send")}
                </>
              )}
            </button>
            <button
              ref={sendToggleRef}
              type="button"
              className={`wb-btn wb-send-toggle ${isSending ? "wb-btn-danger" : "wb-btn-primary"}`}
              disabled={isSending}
              aria-haspopup="menu"
              aria-expanded={sendMenu !== null}
              aria-label={t("request.editor.sendMenu.aria")}
              title={t("request.editor.sendMenu.title")}
              onClick={toggleSendMenu}
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {!hideHttpActions && sendMenu && (
          <>
            <div className="fixed inset-0 z-40" onMouseDown={() => setSendMenu(null)} />
            <div
              role="menu"
              className="wb-send-menu fixed z-50"
              style={{ left: sendMenu.left, top: sendMenu.top, width: 248 }}
            >
              <button
                type="button"
                role="menuitem"
                className="wb-send-menu-item"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setSendMenu(null);
                  void send();
                }}
              >
                <Play className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="flex min-w-0 flex-col items-start">
                  <span>{t("request.editor.send")}</span>
                  <span className="wb-send-menu-hint">{t("request.editor.sendMenu.normalHint")}</span>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="wb-send-menu-item"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setSendMenu(null);
                  void send({ download: true });
                }}
              >
                <Download className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="flex min-w-0 flex-col items-start">
                  <span>{t("request.editor.sendAndDownload")}</span>
                  <span className="wb-send-menu-hint">{t("request.editor.sendAndDownload.hint")}</span>
                </span>
              </button>
            </div>
          </>
        )}
        {/* On a case tab the dedicated "save case" button lives in the case
            bar; keep the interface save button out of sight to avoid two
            similarly labelled save actions. ⌘/Ctrl+S still saves the case. */}
        {!readOnly && !isCaseTab && (
          <button type="button" className="wb-btn wb-btn-ghost" onClick={saveRequest} title={t("request.editor.save.title")}>
            <Save className="h-3.5 w-3.5" />
            {t("request.editor.save")}
          </button>
        )}
      </div>

      <div className="wb-resolved">
        <Braces className="h-3 w-3 shrink-0" />
        <input
          className="w-36 shrink-0 rounded border border-surface-border bg-surface px-1.5 py-0.5 text-[11px] font-semibold text-ink outline-none placeholder:text-ink-faint focus:border-brand-400"
          value={activeCase ? activeCase.name : draft.name}
          aria-label={activeCase ? t("request.editor.name.aria.case") : t("request.editor.name.aria.request")}
          title={
            activeCase
              ? t("request.editor.name.title.case")
              : t("request.editor.name.title.request")
          }
          readOnly={readOnly}
          placeholder={activeCase ? t("request.editor.name.placeholder.case") : t("request.editor.name.placeholder.request")}
          onChange={(event) =>
            activeCase
              ? updateCase(activeCase.id, { name: event.target.value })
              : setDraft({ name: event.target.value })
          }
        />
        <span className="text-ink-faint">→</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-soft" title={resolvedPreview}>
          {resolvedPreview || "—"}
        </span>
        {/* Compact variant: never force !h-* on the segment or the labels clip. */}
        <div className="wb-segment wb-segment-xs" role="group" aria-label={t("request.editor.protocol.aria")}>
          <button
            type="button"
            className={draft.protocol === "http" ? "active" : ""}
            disabled={readOnly}
            title={t("request.editor.protocol.title.http")}
            onClick={() => setDraft({ protocol: "http" })}
          >
            HTTP
          </button>
          <button
            type="button"
            className={draft.protocol === "ws" ? "active" : ""}
            disabled={readOnly}
            title={t("request.editor.protocol.title.ws")}
            onClick={() => setDraft({ protocol: "ws" })}
          >
            WS
          </button>
          <button
            type="button"
            className={draft.protocol === "tcp" ? "active" : ""}
            disabled={readOnly}
            title={t("request.editor.protocol.title.tcp")}
            onClick={() => setDraft({ protocol: "tcp" })}
          >
            TCP
          </button>
          <button
            type="button"
            className={draft.protocol === "mqtt" ? "active" : ""}
            disabled={readOnly}
            title={t("request.editor.protocol.title.mqtt")}
            onClick={() => setDraft({ protocol: "mqtt" })}
          >
            MQTT
          </button>
          <button
            type="button"
            className={draft.protocol === "soap" ? "active" : ""}
            disabled={readOnly}
            title={t("request.editor.protocol.title.soap")}
            onClick={() => setDraft({ protocol: "soap" })}
          >
            SOAP
          </button>
        </div>
        {!isTcp && !isMqtt && !isSoap && (
          <button
            type="button"
            className={`wb-chip !h-6 !px-2 !text-[10px] ${
              streamMode !== "auto" ? "!border-brand-400 !text-brand-600" : ""
            }`}
            disabled={readOnly}
            title={t("request.editor.sse.title")}
            onClick={cycleStreamMode}
          >
            <Radio className="h-3 w-3" />
            SSE {t(STREAM_MODES.find((item) => item.value === streamMode)?.labelKey ?? "")}
          </button>
        )}
        {readOnly && (
          <span className="wb-chip !h-6 !px-2 !text-[10px]" title={t("request.editor.readonly.title")}>
            <Lock className="h-3 w-3" />
            {t("request.editor.readonly")}
          </span>
        )}
        {warningText && <Badge tone="warning">{warningText}</Badge>}
        <span className="hidden shrink-0 text-ink-faint xl:inline">
          TLS {settings.verifyTls ? t("request.editor.tls.on") : t("request.editor.tls.off")} · {settings.timeoutSecs}s
        </span>
      </div>

      <div className="wb-cfg-tabs scrollbar-thin">
        {tabs.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`wb-cfg-tab ${tab === item.key ? "active" : ""}`}
            onClick={() => setTab(item.key)}
          >
            {item.label}
            {!!item.badge && <span className="wb-mini-badge">{item.badge}</span>}
          </button>
        ))}
      </div>

      {/* A disabled fieldset freezes every form control in the editor while
          keeping the sub-tab switcher above it usable for inspection. */}
      <fieldset disabled={readOnly} className="wb-cfg-fieldset">
      <div className="wb-cfg-body scrollbar-thin">
        {tab === "params" && (
          <div className="space-y-3">
            {pathKeys.length > 0 && !isTcp && (
              <div className="overflow-hidden rounded-md border border-surface-border bg-surface">
                <div className="flex flex-wrap items-center gap-2 border-b border-surface-border bg-surface-muted px-2.5 py-1.5 text-2xs text-ink-faint">
                  <span className="font-semibold text-ink-soft">{t("request.editor.path.title")}</span>
                  <span className="wb-mini-badge">{pathKeys.length}</span>
                  <span>
                    {t("request.editor.path.hint.pre")}{" "}
                    <code className="font-mono">:id</code>{" "}
                    {t("request.editor.path.hint.mid")}{" "}
                    <code className="font-mono">{"{id}"}</code>{" "}
                    {t("request.editor.path.hint.post")}{" "}
                    <code className="font-mono">{"{{变量}}"}</code>
                    {t("request.editor.path.hint.tail")}
                  </span>
                </div>
                {pathRows.map((row) => (
                  <div key={row.key} className="wb-path-row">
                    <div className="border-r border-surface-border px-2 py-1 font-mono text-xs font-semibold text-brand-600">
                      :{row.key}
                    </div>
                    <VariableInput
                      className="h-9 w-full border-0 bg-transparent px-2 font-mono text-xs text-ink outline-none placeholder:text-ink-faint focus:bg-brand-50/40"
                      value={row.value}
                      onChange={(value) => setPathValue(row.key, value)}
                      suggestions={suggestions}
                      placeholder={t("request.editor.path.valuePlaceholder")}
                      ariaLabel={t("request.editor.path.valueAria", { key: row.key })}
                    />
                  </div>
                ))}
                {unfilledPathKeys.length > 0 && (
                  <div className="border-t border-surface-border bg-amber-50/60 px-2.5 py-1.5 text-2xs text-amber-700">
                    {t("request.editor.path.unfilled", { count: unfilledPathKeys.length })}
                    <span className="font-mono">
                      {" "}
                      {unfilledPathKeys.map((key) => `:${key}`).join(" ")}
                    </span>
                  </div>
                )}
              </div>
            )}
            <KeyValueTable
              items={draft.query}
              onChange={(query) => setDraft({ query })}
              keyPlaceholder="request.editor.query.keyPlaceholder"
              valuePlaceholder="request.editor.query.valuePlaceholder"
              suggestions={suggestions}
              showSecret
              onBulkEdit={() => setBulkTarget("query")}
            />
            <p className="wb-hint">
              {t("request.editor.params.hint.1")}{" "}
              <code className="font-mono">{"{{"}</code>{" "}
              {t("request.editor.params.hint.2")}
              <code className="font-mono">{"{{VAR}}"}</code>{" "}
              {t("request.editor.params.hint.3")}
              <code className="font-mono">{'{{$uuid}}'}</code>{" "}
              {t("request.editor.params.hint.4")}
            </p>
          </div>
        )}

        {tab === "headers" && (
          <KeyValueTable
            items={draft.headers}
            onChange={(headers) => setDraft({ headers })}
              keyPlaceholder="request.editor.headers.keyPlaceholder"
              valuePlaceholder="request.editor.headers.valuePlaceholder"
              suggestions={suggestions}
              showSecret
              onBulkEdit={() => setBulkTarget("headers")}
            />
        )}

        {tab === "body" && (
          <div className="space-y-3">
            <div className="wb-segment">
              {BODY_TYPES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={body.type === option.value ? "active" : ""}
                  onClick={() => {
                    if (option.value === "json") setBody({ type: "json", content: "" });
                    else if (option.value === "raw")
                      setBody({ type: "raw", content: "", contentType: "text/plain" });
                    else if (option.value === "formUrlEncoded")
                      setBody({ type: "formUrlEncoded", items: [] });
                    else if (option.value === "formData")
                      setBody({ type: "formData", items: [] });
                    else if (option.value === "binary")
                      setBody({ type: "binary", data: "", fileName: "", contentType: "" });
                    else if (option.value === "graphql")
                      setBody({ type: "graphql", query: "", variables: "" });
                    else setBody({ type: "none" });
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>

            {body.type === "none" && (
              <p className="wb-hint !py-8 text-center">{t("request.editor.body.none")}</p>
            )}

            {(body.type === "json" || body.type === "raw") && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-2xs text-ink-faint">
                    {body.type === "json"
                      ? "application/json; charset=utf-8"
                      : body.contentType || "text/plain"}
                  </span>
                  {body.type === "json" && (
                    <button
                      type="button"
                      className="wb-chip !h-6 !px-2 !text-[10px]"
                      disabled={jsonError !== null || !body.content.trim()}
                      onClick={formatJson}
                    >
                      <Wand2 className="h-3 w-3" />
                      {t("request.editor.body.formatJson")}
                    </button>
                  )}
                  {jsonError && (
                    <Badge tone="warning">
                      <Braces className="mr-1 h-3 w-3" />
                      {t("request.editor.body.jsonHint")}
                    </Badge>
                  )}
                </div>
                {body.type === "raw" && (
                  <div className="max-w-sm">
                    <label className={LABEL_CLASS}>Content-Type</label>
                    <VariableInput
                      className={`${inputClass} font-mono`}
                      value={body.contentType}
                      suggestions={suggestions}
                      ariaLabel="Content-Type"
                      onChange={(contentType) =>
                        setBody({ type: "raw", content: body.content, contentType })
                      }
                    />
                  </div>
                )}
                <div className="wb-script-main !h-52">
                  <VariableInput
                    multiline
                    className="wb-code scrollbar-thin"
                    value={body.content}
                    suggestions={suggestions}
                    spellCheck={false}
                    placeholder={body.type === "json" ? '{\n  "key": "value"\n}' : t("request.editor.body.rawPlaceholder")}
                    ariaLabel={t("request.editor.body.aria")}
                    onChange={(content) =>
                      body.type === "json"
                        ? setBody({ type: "json", content })
                        : setBody({ type: "raw", content, contentType: body.contentType })
                    }
                  />
                </div>
                {jsonError && <p className="text-2xs text-amber-700">{jsonError}</p>}
              </>
            )}

            {body.type === "formUrlEncoded" && (
              <KeyValueTable
                items={body.items}
                onChange={(items) => setBody({ type: "formUrlEncoded", items })}
                keyPlaceholder="request.editor.body.form.keyPlaceholder"
                valuePlaceholder="request.editor.body.form.valuePlaceholder"
                suggestions={suggestions}
                onBulkEdit={() => setBulkTarget("formUrlEncoded")}
              />
            )}

            {body.type === "formData" && (
              <FormDataEditor
                items={(body as FormDataBody).items}
                onChange={(items) => setBody({ type: "formData", items })}
                suggestions={suggestions}
                onBulkEdit={() => setBulkTarget("formData")}
              />
            )}

            {body.type === "binary" && (
              <BinaryEditor
                body={body as BinaryBody}
                onChange={(next) => setBody(next)}
              />
            )}

            {body.type === "graphql" && (
              <div className="space-y-3">
                <div>
                  <div className="flex items-center justify-between">
                    <label className={LABEL_CLASS}>Query</label>
                    <button
                      type="button"
                      className="wb-chip !h-6 !px-2 !text-[10px]"
                      title={t("request.editor.graphql.introspect.title")}
                      disabled={introspecting}
                      onClick={() => (introspectionSchema ? clearIntrospection() : void introspect())}
                    >
                      <Wand2 className="h-3 w-3" />
                      {introspecting
                        ? t("request.editor.graphql.introspecting")
                        : introspectionSchema
                          ? t("request.editor.graphql.collapse")
                          : t("request.editor.graphql.fetch")}
                    </button>
                  </div>
                  <div className="wb-script-main !h-44">
                    <VariableInput
                      multiline
                      className="wb-code scrollbar-thin"
                      value={(body as GraphQLBody).query}
                      suggestions={suggestions}
                      spellCheck={false}
                      placeholder={"query {\n  user(id: 1) {\n    name\n  }\n}"}
                      ariaLabel={t("request.editor.graphql.query.aria")}
                      onChange={(query) =>
                        setBody({
                          type: "graphql",
                          query,
                          variables: (body as GraphQLBody).variables,
                        })
                      }
                    />
                  </div>
                </div>
                {introspectionError && (
                  <p className="text-xs text-red-500">{introspectionError}</p>
                )}
                {introspectionSchema && (
                  <div className="max-h-60 overflow-y-auto rounded-md border border-surface-border bg-surface p-2.5">
                    <p className="mb-1.5 text-2xs text-ink-faint">
                      Schema 大纲 · Query: <span className="font-mono">{introspectionSchema.queryType}</span>
                      {introspectionSchema.mutationType && (
                        <>
                          {" · "}
                          Mutation: <span className="font-mono">{introspectionSchema.mutationType}</span>
                        </>
                      )}
                    </p>
                    {introspectionSchema.types.map((type) => (
                      <div key={type.name} className="mb-2">
                        <div className="font-mono text-xs font-semibold text-ink">
                          {type.name}
                          <span className="ml-1.5 text-2xs font-normal text-ink-faint">{type.kind}</span>
                        </div>
                        <div className="ml-3 border-l border-surface-border pl-2.5">
                          {type.fields.map((field) => (
                            <div key={field.name} className="font-mono text-2xs text-ink-soft">
                              {field.name}
                              {field.args.length > 0 && (
                                <span className="text-ink-faint">
                                  ({field.args.map((arg) => `${arg.name}: ${arg.type}`).join(", ")})
                                </span>
                              )}
                              <span className="text-brand-600">: {field.type}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div>
                  <label className={LABEL_CLASS}>{t("request.editor.graphql.variables.label")}</label>
                  <div className="wb-script-main !h-28">
                    <VariableInput
                      multiline
                      className="wb-code scrollbar-thin"
                      value={(body as GraphQLBody).variables}
                      suggestions={suggestions}
                      spellCheck={false}
                      placeholder={'{\n  "id": 1\n}'}
                      ariaLabel={t("request.editor.graphql.variables.aria")}
                      onChange={(variables) =>
                        setBody({
                          type: "graphql",
                          query: (body as GraphQLBody).query,
                          variables,
                        })
                      }
                    />
                  </div>
                </div>
                <p className="wb-hint">
                  {t("request.editor.graphql.hint.1")}{" "}
                  <code className="font-mono">application/json</code>{" "}
                  {t("request.editor.graphql.hint.2")}{" "}
                  <code className="font-mono">{"{ query, variables }"}</code>
                  {t("request.editor.graphql.hint.3")}
                  <code className="font-mono">{"{{VAR}}"}</code>{" "}
                  {t("request.editor.graphql.hint.4")}
                </p>
              </div>
            )}
          </div>
        )}

        {tab === "auth" && (
          <div className="max-w-2xl space-y-3">
            <div className="max-w-xs">
              <label className={LABEL_CLASS}>{t("request.editor.auth.type.label")}</label>
              <Select
                value={auth.type}
                onChange={(event) => {
                  const type = event.target.value;
                  // 同类型不重置，避免丢失已填的凭据与已获取的令牌。
                  if (auth.type === type) return;
                  if (type === "inherit") setAuth({ type: "inherit" });
                  else if (type === "bearer") setAuth({ type: "bearer", token: "" });
                  else if (type === "basic") setAuth({ type: "basic", username: "", password: "" });
                  else if (type === "apiKey")
                    setAuth({ type: "apiKey", key: "", value: "", location: "header" });
                  else if (type === "none") setAuth({ type: "none" });
                  else setAuth(defaultAuth(type as AuthType));
                }}
              >
                <option value="none">{t("request.editor.auth.option.none")}</option>
                <option value="inherit">{t("request.editor.auth.option.inherit")}</option>
                <option value="bearer">Bearer Token</option>
                <option value="basic">Basic Auth</option>
                <option value="apiKey">API Key</option>
                <option value="oauth2">OAuth 2.0</option>
                <option value="awsSigV4">AWS SigV4</option>
                <option value="mtls">{t("request.editor.auth.option.mtls")}</option>
              </Select>
            </div>

            {auth.type === "bearer" && (
              <div>
                <label className={LABEL_CLASS}>{t("request.editor.auth.bearer.label")}</label>
                <VariableInput
                  className={`${inputClass} font-mono`}
                  value={auth.token}
                  suggestions={suggestions}
                  placeholder="{{token}}"
                  ariaLabel="Token"
                  onChange={(token) => setAuth({ type: "bearer", token })}
                />
              </div>
            )}

            {auth.type === "basic" && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={LABEL_CLASS}>{t("request.editor.auth.basic.username")}</label>
                  <VariableInput
                    className={inputClass}
                    value={auth.username}
                    suggestions={suggestions}
                    ariaLabel={t("request.editor.auth.basic.username")}
                    onChange={(username) =>
                      setAuth({ type: "basic", username, password: auth.password })
                    }
                  />
                </div>
                <div>
                  <label className={LABEL_CLASS}>{t("request.editor.auth.basic.password")}</label>
                  <VariableInput
                    className={inputClass}
                    type="password"
                    value={auth.password}
                    suggestions={suggestions}
                    ariaLabel={t("request.editor.auth.basic.password")}
                    onChange={(password) =>
                      setAuth({ type: "basic", username: auth.username, password })
                    }
                  />
                </div>
              </div>
            )}

            {auth.type === "apiKey" && (
              <div className="grid grid-cols-[1fr_1fr_140px] gap-3">
                <div>
                  <label className={LABEL_CLASS}>Key</label>
                  <VariableInput
                    className={`${inputClass} font-mono`}
                    value={auth.key}
                    suggestions={suggestions}
                    placeholder="X-Api-Key"
                    ariaLabel={t("request.editor.auth.apiKey.key.aria")}
                    onChange={(key) => setAuth({ ...auth, key })}
                  />
                </div>
                <div>
                  <label className={LABEL_CLASS}>Value</label>
                  <VariableInput
                    className={`${inputClass} font-mono`}
                    value={auth.value}
                    suggestions={suggestions}
                    ariaLabel={t("request.editor.auth.apiKey.value.aria")}
                    onChange={(value) => setAuth({ ...auth, value })}
                  />
                </div>
                <div>
                  <label className={LABEL_CLASS}>{t("request.editor.auth.apiKey.location")}</label>
                  <Select
                    value={auth.location}
                    onChange={(event) =>
                      setAuth({ ...auth, location: event.target.value as "header" | "query" })
                    }
                  >
                    <option value="header">Header</option>
                    <option value="query">Query</option>
                  </Select>
                </div>
              </div>
            )}

            {auth.type === "inherit" && (
              <p className="wb-hint">
                {t("request.editor.auth.inherit.hint")}
              </p>
            )}

            {auth.type === "oauth2" && (
              <OAuth2Panel
                value={auth as OAuth2Draft}
                onChange={(patch) => setAuth({ ...auth, ...patch } as AuthSpec)}
              />
            )}

            {auth.type === "awsSigV4" && (
              <AwsSigV4Panel
                value={auth as AwsSigV4Draft}
                onChange={(patch) => setAuth({ ...auth, ...patch } as AuthSpec)}
              />
            )}

            {auth.type === "mtls" && (
              <MtlsPanel
                value={auth as MtlsDraft}
                onChange={(patch) => setAuth({ ...auth, ...patch } as AuthSpec)}
              />
            )}

            {authErrors.length > 0 && (
              <div className="wb-auth-error">
                {authErrors.map((message, index) => (
                  <div key={index}>{message}</div>
                ))}
              </div>
            )}

            <p className="wb-hint">
              {t("request.editor.auth.help")}
            </p>
          </div>
        )}

        {tab === "pre" && (
          <div className="flex h-full min-h-[240px] flex-col gap-2">
            <p className="text-2xs text-ink-faint">
              {t("request.editor.pre.hint.1")}
              <code className="mx-1 font-mono">setVar()</code>{" "}
              {t("request.editor.pre.hint.2")}{" "}
              <code className="font-mono">{"{{VAR}}"}</code>{" "}
              {t("request.editor.pre.hint.3")}
            </p>
            <div className="min-h-0 flex-1">
              <ScriptEditor
                phase="pre"
                value={draft.preScript ?? ""}
                onChange={(preScript) => setDraft({ preScript })}
              />
            </div>
            {scriptOutcome?.preError && (
              <div className="wb-banner wb-banner-danger">
                <AlertTriangle className="h-3.5 w-3.5" />
                {t("request.editor.pre.error", { error: scriptOutcome.preError })}
              </div>
            )}
          </div>
        )}

        {tab === "post" && (
          <div className="flex h-full min-h-[240px] flex-col gap-2">
            <p className="text-2xs text-ink-faint">
              {t("request.editor.post.hint.1")}
              <code className="mx-1 font-mono">response</code>
              {t("request.editor.post.hint.2")}
              <code className="mx-1 font-mono">json("$.a.b[0]")</code>
              {t("request.editor.post.hint.2")}
              <code className="mx-1 font-mono">test()</code>{" "}
              {t("request.editor.post.hint.4")}
            </p>
            <div className="min-h-0 flex-1">
              <ScriptEditor
                phase="post"
                value={draft.postScript ?? ""}
                onChange={(postScript) => setDraft({ postScript })}
              />
            </div>
            {scriptOutcome?.error && (
              <div className="wb-banner wb-banner-danger">
                <AlertTriangle className="h-3.5 w-3.5" />
                {t("request.editor.post.error", { error: scriptOutcome.error })}
              </div>
            )}
          </div>
        )}

        {tab === "assertions" && (
          <AssertionEditor
            items={draft.assertions ?? []}
            onChange={setAssertions}
            results={scriptOutcome?.assertions}
          />
        )}

        {tab === "settings" && (
          <div className="max-w-3xl space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={LABEL_CLASS}>{t("request.editor.settings.description.label")}</label>
                <input
                  className={inputClass}
                  value={draft.description ?? ""}
                  placeholder={t("request.editor.settings.description.placeholder")}
                  onChange={(event) => setDraft({ description: event.target.value })}
                />
              </div>
              <div>
                <label className={LABEL_CLASS}>{t("request.editor.settings.folder.label")}</label>
                <input
                  className={inputClass}
                  value={draft.folder ?? ""}
                  placeholder={t("request.editor.settings.folder.placeholder")}
                  onChange={(event) => setDraft({ folder: event.target.value })}
                />
              </div>
            </div>

            <div className="border-t border-surface-border pt-4">
              <div className="mb-1.5 flex items-center gap-2">
                <label className={`${LABEL_CLASS} !mb-0`}>{t("request.editor.settings.httpVersion.label")}</label>
                <span className="wb-tone wb-tone-muted">{t("request.editor.settings.perRequest.override")}</span>
              </div>
              <div className="wb-segment !flex-wrap">
                {HTTP_VERSIONS.map((version) => (
                  <button
                    key={version.value}
                    type="button"
                    className={(draft.httpVersion ?? "auto") === version.value ? "active" : ""}
                    onClick={() => setDraft({ httpVersion: version.value })}
                  >
                    {version.labelKey ? t(version.labelKey) : version.label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[10.5px] leading-relaxed text-ink-faint">
                {t("request.editor.settings.httpVersion.hint")}
              </p>
              <div className="wb-hint mt-2">
                {t("request.editor.settings.http3.hint")}
              </div>
            </div>

            <div className="border-t border-surface-border pt-4">
              <div className="mb-1.5 flex items-center gap-2">
                <label className={`${LABEL_CLASS} !mb-0`}>{t("request.editor.settings.stream.label")}</label>
                <span className="wb-tone wb-tone-muted">{t("request.editor.settings.perRequest")}</span>
              </div>
              <div className="wb-segment !flex-wrap">
                {STREAM_MODES.map((mode) => (
                  <button
                    key={mode.value}
                    type="button"
                    className={streamMode === mode.value ? "active" : ""}
                    onClick={() => setDraft({ stream: mode.value })}
                  >
                    {t(mode.labelKey)}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[10.5px] leading-relaxed text-ink-faint">
                {t(STREAM_MODES.find((mode) => mode.value === streamMode)?.hintKey ?? "")}
              </p>
              <div className="wb-hint mt-2">
                {t("request.editor.settings.stream.hint.1")}
                <strong>{t("request.editor.settings.stream.hint.strong")}</strong>
                {t("request.editor.settings.stream.hint.2")}
                <code className="font-mono">node examples/sse-server.mjs</code>
                {t("request.editor.settings.stream.hint.3")}
              </div>
            </div>

            <div className="border-t border-surface-border pt-4">
              <div className="mb-1.5 flex items-center gap-2">
                <label className={`${LABEL_CLASS} !mb-0`}>
                  {t("request.editor.settings.env.label", {
                    name: activeEnvironment?.name ?? t("request.editor.settings.env.none"),
                    count: Object.keys(variables).length,
                  })}
                </label>
                <button
                  type="button"
                  className="wb-chip !h-6 !px-2 !text-[10px]"
                  onClick={() => setShowVariableValues((current) => !current)}
                >
                  {showVariableValues ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                  {showVariableValues ? t("request.editor.settings.env.hide") : t("request.editor.settings.env.show")}
                </button>
                <button
                  type="button"
                  className="wb-chip !h-6 !px-2 !text-[10px]"
                  onClick={() => setEnvironmentModalOpen(true)}
                >
                  {t("request.editor.settings.env.manage")}
                </button>
              </div>
              <div className="overflow-hidden rounded-lg border border-surface-border">
                <table className="wb-table">
                  <tbody>
                    {Object.entries(variables).map(([key, value]) => (
                      <tr key={key}>
                        <td className="!w-1/3 font-mono text-brand-600">{`{{${key}}}`}</td>
                        <td className="font-mono">
                          {showVariableValues ? value : "•".repeat(Math.min(12, Math.max(4, value.length)))}
                        </td>
                      </tr>
                    ))}
                    {Object.keys(variables).length === 0 && (
                      <tr>
                        <td colSpan={2} className="!py-4 text-center text-ink-faint">
                          {t("request.editor.settings.env.empty")}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="wb-hint">
              {t("request.editor.settings.summary", {
                timeout: settings.timeoutSecs,
                redirects: settings.followRedirects
                  ? t("request.editor.settings.on")
                  : t("request.editor.settings.off"),
                tls: settings.verifyTls
                  ? t("request.editor.settings.on")
                  : t("request.editor.settings.off"),
                script: settings.scriptTimeoutMs ?? 2000,
              })}
            </div>
          </div>
        )}
      </div>
      </fieldset>

      {bulkTarget && (
        <BulkEditModal
          open
          title={t(BULK_TITLES[bulkTarget])}
          items={
            bulkTarget === "formData"
              ? rowsForBulk(bulkTarget).filter((item) => !(item as FormPart).file)
              : rowsForBulk(bulkTarget)
          }
          onClose={() => setBulkTarget(null)}
          onApply={applyBulk}
        />
      )}
    </section>
  );
}
