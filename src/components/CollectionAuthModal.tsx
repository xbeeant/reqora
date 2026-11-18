import { useT } from "../i18n";
import { useWorkspace } from "../store/workspace";
import type { AuthSpec } from "../types";
import { Button, Modal, Select, inputClass } from "./ui";

/**
 * Collection-level auth editor. Requests with `auth: { type: "inherit" }` use
 * this configuration; the marker is resolved to a concrete variant before the
 * request reaches Rust (see lib/auth.ts). Collections never offer "inherit"
 * themselves — there is no parent to inherit from.
 */
export function CollectionAuthModal({
  collectionId,
  onClose,
}: {
  collectionId: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const collections = useWorkspace((state) => state.snapshot.collections);
  const setCollectionAuth = useWorkspace((state) => state.setCollectionAuth);
  const collection = collections.find((item) => item.id === collectionId);
  const auth: AuthSpec = collection?.auth ?? { type: "none" };
  const inheritCount =
    collection?.items.filter((item) => item.auth?.type === "inherit").length ?? 0;

  // Narrow into local constants: React callbacks lose the discriminated-union
  // narrowing when they close over `auth` directly.
  const bearer = auth.type === "bearer" ? auth : null;
  const basic = auth.type === "basic" ? auth : null;
  const apiKey = auth.type === "apiKey" ? auth : null;

  const update = (next: AuthSpec) => {
    if (collectionId) setCollectionAuth(collectionId, next);
  };

  return (
    <Modal
      open={collectionId !== null}
      title={t("tools.auth.title", { name: collection?.name ?? "" })}
      description={t("tools.auth.desc")}
      onClose={onClose}
      width="max-w-lg"
    >
      <div className="space-y-3">
        <div className="max-w-xs">
          <label className="wb-label">{t("tools.auth.method")}</label>
          <Select
            value={auth.type}
            onChange={(event) => {
              const type = event.target.value;
              if (type === "bearer") update({ type: "bearer", token: "" });
              else if (type === "basic") update({ type: "basic", username: "", password: "" });
              else if (type === "apiKey")
                update({ type: "apiKey", key: "", value: "", location: "header" });
              else update({ type: "none" });
            }}
          >
            <option value="none">{t("tools.auth.none")}</option>
            <option value="bearer">Bearer Token</option>
            <option value="basic">Basic Auth</option>
            <option value="apiKey">API Key</option>
          </Select>
        </div>

        {bearer && (
          <div>
            <label className="wb-label">{t("tools.auth.token")}</label>
            <input
              className={`${inputClass} font-mono`}
              value={bearer.token}
              placeholder="{{token}}"
              aria-label="Token"
              onChange={(event) => update({ type: "bearer", token: event.target.value })}
            />
          </div>
        )}

        {basic && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="wb-label">{t("tools.auth.username")}</label>
              <input
                className={inputClass}
                value={basic.username}
                aria-label={t("tools.auth.username")}
                onChange={(event) =>
                  update({ type: "basic", username: event.target.value, password: basic.password })
                }
              />
            </div>
            <div>
              <label className="wb-label">{t("tools.auth.password")}</label>
              <input
                className={inputClass}
                type="password"
                value={basic.password}
                aria-label={t("tools.auth.password")}
                onChange={(event) =>
                  update({ type: "basic", username: basic.username, password: event.target.value })
                }
              />
            </div>
          </div>
        )}

        {apiKey && (
          <div className="grid grid-cols-[1fr_1fr_140px] gap-3">
            <div>
              <label className="wb-label">Key</label>
              <input
                className={`${inputClass} font-mono`}
                value={apiKey.key}
                placeholder="X-Api-Key"
                aria-label={t("tools.auth.keyAria")}
                onChange={(event) => update({ ...apiKey, key: event.target.value })}
              />
            </div>
            <div>
              <label className="wb-label">Value</label>
              <input
                className={`${inputClass} font-mono`}
                value={apiKey.value}
                aria-label={t("tools.auth.valueAria")}
                onChange={(event) => update({ ...apiKey, value: event.target.value })}
              />
            </div>
            <div>
              <label className="wb-label">{t("tools.auth.location")}</label>
              <Select
                value={apiKey.location}
                onChange={(event) =>
                  update({ ...apiKey, location: event.target.value as "header" | "query" })
                }
              >
                <option value="header">Header</option>
                <option value="query">Query</option>
              </Select>
            </div>
          </div>
        )}

        <p className="wb-hint">
          {t("tools.auth.inheritHint", { count: inheritCount })}
        </p>

        <div className="flex justify-end">
          <Button size="sm" variant="primary" onClick={onClose}>
            {t("tools.common.done")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
