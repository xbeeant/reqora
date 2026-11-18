import { useEffect, useMemo, useState } from "react";
import { Copy, ExternalLink, Eye, Globe, RefreshCw, Trash2 } from "lucide-react";
import {
  cloudListDocSites,
  cloudPublishDocSite,
  cloudRevokeDocSite,
  cloudRotateDocSiteToken,
  cloudUpdateDocSite,
  type CloudDocSiteView,
} from "../lib/cloud.ts";
import { buildDocSitePayload } from "../lib/docSitePayload.ts";
import { useT } from "../i18n";
import { useWorkspace } from "../store/workspace";
import { DocSiteViewer } from "./DocSiteViewer";
import { ConfirmDialog } from "./ConfirmDialog";
import { Button, Modal, inputClass } from "./ui";

const SITE_KEY = "reqora.docSiteBase";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 文档站预览与网页版发布。
 *
 * 关键设计：发布的是 `buildDocSitePayload(snapshot)` 生成的**数据**，不是 HTML。
 * 网页版 `/?doc=<token>` 加载同一个 SPA，取回 JSON 后交给与此处预览完全相同的
 * DocSiteViewer，所以 Java 侧一行渲染代码都没有，两端展示永不漂移。
 */
export function DocShareModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const snapshot = useWorkspace((state) => state.snapshot);
  const cloudBaseUrl = useWorkspace((state) => state.cloudBaseUrl);
  const cloudLoggedIn = useWorkspace((state) => state.cloudLoggedIn);
  const cloudProjectId = useWorkspace((state) => state.cloudProjectId);

  const docPayload = useMemo(() => buildDocSitePayload(snapshot), [snapshot]);
  // DocSitePayload 是带明确字段的 interface，没有索引签名；发请求时视作 JSON 对象。
  const wirePayload = docPayload as unknown as Record<string, unknown>;

  const [shares, setShares] = useState<CloudDocSiteView[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [latest, setLatest] = useState<{ token: string; url: string } | null>(null);
  const [siteBase, setSiteBase] = useState(() => localStorage.getItem(SITE_KEY) ?? "");
  const [preview, setPreview] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<number | null>(null);

  const load = async (projectId: number) => {
    try {
      setShares(await cloudListDocSites(projectId));
    } catch (error) {
      setMessage({ ok: false, text: messageOf(error) });
    }
  };

  useEffect(() => {
    const projectId = cloudProjectId;
    if (open && cloudLoggedIn && projectId !== null) void load(projectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cloudLoggedIn, cloudProjectId]);

  /** 拼出网页版地址：站点地址可来自本地输入或服务端返回的 url。 */
  const urlFor = (token: string, fallback = ""): string => {
    // 服务端返回的完整链接直接信任，不再二次拼接 doc 参数（服务端已含）。
    if (fallback.trim()) {
      let url = fallback.replace(/\/+$/, "");
      // 服务端未配置 REQORA_DOC_SITE_URL 时 url 为空；
      // 若为空且前端有 cloudBaseUrl，则用 siteBase 拼接。
      if (!url && siteBase.trim()) {
        const raw = siteBase.trim().replace(/\/+$/, "");
        const [origin, ...rest] = raw.split("?");
        const params = new URLSearchParams(rest.join("?"));
        params.set("doc", token);
        if (cloudBaseUrl) params.set("api", cloudBaseUrl);
        return `${origin}/?${params.toString()}`;
      }
      // 服务端 URL 不带 api 参数且前端有 cloudBaseUrl 时补上（跨源部署需要）。
      if (url) {
        const parsed = new URL(url, window.location.origin);
        if (!parsed.searchParams.has("api") && cloudBaseUrl) {
          parsed.searchParams.set("api", cloudBaseUrl);
          return parsed.toString();
        }
      }
      return url;
    }
    const raw = siteBase.trim().replace(/\/+$/, "");
    if (!raw) return "";
    const [origin, ...rest] = raw.split("?");
    const params = new URLSearchParams(rest.join("?"));
    params.set("doc", token);
    if (cloudBaseUrl) params.set("api", cloudBaseUrl);
    return `${origin}/?${params.toString()}`;
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setMessage({ ok: true, text: t("tools.share.copiedMsg") });
    } catch {
      setMessage({ ok: false, text: t("tools.share.copyFailedMsg") });
    }
  };

  const publish = async () => {
    const projectId = cloudProjectId;
    if (projectId === null) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await cloudPublishDocSite(projectId, wirePayload);
      setLatest({ token: result.token, url: result.url });
      setMessage({ ok: true, text: t("tools.share.publishedMsg") });
      await load(projectId);
    } catch (error) {
      setMessage({ ok: false, text: messageOf(error) });
    } finally {
      setBusy(false);
    }
  };

  const update = async (shareId: number) => {
    const projectId = cloudProjectId;
    if (projectId === null) return;
    setBusy(true);
    try {
      await cloudUpdateDocSite(projectId, shareId, wirePayload);
      setMessage({ ok: true, text: t("tools.share.updatedMsg") });
      await load(projectId);
    } catch (error) {
      setMessage({ ok: false, text: messageOf(error) });
    } finally {
      setBusy(false);
    }
  };

  const rotate = async (shareId: number) => {
    const projectId = cloudProjectId;
    if (projectId === null) return;
    setBusy(true);
    try {
      const result = await cloudRotateDocSiteToken(projectId, shareId);
      setLatest({ token: result.token, url: result.url });
      const url = urlFor(result.token, result.url);
      if (url) await copy(url);
      setMessage({ ok: true, text: t("tools.share.rotatedMsg") });
      await load(projectId);
    } catch (error) {
      setMessage({ ok: false, text: messageOf(error) });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (shareId: number) => {
    const projectId = cloudProjectId;
    if (projectId === null) return;
    setBusy(true);
    try {
      await cloudRevokeDocSite(projectId, shareId);
      setConfirmRevoke(null);
      setMessage({ ok: true, text: t("tools.share.revokedMsg") });
      await load(projectId);
    } catch (error) {
      setMessage({ ok: false, text: messageOf(error) });
    } finally {
      setBusy(false);
    }
  };

  const currentUrl = latest ? urlFor(latest.token, latest.url) : "";
  const ready = cloudLoggedIn && cloudProjectId !== null;

  return (
    <>
      <Modal
        open={open}
        title={t("tools.share.title")}
        description={t("tools.share.desc")}
        onClose={onClose}
        width="max-w-4xl"
        footer={<Button variant="primary" onClick={onClose}>{t("tools.common.done")}</Button>}
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => setPreview(true)}>
            <Eye className="mr-1 h-3.5 w-3.5" />
            {t("tools.share.localPreview")}
          </Button>
          <Button size="sm" disabled={!ready || busy} onClick={() => void publish()}>
            <Globe className="mr-1 h-3.5 w-3.5" />
            {t("tools.share.publishNew")}
          </Button>
          <span className="wb-hint !ml-auto">
            {t("tools.share.counts", {
              chapters: docPayload.chapters.length,
              requests: docPayload.totalRequests,
            })}
          </span>
        </div>

        {!ready ? (
          <div className="wb-banner wb-banner-warn mb-3">
            {t("tools.share.needCloud")}
          </div>
        ) : null}

        <label className="mb-3 block">
          <span className="wb-label mb-1 block">{t("tools.share.siteBaseLabel")}</span>
          <input
            className={inputClass}
            placeholder={t("tools.share.siteBasePlaceholder")}
            value={siteBase}
            onChange={(event) => {
              setSiteBase(event.target.value);
              localStorage.setItem(SITE_KEY, event.target.value);
            }}
          />
          <span className="wb-hint">
            {t("tools.share.siteBaseHint1")}<code>api</code>{t("tools.share.siteBaseHint2")}
          </span>
        </label>

        {latest ? (
          <div className="wb-docshare-latest">
            <div className="wb-docshare-latest-head">
              <strong>{t("tools.share.newLink")}</strong>
              <span className="wb-hint">{t("tools.share.tokenOnce")}</span>
            </div>
            <div className="flex items-center gap-2">
              <input className={`${inputClass} min-w-0 flex-1`} readOnly value={currentUrl} aria-label={t("tools.share.linkAria")} />
              <Button size="sm" className="shrink-0 whitespace-nowrap" disabled={!currentUrl} onClick={() => void copy(currentUrl)}>
                <Copy className="mr-1 h-3 w-3" />
                {t("tools.common.copy")}
              </Button>
              {currentUrl ? (
                <a className="wb-chip shrink-0" href={currentUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-3 w-3" />
                  {t("tools.share.open")}
                </a>
              ) : null}
            </div>
            {!currentUrl ? (
              <div className="wb-hint">
                <p>
                  {t("tools.share.noUrlHelp1")}<code>api</code>{t("tools.share.noUrlHelp2")}
                  <code>REQORA_DOC_SITE_URL</code>{t("tools.share.noUrlHelp3")}
                  {t("tools.share.tokenParam")}{t("tools.share.noUrlHelp4")}
                </p>
                <Button size="sm" className="mt-1" onClick={() => void copy(latest.token)}>
                  <Copy className="mr-1 h-3 w-3" />
                  {t("tools.share.copyToken")}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

        <h4 className="wb-docsite-subhead">{t("tools.share.publishedHead")}</h4>
        {shares.length === 0 ? (
          <p className="wb-hint">{t("tools.share.noShares")}</p>
        ) : (
          <table className="wb-table">
            <thead>
              <tr>
                <th>{t("tools.share.thTitle")}</th>
                <th>{t("tools.share.thStatus")}</th>
                <th>{t("tools.share.thViews")}</th>
                <th>{t("tools.share.thCreatedAt")}</th>
                <th className="text-right">{t("tools.share.thActions")}</th>
              </tr>
            </thead>
            <tbody>
              {shares.map((share) => (
                <tr key={share.id}>
                  <td>{share.title}</td>
                  <td>{share.status === "ACTIVE" ? t("tools.share.statusActive") : t("tools.share.statusRevoked")}</td>
                  <td>{share.viewCount ?? 0}</td>
                  <td>{share.createdAt ? new Date(share.createdAt).toLocaleString() : "—"}</td>
                  <td>
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" disabled={busy || share.status !== "ACTIVE"} onClick={() => void update(share.id)}>
                        <RefreshCw className="mr-1 h-3 w-3" />
                        {t("tools.share.updateContent")}
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy || share.status !== "ACTIVE"} onClick={() => void rotate(share.id)}>
                        <Copy className="mr-1 h-3 w-3" />
                        {t("tools.share.copyLink")}
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy || share.status !== "ACTIVE"} onClick={() => setConfirmRevoke(share.id)}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <ConfirmDialog
          open={confirmRevoke !== null}
          title={t("tools.share.revokeTitle")}
          message={t("tools.share.revokeMsg")}
          confirmLabel={t("tools.share.revoke")}
          onCancel={() => setConfirmRevoke(null)}
          onConfirm={() => {
            if (confirmRevoke !== null) void revoke(confirmRevoke);
          }}
        />

        <p className="wb-hint mt-3">
          {t("tools.share.privacyNote")}
        </p>

        {message ? (
          <div className={`mt-3 rounded-md border px-3 py-2 text-xs ${
            message.ok
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-red-200 bg-red-50 text-red-700"
          }`}>
            {message.text}
          </div>
        ) : null}
      </Modal>

      {preview ? (
        <div className="wb-docsite-overlay">
          <div className="wb-docsite-overlay-bar">
            <span>{t("tools.share.previewBar")}</span>
            <Button size="sm" onClick={() => setPreview(false)}>{t("tools.share.closePreview")}</Button>
          </div>
          <div className="wb-docsite-overlay-body">
            <DocSiteViewer payload={docPayload} mode="preview" onClose={() => setPreview(false)} />
          </div>
        </div>
      ) : null}
    </>
  );
}
