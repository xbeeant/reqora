import { ArrowDown, ArrowUp, Clock, Database, ListChecks, Play, Plus, Save, Table2, Timer, Trash2 } from "lucide-react";
import { EMPTY_DB_CONNECTIONS } from "../lib/defaults.ts";
import { useState } from "react";
import { useWorkspace } from "../store/workspace";
import { useT } from "../i18n";
import { datasetToCsv, parseCsvDataset, resolveStepRequest } from "../lib/scenario.ts";
import { uid } from "../lib/id.ts";
import type { ScenarioDbAssert, ScenarioExtract, ScenarioStep, ScenarioStepCondition } from "../types";
import { Button, EmptyState, inputClass } from "./ui";

const SCHEDULE_INTERVALS = [
  { value: 10, labelKey: "testing.schedule.every10s" },
  { value: 30, labelKey: "testing.schedule.every30s" },
  { value: 60, labelKey: "testing.schedule.every1m" },
  { value: 300, labelKey: "testing.schedule.every5m" },
];

const extractSourceLabelKeys: Record<ScenarioExtract["source"], string> = {
  json: "testing.extractSource.json",
  header: "testing.extractSource.header",
  status: "testing.extractSource.status",
};

/** One ordered step row: source, extracts, ordering, enable, delete. */
function StepRow({
  scenarioId,
  step,
  index,
  total,
  dangling,
  caseName,
}: {
  scenarioId: string;
  step: ScenarioStep;
  index: number;
  total: number;
  dangling: boolean;
  caseName?: string;
}) {
  const t = useT();
  const updateStep = useWorkspace((state) => state.updateScenarioStep);
  const deleteStep = useWorkspace((state) => state.deleteScenarioStep);
  const moveStep = useWorkspace((state) => state.moveScenarioStep);
  const dbConnections = useWorkspace((state) => state.snapshot.dbConnections ?? EMPTY_DB_CONNECTIONS);
  // 局部常量保持 TS 收窄，也避免编辑回调里丢失类型。
  const dbConfig = step.source.kind === "db" ? step.source.db : null;
  const repeat = step.repeat;
  const condition = step.condition;

  return (
    <div className="wb-scenario-step">
      <div className="flex items-center gap-2">
        <span className="wb-scenario-index">{index + 1}</span>
        <input
          className={`${inputClass} !h-7 !w-44 !py-0 !text-[12px]`}
          value={step.name}
          aria-label={t("testing.step.name.aria")}
          onChange={(event) => updateStep(scenarioId, step.id, { name: event.target.value })}
        />
        {step.source.kind === "case" ? (
          <span className="wb-mini-badge" title={t("testing.step.case.title")}>
            {t("testing.step.case", {
              name: dangling ? t("testing.step.caseDeleted") : caseName ?? "…",
            })}
          </span>
        ) : step.source.kind === "db" ? (
          <span className="wb-mini-badge" title={t("testing.step.db.title")}>
            <Database className="mr-0.5 inline h-3 w-3" />
            {t("testing.step.db")}
          </span>
        ) : step.source.kind === "wait" ? (
          <span className="wb-mini-badge" title={t("testing.step.wait.title")}>
            {t("testing.step.wait", { ms: step.source.ms })}
          </span>
        ) : (
          <span className="wb-mini-badge" title={t("testing.step.inline.title")}>{t("testing.step.inline")}</span>
        )}
        <span className="min-w-0 flex-1 truncate text-2xs text-ink-faint">
          {dangling ? t("testing.step.dangling") : ""}
        </span>
        <label className="flex cursor-pointer items-center gap-1 text-2xs text-ink-faint">
          <input
            type="checkbox"
            checked={step.enabled}
            aria-label={t("testing.step.enabled.aria")}
            onChange={(event) => updateStep(scenarioId, step.id, { enabled: event.target.checked })}
          />
          {t("testing.step.enabled")}
        </label>
        <label
          className="flex cursor-pointer items-center gap-1 text-2xs text-ink-faint"
          title={t("testing.step.continue.title")}
        >
          <input
            type="checkbox"
            checked={step.continueOnFailure}
            aria-label={t("testing.step.continue.aria")}
            onChange={(event) =>
              updateStep(scenarioId, step.id, { continueOnFailure: event.target.checked })
            }
          />
          {t("testing.step.continue")}
        </label>
        <button
          type="button"
          className="wb-icon-btn !h-6 !w-6"
          title={t("testing.moveUp")}
          aria-label={t("testing.moveUp")}
          disabled={index === 0}
          onClick={() => moveStep(scenarioId, step.id, -1)}
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="wb-icon-btn !h-6 !w-6"
          title={t("testing.moveDown")}
          aria-label={t("testing.moveDown")}
          disabled={index === total - 1}
          onClick={() => moveStep(scenarioId, step.id, 1)}
        >
          <ArrowDown className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="wb-icon-btn !h-6 !w-6"
          title={t("testing.deleteStep")}
          aria-label={t("testing.deleteStep")}
          onClick={() => deleteStep(scenarioId, step.id)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-8">
        {step.extracts.map((extract) => (
          <span key={extract.id} className="wb-extract-chip">
            <b>{extract.varName}</b>
            <span className="text-ink-faint">
              ← {t(extractSourceLabelKeys[extract.source])}
              {extract.source !== "status" ? `:${extract.path}` : ""}
            </span>
            <button
              type="button"
              aria-label={t("testing.deleteExtract")}
              title={t("testing.deleteExtract")}
              onClick={() =>
                updateStep(scenarioId, step.id, {
                  extracts: step.extracts.filter((item) => item.id !== extract.id),
                })
              }
            >
              ×
            </button>
          </span>
        ))}
        <button
          type="button"
          className="wb-chip !h-6 !px-2 !text-[10px]"
          title={t("testing.extract.add.title")}
          onClick={() =>
            updateStep(scenarioId, step.id, {
              extracts: [
                ...step.extracts,
                { id: uid(), varName: "", source: "json", path: "" },
              ],
            })
          }
        >
          <Plus className="h-3 w-3" />
          {t("testing.extract.add")}
        </button>
      </div>

      {step.extracts.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-2 pl-8">
          {step.extracts.map((extract) => (
              <span key={extract.id} className="flex items-center gap-1 text-2xs">
                <input
                  className={`${inputClass} !h-6 !w-24 !py-0 !text-[11px]`}
                  placeholder={t("testing.varName.placeholder")}
                  aria-label={t("testing.varName.aria")}
                  value={extract.varName}
                  onChange={(event) =>
                    updateStep(scenarioId, step.id, {
                      extracts: step.extracts.map((item) =>
                        item.id === extract.id ? { ...item, varName: event.target.value } : item,
                      ),
                    })
                  }
                />
                <select
                  className={`${inputClass} !h-6 !w-20 !py-0 !text-[11px]`}
                  value={extract.source}
                  aria-label={t("testing.extract.source.aria")}
                  onChange={(event) =>
                    updateStep(scenarioId, step.id, {
                      extracts: step.extracts.map((item) =>
                        item.id === extract.id
                          ? { ...item, source: event.target.value as ScenarioExtract["source"] }
                          : item,
                      ),
                    })
                  }
                >
                  <option value="json">JSON</option>
                  <option value="header">{t("testing.extractSource.header")}</option>
                  <option value="status">{t("testing.extractSource.status")}</option>
                </select>
                {extract.source !== "status" && (
                  <input
                    className={`${inputClass} !h-6 !w-36 !py-0 font-mono !text-[11px]`}
                    placeholder={extract.source === "json" ? "$.data.id" : t("testing.headerName.placeholder")}
                    aria-label={t("testing.extract.path.aria")}
                    value={extract.path}
                    onChange={(event) =>
                      updateStep(scenarioId, step.id, {
                        extracts: step.extracts.map((item) =>
                          item.id === extract.id ? { ...item, path: event.target.value } : item,
                        ),
                      })
                    }
                  />
                )}
              </span>
            ))}
        </div>
      )}

      {step.source.kind === "wait" && (
        <div className="mt-1.5 flex items-center gap-2 pl-8">
          <span className="text-2xs text-ink-faint">{t("testing.wait.prefix")}</span>
          <input
            type="number"
            min={0}
            max={60000}
            className={`${inputClass} !h-6 !w-24 !py-0 !text-[11px]`}
            value={step.source.ms}
            aria-label={t("testing.wait.ms.aria")}
            onChange={(event) =>
              updateStep(scenarioId, step.id, {
                source: {
                  kind: "wait",
                  ms: Math.min(Math.max(Math.floor(Number(event.target.value) || 0), 0), 60000),
                },
              })
            }
          />
          <span className="text-2xs text-ink-faint">{t("testing.wait.suffix")}</span>
        </div>
      )}

      {step.source.kind !== "wait" && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-8">
          <label className="flex items-center gap-1 text-2xs text-ink-faint">
            <input
              type="checkbox"
              checked={Boolean(repeat)}
              aria-label={t("testing.repeat.enable.aria")}
              onChange={(event) =>
                updateStep(scenarioId, step.id, {
                  repeat: event.target.checked ? { count: 2 } : undefined,
                })
              }
            />
            {t("testing.repeat")}
          </label>
          {repeat && (
            <>
              <select
                className={`${inputClass} !h-6 !w-28 !py-0 !text-[11px]`}
                value={repeat.over !== undefined ? "over" : "count"}
                aria-label={t("testing.repeat.mode.aria")}
                onChange={(event) =>
                  updateStep(scenarioId, step.id, {
                    repeat:
                      event.target.value === "over"
                        ? { over: "", itemVar: "item" }
                        : { count: repeat.count ?? 2 },
                  })
                }
              >
                <option value="count">{t("testing.repeat.count")}</option>
                <option value="over">{t("testing.repeat.over")}</option>
              </select>
              {repeat.over !== undefined ? (
                <>
                  <input
                    className={`${inputClass} !h-6 !w-28 !py-0 font-mono !text-[11px]`}
                    placeholder={t("testing.repeat.array.placeholder")}
                    aria-label={t("testing.repeat.array.aria")}
                    value={repeat.over}
                    onChange={(event) =>
                      updateStep(scenarioId, step.id, {
                        repeat: { ...repeat, over: event.target.value },
                      })
                    }
                  />
                  <input
                    className={`${inputClass} !h-6 !w-24 !py-0 font-mono !text-[11px]`}
                    placeholder="item"
                    aria-label={t("testing.repeat.item.aria")}
                    value={repeat.itemVar ?? ""}
                    onChange={(event) =>
                      updateStep(scenarioId, step.id, {
                        repeat: { ...repeat, itemVar: event.target.value },
                      })
                    }
                  />
                </>
              ) : (
                <input
                  type="number"
                  min={1}
                  max={100}
                  className={`${inputClass} !h-6 !w-20 !py-0 !text-[11px]`}
                  value={repeat.count ?? 1}
                  aria-label={t("testing.repeat.count.aria")}
                  onChange={(event) =>
                    updateStep(scenarioId, step.id, {
                      repeat: {
                        ...repeat,
                        count: Math.min(Math.max(Math.floor(Number(event.target.value) || 1), 1), 100),
                      },
                    })
                  }
                />
              )}
              <input
                className={`${inputClass} !h-6 !w-24 !py-0 font-mono !text-[11px]`}
                placeholder={t("testing.repeat.index.placeholder")}
                aria-label={t("testing.repeat.index.aria")}
                value={repeat.indexVar ?? ""}
                onChange={(event) =>
                  updateStep(scenarioId, step.id, {
                    repeat: { ...repeat, indexVar: event.target.value },
                  })
                }
              />
            </>
          )}

          <label className="flex items-center gap-1 text-2xs text-ink-faint">
            <input
              type="checkbox"
              checked={Boolean(condition)}
              aria-label={t("testing.condition.enable.aria")}
              onChange={(event) =>
                updateStep(scenarioId, step.id, {
                  condition: event.target.checked
                    ? { varName: "", op: "eq", value: "" }
                    : undefined,
                })
              }
            />
            {t("testing.condition")}
          </label>
          {condition && (
            <>
              <input
                className={`${inputClass} !h-6 !w-28 !py-0 font-mono !text-[11px]`}
                placeholder={t("testing.varName.placeholder")}
                aria-label={t("testing.condition.var.aria")}
                value={condition.varName}
                onChange={(event) =>
                  updateStep(scenarioId, step.id, {
                    condition: { ...condition, varName: event.target.value },
                  })
                }
              />
              <select
                className={`${inputClass} !h-6 !w-20 !py-0 !text-[11px]`}
                value={condition.op}
                aria-label={t("testing.condition.op.aria")}
                onChange={(event) =>
                  updateStep(scenarioId, step.id, {
                    condition: {
                      ...condition,
                      op: event.target.value as ScenarioStepCondition["op"],
                    },
                  })
                }
              >
                <option value="eq">=</option>
                <option value="ne">≠</option>
                <option value="gt">&gt;</option>
                <option value="gte">≥</option>
                <option value="lt">&lt;</option>
                <option value="lte">≤</option>
                <option value="contains">{t("testing.op.contains")}</option>
                <option value="exists">{t("testing.op.exists")}</option>
              </select>
              {condition.op !== "exists" && (
                <input
                  className={`${inputClass} !h-6 !w-28 !py-0 font-mono !text-[11px]`}
                  placeholder={t("testing.condition.value.placeholder")}
                  aria-label={t("testing.condition.value.aria")}
                  value={condition.value}
                  onChange={(event) =>
                    updateStep(scenarioId, step.id, {
                      condition: { ...condition, value: event.target.value },
                    })
                  }
                />
              )}
              <span className="text-2xs text-ink-faint">{t("testing.condition.skipHint")}</span>
            </>
          )}
        </div>
      )}

      {dbConfig && (
        <div className="mt-2 space-y-2 rounded-md border border-surface-border bg-surface-sunken p-2">
          <div className="flex gap-2">
            <select
              className={`${inputClass} !h-7 !w-36 shrink-0 !py-0 !text-[11px]`}
              aria-label={t("testing.db.source.aria")}
              value={dbConfig.connectionId ?? ""}
              onChange={(event) =>
                updateStep(scenarioId, step.id, {
                  source: {
                    kind: "db",
                    db: {
                      ...dbConfig,
                      connectionId: event.target.value || undefined,
                    },
                  },
                })
              }
            >
              <option value="">{t("testing.db.manualUrl")}</option>
              {dbConnections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.name}
                </option>
              ))}
            </select>
            <input
              className={`${inputClass} !h-7 min-w-0 flex-1 !py-0 font-mono !text-[11px]`}
              placeholder={t("testing.db.url.placeholder")}
              aria-label={t("testing.db.url.aria")}
              readOnly={Boolean(dbConfig.connectionId)}
              value={
                dbConfig.connectionId
                  ? (dbConnections.find((item) => item.id === dbConfig.connectionId)?.url ?? t("testing.db.connDeleted"))
                  : dbConfig.url
              }
              onChange={(event) =>
                updateStep(scenarioId, step.id, {
                  source: {
                    kind: "db",
                    db: { ...dbConfig, url: event.target.value },
                  },
                })
              }
            />
            <select
              className={`${inputClass} !h-7 !w-24 shrink-0 !py-0 !text-[11px]`}
              aria-label={t("testing.db.mode.aria")}
              value={dbConfig.mode}
              onChange={(event) =>
                updateStep(scenarioId, step.id, {
                  source: {
                    kind: "db",
                    db: { ...dbConfig, mode: event.target.value as "query" | "execute" },
                  },
                })
              }
            >
              <option value="query">{t("testing.db.mode.query")}</option>
              <option value="execute">{t("testing.db.mode.execute")}</option>
            </select>
          </div>
          <textarea
            className={`${inputClass} h-16 font-mono !text-[11px]`}
            placeholder={t("testing.db.sql.placeholder")}
            aria-label={t("testing.db.sql.aria")}
            value={dbConfig.sql}
            onChange={(event) =>
              updateStep(scenarioId, step.id, {
                source: {
                  kind: "db",
                  db: { ...dbConfig, sql: event.target.value },
                },
              })
            }
          />
          {dbConfig.mode === "query" && (
            <div className="flex flex-wrap items-center gap-1.5">
              {dbConfig.extracts.map((extract) => (
                <span key={extract.id} className="flex items-center gap-1 text-2xs">
                  <input
                    className={`${inputClass} !h-6 !w-20 !py-0 !text-[11px]`}
                    placeholder={t("testing.varName.placeholder")}
                    aria-label={t("testing.db.varName.aria")}
                    value={extract.varName}
                    onChange={(event) =>
                      updateStep(scenarioId, step.id, {
                        source: {
                          kind: "db",
                          db: {
                            ...dbConfig,
                            extracts: dbConfig.extracts.map((item) =>
                              item.id === extract.id
                                ? { ...item, varName: event.target.value }
                                : item,
                            ),
                          },
                        },
                      })
                    }
                  />
                  <span className="text-ink-faint">←</span>
                  <input
                    className={`${inputClass} !h-6 !w-24 !py-0 font-mono !text-[11px]`}
                    placeholder={t("testing.db.column.placeholder")}
                    aria-label={t("testing.db.column.aria")}
                    value={extract.column}
                    onChange={(event) =>
                      updateStep(scenarioId, step.id, {
                        source: {
                          kind: "db",
                          db: {
                            ...dbConfig,
                            extracts: dbConfig.extracts.map((item) =>
                              item.id === extract.id
                                ? { ...item, column: event.target.value }
                                : item,
                            ),
                          },
                        },
                      })
                    }
                  />
                  <span className="text-ink-faint">{t("testing.db.row.prefix")}</span>
                  <input
                    type="number"
                    min={0}
                    className={`${inputClass} !h-6 !w-14 !py-0 text-right font-mono !text-[11px]`}
                    aria-label={t("testing.db.row.aria")}
                    value={extract.row}
                    onChange={(event) =>
                      updateStep(scenarioId, step.id, {
                        source: {
                          kind: "db",
                          db: {
                            ...dbConfig,
                            extracts: dbConfig.extracts.map((item) =>
                              item.id === extract.id
                                ? { ...item, row: Math.max(0, Number(event.target.value) || 0) }
                                : item,
                            ),
                          },
                        },
                      })
                    }
                  />
                  <span className="text-ink-faint">{t("testing.db.row.suffix")}</span>
                  <button
                    type="button"
                    aria-label={t("testing.db.extract.delete")}
                    onClick={() =>
                      updateStep(scenarioId, step.id, {
                        source: {
                          kind: "db",
                          db: {
                            ...dbConfig,
                            extracts: dbConfig.extracts.filter(
                              (item) => item.id !== extract.id,
                            ),
                          },
                        },
                      })
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
              <button
                type="button"
                className="wb-chip !h-6 !px-2 !text-[10px]"
                onClick={() =>
                  updateStep(scenarioId, step.id, {
                    source: {
                      kind: "db",
                      db: {
                        ...dbConfig,
                        extracts: [
                          ...dbConfig.extracts,
                          { id: uid(), varName: "", column: "", row: 0 },
                        ],
                      },
                    },
                  })
                }
              >
                <Plus className="h-3 w-3" />
                {t("testing.db.extract.add")}
              </button>
            </div>
          )}
          {dbConfig.mode === "query" && (
            <div className="space-y-1">
              {dbConfig.asserts.map((assertion) => (
                <div key={assertion.id} className="flex flex-wrap items-center gap-1 text-2xs">
                  <select
                    className={`${inputClass} !h-6 !w-16 !py-0 !text-[11px]`}
                    aria-label={t("testing.db.assert.target.aria")}
                    value={assertion.target}
                    onChange={(event) =>
                      updateStep(scenarioId, step.id, {
                        source: {
                          kind: "db",
                          db: {
                            ...dbConfig,
                            asserts: dbConfig.asserts.map((item) =>
                              item.id === assertion.id
                                ? {
                                    ...item,
                                    target: event.target.value as ScenarioDbAssert["target"],
                                  }
                                : item,
                            ),
                          },
                        },
                      })
                    }
                  >
                    <option value="rows">{t("testing.db.assert.rows")}</option>
                    <option value="cell">{t("testing.db.assert.cell")}</option>
                  </select>
                  {assertion.target === "cell" && (
                    <>
                      <input
                        className={`${inputClass} !h-6 !w-24 !py-0 font-mono !text-[11px]`}
                        placeholder={t("testing.db.column.placeholder")}
                        aria-label={t("testing.db.assert.column.aria")}
                        value={assertion.column}
                        onChange={(event) =>
                          updateStep(scenarioId, step.id, {
                            source: {
                              kind: "db",
                              db: {
                                ...dbConfig,
                                asserts: dbConfig.asserts.map((item) =>
                                  item.id === assertion.id
                                    ? { ...item, column: event.target.value }
                                    : item,
                                ),
                              },
                            },
                          })
                        }
                      />
                      <span className="text-ink-faint">{t("testing.db.row.prefix")}</span>
                      <input
                        type="number"
                        min={0}
                        className={`${inputClass} !h-6 !w-14 !py-0 text-right font-mono !text-[11px]`}
                        aria-label={t("testing.db.assert.row.aria")}
                        value={assertion.row}
                        onChange={(event) =>
                          updateStep(scenarioId, step.id, {
                            source: {
                              kind: "db",
                              db: {
                                ...dbConfig,
                                asserts: dbConfig.asserts.map((item) =>
                                  item.id === assertion.id
                                    ? { ...item, row: Math.max(0, Number(event.target.value) || 0) }
                                    : item,
                                ),
                              },
                            },
                          })
                        }
                      />
                      <span className="text-ink-faint">{t("testing.db.row.suffix")}</span>
                    </>
                  )}
                  <select
                    className={`${inputClass} !h-6 !w-20 !py-0 !text-[11px]`}
                    aria-label={t("testing.db.assert.op.aria")}
                    value={assertion.op}
                    onChange={(event) =>
                      updateStep(scenarioId, step.id, {
                        source: {
                          kind: "db",
                          db: {
                            ...dbConfig,
                            asserts: dbConfig.asserts.map((item) =>
                              item.id === assertion.id
                                ? { ...item, op: event.target.value as ScenarioDbAssert["op"] }
                                : item,
                            ),
                          },
                        },
                      })
                    }
                  >
                    <option value="eq">=</option>
                    <option value="ne">≠</option>
                    <option value="gt">&gt;</option>
                    <option value="gte">≥</option>
                    <option value="lt">&lt;</option>
                    <option value="lte">≤</option>
                    <option value="contains">{t("testing.op.contains")}</option>
                  </select>
                  <input
                    className={`${inputClass} !h-6 !w-24 !py-0 font-mono !text-[11px]`}
                    placeholder={t("testing.db.assert.value.placeholder")}
                    aria-label={t("testing.db.assert.value.aria")}
                    value={assertion.value}
                    onChange={(event) =>
                      updateStep(scenarioId, step.id, {
                        source: {
                          kind: "db",
                          db: {
                            ...dbConfig,
                            asserts: dbConfig.asserts.map((item) =>
                              item.id === assertion.id
                                ? { ...item, value: event.target.value }
                                : item,
                            ),
                          },
                        },
                      })
                    }
                  />
                  <button
                    type="button"
                    aria-label={t("testing.db.assert.delete")}
                    onClick={() =>
                      updateStep(scenarioId, step.id, {
                        source: {
                          kind: "db",
                          db: {
                            ...dbConfig,
                            asserts: dbConfig.asserts.filter(
                              (item) => item.id !== assertion.id,
                            ),
                          },
                        },
                      })
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="wb-chip !h-6 !px-2 !text-[10px]"
                onClick={() =>
                  updateStep(scenarioId, step.id, {
                    source: {
                      kind: "db",
                      db: {
                        ...dbConfig,
                        asserts: [
                          ...dbConfig.asserts,
                          { id: uid(), target: "rows", row: 0, column: "", op: "eq", value: "" },
                        ],
                      },
                    },
                  })
                }
              >
                <Plus className="h-3 w-3" />
                {t("testing.db.assert.add")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Cross-interface test scenario editor: ordered steps (case reference or
 * inline request), per-step variable extraction, and the last run report.
 */
export function ScenarioPanel({ scenarioId }: { scenarioId: string }) {
  const t = useT();
  const scenario = useWorkspace((state) =>
    state.snapshot.scenarios.find((item) => item.id === scenarioId),
  );
  const cases = useWorkspace((state) => state.snapshot.cases);
  const updateScenario = useWorkspace((state) => state.updateScenario);
  const addStepFromCase = useWorkspace((state) => state.addScenarioStepFromCase);
  const addStepFromDraft = useWorkspace((state) => state.addScenarioStepFromDraft);
  const addScenarioDbStep = useWorkspace((state) => state.addScenarioDbStep);
  const addScenarioWaitStep = useWorkspace((state) => state.addScenarioWaitStep);
  const runScenario = useWorkspace((state) => state.runScenario);
  const running = useWorkspace((state) => state.runningScenarioId === scenarioId);
  const schedule = useWorkspace((state) => state.schedule);
  const startScenarioSchedule = useWorkspace((state) => state.startScenarioSchedule);
  const stopScenarioSchedule = useWorkspace((state) => state.stopScenarioSchedule);

  const [dataSetOpen, setDataSetOpen] = useState(false);
  const [scheduleInterval, setScheduleInterval] = useState(30);
  const [csvText, setCsvText] = useState(() =>
    scenario?.dataSet ? datasetToCsv(scenario.dataSet) : "",
  );
  const [csvError, setCsvError] = useState<string | null>(null);

  if (!scenario) return null;
  const caseById = new Map(cases.map((item) => [item.id, item]));
  const run = scenario.lastRun;
  const availableCases = cases;

  return (
    <div className="wb-scenario scrollbar-thin">
      <div className="wb-scenario-toolbar">
        <ListChecks className="h-4 w-4 shrink-0 text-brand-500" />
        <input
          className={`${inputClass} !h-8 !w-64 !py-0 !text-[13px] font-medium`}
          value={scenario.name}
          aria-label={t("testing.scenario.name.aria")}
          onChange={(event) => updateScenario(scenarioId, { name: event.target.value })}
        />
        <input
          className={`${inputClass} !h-8 !min-w-0 flex-1 !py-0 !text-[11px]`}
          value={scenario.description ?? ""}
          placeholder={t("testing.scenario.descOptional.placeholder")}
          aria-label={t("testing.scenario.desc.label")}
          onChange={(event) => updateScenario(scenarioId, { description: event.target.value })}
        />
        <Button size="sm" variant="primary" disabled={running || scenario.steps.length === 0} onClick={() => void runScenario(scenarioId)}>
          <Play className={`h-3.5 w-3.5 ${running ? "animate-pulse" : ""}`} />
          {running ? t("testing.running") : t("testing.scenario.run")}
        </Button>
        {schedule?.scenarioId === scenarioId ? (
          <Button size="sm" variant="danger" onClick={stopScenarioSchedule} title={t("testing.scenario.stop.title")}>
            <Clock className="h-3.5 w-3.5 animate-pulse" />
            {t("testing.scenario.stop", { secs: schedule.intervalSecs })}
          </Button>
        ) : (
          <>
            <select
              className={`${inputClass} !h-8 !w-28 shrink-0 !py-0 !text-[11px]`}
              aria-label={t("testing.scenario.interval.aria")}
              value={scheduleInterval}
              onChange={(event) => setScheduleInterval(Number(event.target.value))}
            >
              {SCHEDULE_INTERVALS.map((item) => (
                <option key={item.value} value={item.value}>
                  {t(item.labelKey)}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="ghost"
              disabled={scenario.steps.length === 0}
              title={t("testing.scenario.schedule.title")}
              onClick={() => startScenarioSchedule(scenarioId, scheduleInterval)}
            >
              <Clock className="h-3.5 w-3.5" />
              {t("testing.scenario.schedule")}
            </Button>
          </>
        )}
      </div>

      <div className="px-4 pt-2">
        <div className="flex flex-wrap items-center gap-2">
          <Table2 className="h-3.5 w-3.5 text-brand-500" />
          <span className="text-xs font-semibold text-ink">{t("testing.dataDriven")}</span>
          {scenario.dataSet ? (
            <>
              <span className="wb-mini-badge">
                {t("testing.dataSet.badge", {
                  rows: scenario.dataSet.rows.length,
                  cols: scenario.dataSet.columns.length,
                })}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDataSetOpen(true);
                  setCsvText(datasetToCsv(scenario.dataSet ?? { columns: [], rows: [] }));
                }}
              >
                {t("testing.dataSet.edit")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => updateScenario(scenarioId, { dataSet: undefined })}
              >
                {t("testing.dataSet.disable")}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDataSetOpen(true);
                setCsvText("");
                setCsvError(null);
              }}
            >
              {t("testing.dataSet.add")}
            </Button>
          )}
          <span className="text-2xs text-ink-faint">
            {t("testing.dataSet.hint")}
          </span>
        </div>
        {dataSetOpen && (
          <div className="mt-2 space-y-1.5 rounded-md border border-surface-border bg-surface-sunken p-2">
            <textarea
              className={`${inputClass} h-28 font-mono text-[11px] leading-5`}
              value={csvText}
              spellCheck={false}
              aria-label={t("testing.dataSet.csv.aria")}
              placeholder={"userId,name\n101,Alice\n102,Bob"}
              onChange={(event) => setCsvText(event.target.value)}
            />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  const parsed = parseCsvDataset(csvText);
                  if (parsed.error && parsed.rows.length === 0) {
                    setCsvError(parsed.error);
                    return;
                  }
                  setCsvError(parsed.error ?? null);
                  updateScenario(scenarioId, {
                    dataSet: { columns: parsed.columns, rows: parsed.rows },
                  });
                  setDataSetOpen(false);
                }}
              >
                {t("testing.dataSet.apply")}
              </Button>
              <span className="text-2xs text-ink-faint">{t("testing.dataSet.hint2")}</span>
              {csvError && <span className="text-2xs text-red-500">{csvError}</span>}
            </div>
          </div>
        )}
      </div>

      {scenario.steps.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <EmptyState
            icon={<ListChecks className="h-7 w-7" />}
            title={t("testing.scenario.empty.title")}
            description={t("testing.scenario.empty.desc")}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-2 p-4">
          {scenario.steps.map((step, index) => {
            const request = resolveStepRequest(step, cases);
            const caseName =
              step.source.kind === "case"
                ? caseById.get(step.source.caseId)?.name
                : undefined;
            return (
              <StepRow
                key={step.id}
                scenarioId={scenarioId}
                step={step}
                index={index}
                total={scenario.steps.length}
                dangling={
                  step.source.kind !== "db" && step.source.kind !== "wait" && request === null
                }
                caseName={caseName}
              />
            );
          })}
        </div>
      )}

      <div className="wb-scenario-add">
        <span className="text-2xs text-ink-faint">{t("testing.addStep.label")}</span>
        <select
          className={`${inputClass} !h-7 !w-64 !py-0 !text-[11px]`}
          value=""
          aria-label={t("testing.addStep.fromCase.aria")}
          onChange={(event) => {
            if (event.target.value) addStepFromCase(scenarioId, event.target.value);
          }}
        >
          <option value="">{t("testing.selectCase")}</option>
          {availableCases.map((caseItem) => (
            <option key={caseItem.id} value={caseItem.id}>
              {t("testing.caseOption", { name: caseItem.name, group: caseItem.group })}
            </option>
          ))}
        </select>
        <Button size="sm" variant="ghost" onClick={() => addStepFromDraft(scenarioId)}>
          <Plus className="h-3.5 w-3.5" />
          {t("testing.addStep.fromDraft")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => addScenarioDbStep(scenarioId)}>
          <Database className="h-3.5 w-3.5" />
          {t("testing.addStep.db")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => addScenarioWaitStep(scenarioId)}>
          <Timer className="h-3.5 w-3.5" />
          {t("testing.addStep.wait")}
        </Button>
        <span className="ml-auto text-2xs text-ink-faint">
          {t("testing.stepCount", { count: scenario.steps.length })}
        </span>
      </div>

      {run && (
        <div className="wb-scenario-report">
          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold text-ink">{t("testing.col.lastRun")}</span>
            <span className="text-2xs text-ink-faint">
              {t("testing.viewRun.meta", {
                at: new Date(run.at).toLocaleString("zh-CN"),
                ms: run.timeMs,
              })}
            </span>
            <span className={`wb-case-pill ${run.failed > 0 ? "fail" : "ok"}`}>
              {run.failed > 0
                ? t("testing.runStat.fail", { count: run.failed })
                : t("testing.runStat.pass", { passed: run.passed, total: run.total })}
              {run.skipped > 0 ? ` · ${t("testing.runStat.skipped", { count: run.skipped })}` : ""}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() => updateScenario(scenarioId, { lastRun: undefined })}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t("testing.clearReport")}
            </Button>
          </div>
          <table className="wb-case-table mt-2">
            <thead>
              <tr>
                <th>#</th>
                <th>{t("testing.col.step")}</th>
                <th className="!w-20">{t("testing.col.statusCode")}</th>
                <th className="!w-24">{t("testing.col.asserts")}</th>
                <th className="!w-20">{t("testing.col.duration")}</th>
                <th>{t("testing.col.extractOrError")}</th>
              </tr>
            </thead>
            <tbody>
              {run.steps.map((step, index) => (
                <tr key={step.stepId} className={step.ok ? "" : step.skipped ? "" : "wb-step-fail"}>
                  <td className="font-mono text-ink-faint">{index + 1}</td>
                  <td>
                    <span className="text-[12px] font-medium text-ink">{step.name}</span>
                    {step.skipped && (
                      <span className="wb-mini-badge ml-2" title={step.note}>
                        {t("testing.skipped")}
                      </span>
                    )}
                    {!step.skipped && step.note && (
                      <span className="wb-mini-badge ml-2">{step.note}</span>
                    )}
                  </td>
                  <td className="font-mono">{step.status ?? "—"}</td>
                  <td className="font-mono">
                    {step.skipped ? "—" : `${step.passed}✓ ${step.failed > 0 ? `${step.failed}✗` : ""}`}
                  </td>
                  <td className="font-mono">{step.skipped ? "—" : `${step.timeMs}ms`}</td>
                  <td className="min-w-0">
                    {Object.keys(step.extracted).length > 0 && (
                      <span className="text-2xs text-ink-soft">
                        {Object.entries(step.extracted)
                          .map(([key, value]) => `${key}=${value}`)
                          .join(" · ")}
                      </span>
                    )}
                    {step.error && <span className="text-2xs text-red-500">{step.error}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="wb-case-foot">
        <Save className="h-3.5 w-3.5 text-ink-faint" />
        <span className="text-2xs text-ink-faint">
          {t("testing.scenario.foot")}
        </span>
      </div>
    </div>
  );
}
