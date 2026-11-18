import { useMemo, useState } from "react";
import { EMPTY_DATA_MODELS } from "../lib/defaults.ts";
import { Database, Plus, Save, Trash2, Wand2, CheckCircle2, AlertCircle, Link2 } from "lucide-react";
import { useWorkspace } from "../store/workspace";
import { useT } from "../i18n";
import type { DataModel } from "../types";
import {
  generateFromSchema,
  modelRefResolver,
  parseSchemaText,
  schemaFieldRows,
  schemaFromExample,
  validateJsonSchema,
} from "../lib/jsonschema";
import { uid } from "../lib/id";
import { Button, EmptyState, Select, inputClass } from "./ui";

const STARTER_SCHEMA = `{
  "type": "object",
  "properties": {
    "id": { "type": "integer", "description": "用户 ID" },
    "name": { "type": "string", "description": "用户名" },
    "email": { "type": "string", "format": "email" }
  },
  "required": ["id", "name"]
}`;

/**
 * Bind models to interfaces without leaving the Models view. The doc view also
 * offers the same binding controls, but requiring a jump to another tab made
 * the feature hard to discover.
 */
function BindToRequest({ models }: { models: DataModel[] }) {
  const t = useT();
  const collections = useWorkspace((state) => state.snapshot.collections);
  const bindDataModel = useWorkspace((state) => state.bindDataModel);
  const [requestId, setRequestId] = useState("");

  const requests = useMemo(
    () =>
      collections.flatMap((collection) =>
        collection.items.map((item) => ({
          id: item.id,
          label: `${collection.name} / ${item.name || item.method}`,
          request: item,
        })),
      ),
    [collections],
  );
  const target = requests.find((item) => item.id === requestId) ?? requests[0] ?? null;
  const request = target?.request ?? null;
  const requestModelId = request?.doc?.requestModelId ?? "";
  const firstExample = request?.doc?.responses?.[0] ?? null;
  const responseModelId = firstExample?.modelId ?? "";

  const bind = (kind: "request" | "response", value: string) => {
    if (target) bindDataModel(target.id, kind, value || null);
  };

  return (
    <section className="mt-4 rounded-lg border border-surface-border bg-surface-muted/30 p-3">
      <div className="mb-2 flex items-center gap-2">
        <Link2 className="h-3.5 w-3.5 text-brand-500" />
        <h3 className="text-xs font-semibold text-ink">{t("protocol.models.bindTitle")}</h3>
        <span className="ml-auto text-2xs text-ink-faint">
          {t("protocol.models.bindHint")}
        </span>
      </div>

      {models.length === 0 ? (
        <p className="text-2xs leading-relaxed text-ink-faint">
          {t("protocol.models.noModels")}
        </p>
      ) : requests.length === 0 ? (
        <p className="text-2xs leading-relaxed text-ink-faint">
          {t("protocol.models.noRequests")}
        </p>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-2xs text-ink-soft">
            <span className="w-[72px] shrink-0">{t("protocol.models.colApi")}</span>
            <Select
              className="!h-7 !w-64 !py-0 !text-[11px]"
              value={target?.id ?? ""}
              aria-label={t("protocol.models.selectApiAria")}
              onChange={(event) => setRequestId(event.target.value)}
            >
              {requests.map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </Select>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-2xs text-ink-soft">
            <span className="w-[72px] shrink-0">{t("protocol.models.requestModel")}</span>
            <Select
              className="!h-7 !w-64 !py-0 !text-[11px]"
              value={requestModelId}
              aria-label={t("protocol.models.requestModelAria")}
              onChange={(event) => bind("request", event.target.value)}
            >
              <option value="">{t("protocol.models.unbind")}</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>{model.name}</option>
              ))}
            </Select>
            {requestModelId && (
              <span className="wb-mini-badge text-emerald-600">{t("protocol.models.bound")}</span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-2xs text-ink-soft">
            <span className="w-[72px] shrink-0">{t("protocol.models.responseModel")}</span>
            <Select
              className="!h-7 !w-64 !py-0 !text-[11px]"
              value={responseModelId}
              aria-label={t("protocol.models.responseModelAria")}
              disabled={!firstExample}
              onChange={(event) => bind("response", event.target.value)}
            >
              <option value="">{t("protocol.models.unbind")}</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>{model.name}</option>
              ))}
            </Select>
            {!firstExample ? (
              <span className="text-ink-faint">
                {t("protocol.models.noExample")}
              </span>
            ) : responseModelId ? (
              <span className="wb-mini-badge text-emerald-600">
                {t("protocol.models.boundExample", { name: firstExample.name })}
              </span>
            ) : null}
          </div>

          <p className="text-2xs leading-relaxed text-ink-faint">
            {t("protocol.models.bindNote")}
          </p>
        </div>
      )}
    </section>
  );
}

/**
 * 数据模型视图：workspace 级 JSON Schema 定义，供文档绑定、响应自动校验与
 * Mock 按模型生成使用。主区整体替换请求编辑区。
 */
export function ModelsPanel() {
  const t = useT();
  const models = useWorkspace((state) => state.snapshot.dataModels ?? EMPTY_DATA_MODELS);
  const selectedModelId = useWorkspace((state) => state.selectedModelId);
  const selectModel = useWorkspace((state) => state.selectModel);
  const upsertDataModel = useWorkspace((state) => state.upsertDataModel);
  const deleteDataModel = useWorkspace((state) => state.deleteDataModel);

  const selected = models.find((model) => model.id === selectedModelId) ?? null;

  const [name, setName] = useState(selected?.name ?? "");
  const [description, setDescription] = useState(selected?.description ?? "");
  const [schemaText, setSchemaText] = useState(selected?.schemaText ?? "");
  const [exampleText, setExampleText] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [feedbackKind, setFeedbackKind] = useState<"ok" | "error">("ok");

  // Key by model id so switching models resets the local editing state.
  const editorKey = selected?.id ?? "none";
  const [editorFor, setEditorFor] = useState(editorKey);
  if (editorFor !== editorKey) {
    setEditorFor(editorKey);
    setName(selected?.name ?? "");
    setDescription(selected?.description ?? "");
    setSchemaText(selected?.schemaText ?? "");
    setExampleText("");
    setFeedback(null);
  }

  const parsed = useMemo(() => parseSchemaText(schemaText), [schemaText]);
  const fieldRows = useMemo(
    () => (parsed.schema ? schemaFieldRows(parsed.schema) : []),
    [parsed],
  );
  const generated = useMemo(() => {
    if (!parsed.schema) return null;
    try {
      return JSON.stringify(generateFromSchema(parsed.schema, modelRefResolver(models)), null, 2);
    } catch {
      return null;
    }
  }, [parsed, models]);

  const createModel = () => {
    const model: DataModel = {
      id: uid(),
      name: `模型 ${models.length + 1}`,
      description: "",
      schemaText: STARTER_SCHEMA,
      updatedAt: Date.now(),
    };
    upsertDataModel(model);
    selectModel(model.id);
  };

  const save = () => {
    if (!selected) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setFeedbackKind("error");
      setFeedback(t("protocol.models.nameRequired"));
      return;
    }
    const clash = models.some((item) => item.id !== selected.id && item.name === trimmed);
    if (clash) {
      setFeedbackKind("error");
      setFeedback(t("protocol.models.nameClash", { name: trimmed }));
      return;
    }
    if (!parsed.schema) {
      setFeedbackKind("error");
      setFeedback(t("protocol.models.schemaError", { error: parsed.error ?? "" }));
      return;
    }
    upsertDataModel({ ...selected, name: trimmed, description, schemaText });
    setFeedbackKind("ok");
    setFeedback(t("protocol.models.saved"));
  };

  const generateFromExample = () => {
    try {
      const value = JSON.parse(exampleText);
      setSchemaText(JSON.stringify(schemaFromExample(value), null, 2));
      setFeedbackKind("ok");
      setFeedback(t("protocol.models.generatedFromExample"));
    } catch (error) {
      setFeedbackKind("error");
      setFeedback(t("protocol.models.exampleError", { error: (error as Error).message }));
    }
  };

  const runValidate = () => {
    if (!parsed.schema) {
      setFeedbackKind("error");
      setFeedback(t("protocol.models.schemaError", { error: parsed.error ?? "" }));
      return;
    }
    const sample = { id: 1, name: "demo" };
    const findings = validateJsonSchema(sample, parsed.schema, modelRefResolver(models));
    setFeedbackKind("ok");
    setFeedback(
      findings.length === 0
        ? t("protocol.models.validateOk")
        : t("protocol.models.validateWarnings", { count: findings.length }),
    );
  };

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 w-52 shrink-0 flex-col border-r border-surface-border bg-surface-muted/40">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-[11px] font-medium text-ink-soft">
            {t("protocol.models.countTitle", { count: models.length })}
          </span>
          <Button size="sm" variant="ghost" onClick={createModel} aria-label={t("protocol.models.createAria")}>
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          {models.length === 0 ? (
            <p className="px-3 text-[11px] leading-5 text-ink-faint">
              {t("protocol.models.empty")}
            </p>
          ) : (
            models.map((model) => (
              <div
                key={model.id}
                className={`wb-tree-row group ${selectedModelId === model.id ? "active" : ""}`}
                style={{ paddingLeft: 14 }}
                onClick={() => selectModel(model.id)}
              >
                <Database className="h-3 w-3 shrink-0 text-ink-faint" />
                <span className="min-w-0 flex-1 truncate">{model.name}</span>
                <button
                  type="button"
                  className="wb-icon-btn !h-5 !w-5 opacity-0 group-hover:opacity-100"
                  title={t("protocol.models.delete")}
                  aria-label={t("protocol.models.delete")}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (selectedModelId === model.id) selectModel(null);
                    deleteDataModel(model.id);
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!selected ? (
          <div className="flex min-h-[240px] items-center justify-center p-6">
            <EmptyState
              icon={<Database className="h-7 w-7" />}
              title={t("protocol.models.emptyTitle")}
              description={t("protocol.models.emptyDesc")}
            />
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-4 p-4">
            <div className="flex items-center gap-2">
              <input
                className={`${inputClass} max-w-xs font-medium`}
                value={name}
                placeholder={t("protocol.models.namePlaceholder")}
                aria-label={t("protocol.models.nameAria")}
                onChange={(event) => setName(event.target.value)}
              />
              <Button variant="primary" size="sm" onClick={save}>
                <Save className="h-3.5 w-3.5" /> {t("protocol.common.save")}
              </Button>
              <Button size="sm" onClick={runValidate}>
                <CheckCircle2 className="h-3.5 w-3.5" /> {t("protocol.models.validate")}
              </Button>
            </div>
            <input
              className={inputClass}
              value={description}
              placeholder={t("protocol.models.descPlaceholder")}
              aria-label={t("protocol.models.descAria")}
              onChange={(event) => setDescription(event.target.value)}
            />

            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[11px] font-medium text-ink-soft">
                  {t("protocol.models.schemaLabel")}
                </span>
                {parsed.schema ? (
                  <span className="wb-mini-badge text-emerald-600">{t("protocol.models.schemaValid")}</span>
                ) : (
                  <span className="wb-mini-badge text-red-500">{parsed.error ?? t("protocol.models.pending")}</span>
                )}
              </div>
              <textarea
                className={`${inputClass} h-72 font-mono text-xs leading-5`}
                value={schemaText}
                spellCheck={false}
                aria-label={t("protocol.models.schemaAria")}
                onChange={(event) => setSchemaText(event.target.value)}
              />
            </div>

            {fieldRows.length > 0 && (
              <div className="overflow-hidden rounded-lg border border-surface-border">
                <table className="w-full text-left text-xs">
                  <thead className="bg-surface-muted text-[11px] text-ink-soft">
                    <tr>
                      <th className="px-3 py-1.5 font-medium">{t("protocol.models.colField")}</th>
                      <th className="px-3 py-1.5 font-medium">{t("protocol.models.colType")}</th>
                      <th className="px-3 py-1.5 font-medium">{t("protocol.models.colRequired")}</th>
                      <th className="px-3 py-1.5 font-medium">{t("protocol.models.colDesc")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fieldRows.map((row) => (
                      <tr key={row.name} className="border-t border-surface-border">
                        <td className="px-3 py-1.5 font-mono">{row.name}</td>
                        <td className="px-3 py-1.5 text-ink-soft">{row.type}</td>
                        <td className="px-3 py-1.5 text-ink-soft">{row.required ? t("protocol.models.yes") : t("protocol.models.no")}</td>
                        <td className="px-3 py-1.5 text-ink-soft">{row.description || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {generated && (
              <div>
                <div className="mb-1 text-[11px] font-medium text-ink-soft">
                  {t("protocol.models.generatedTitle")}
                </div>
                <pre className="max-h-40 overflow-auto rounded-lg border border-surface-border bg-surface-muted/40 p-2 font-mono text-[11px] leading-5">
                  {generated}
                </pre>
              </div>
            )}

            <div>
              <div className="mb-1 text-[11px] font-medium text-ink-soft">
                {t("protocol.models.fromExampleTitle")}
              </div>
              <div className="flex items-start gap-2">
                <textarea
                  className={`${inputClass} h-20 flex-1 font-mono text-xs`}
                  value={exampleText}
                  spellCheck={false}
                  aria-label={t("protocol.models.exampleAria")}
                  placeholder='{"id": 1, "name": "Alice"}'
                  onChange={(event) => setExampleText(event.target.value)}
                />
                <Button size="sm" className="mt-0.5 shrink-0 whitespace-nowrap" onClick={generateFromExample}>
                  <Wand2 className="h-3.5 w-3.5" /> {t("protocol.models.generate")}
                </Button>
              </div>
            </div>

            {feedback && (
              <div
                className={`flex items-center gap-1.5 text-xs ${
                  feedbackKind === "ok" ? "text-emerald-600" : "text-red-500"
                }`}
              >
                {feedbackKind === "ok" ? (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                ) : (
                  <AlertCircle className="h-3.5 w-3.5" />
                )}
                {feedback}
              </div>
            )}
          </div>
        )}
        <div className="mx-auto max-w-3xl px-4 pb-6">
          <BindToRequest models={models} />
        </div>
      </div>
    </div>
  );
}
