import { api } from "../../../lib/api.ts";
import { CloudError } from "../../../lib/cloud.ts";
import { cloudCreateProject } from "../../../lib/cloud.ts";
import { cloudGetRows } from "../../../lib/cloud.ts";
import { cloudGetObject } from "../../../lib/cloud.ts";
import { cloudGetRowsSince } from "../../../lib/cloud.ts";
import { cloudListProjects } from "../../../lib/cloud.ts";
import { cloudLogin as cloudLoginRequest } from "../../../lib/cloud.ts";
import { cloudLogout as cloudLogoutRequest } from "../../../lib/cloud.ts";
import { cloudPutObject } from "../../../lib/cloud.ts";
import { cloudSyncRows } from "../../../lib/cloud.ts";
import { cloudSyncRowsAck } from "../../../lib/cloud.ts";
import { ensureCloudProject } from "../../../lib/cloud.ts";
import { cloudProjectFor } from "../../../lib/cloudConnection.ts";
import { forgetCloudProject } from "../../../lib/cloudConnection.ts";
import { setCloudProjectFor } from "../../../lib/cloudConnection.ts";
import { clearCloudSession } from "../../../lib/cloudConnection.ts";
import { cloudSession } from "../../../lib/cloudConnection.ts";
import { normalizeCloudBaseUrl } from "../../../lib/cloudConnection.ts";
import { readCloudConnection } from "../../../lib/cloudConnection.ts";
import { setCloudImportError } from "../../../lib/cloudConnection.ts";
import { setCloudImportResult } from "../../../lib/cloudConnection.ts";
import { switchCloudServer } from "../../../lib/cloudConnection.ts";
import { writeCloudConnection } from "../../../lib/cloudConnection.ts";
import { clearAllSyncBaselines } from "../../../lib/cloudSync.ts";
import { clearAllSyncConflicts } from "../../../lib/cloudSync.ts";
import { clearSyncBaseline } from "../../../lib/cloudSync.ts";
import { clearSyncConflicts } from "../../../lib/cloudSync.ts";
import { chunkRowsForUpload } from "../../../lib/cloudSync.ts";
import { extractBlobRefs } from "../../../lib/cloudSync.ts";
import { findOversizedRows } from "../../../lib/cloudSync.ts";
import { hydrateBlobRows } from "../../../lib/cloudSync.ts";
import { isShareableRowsEmpty } from "../../../lib/cloudSync.ts";
import { overlayRows } from "../../../lib/cloudSync.ts";
import { loadSyncBaseline } from "../../../lib/cloudSync.ts";
import { loadSyncConflicts } from "../../../lib/cloudSync.ts";
import { sanitizeRowsForUpload } from "../../../lib/cloudSync.ts";
import { saveSyncBaseline } from "../../../lib/cloudSync.ts";
import { saveSyncConflicts } from "../../../lib/cloudSync.ts";
import { stripForUpload } from "../../../lib/cloudSync.ts";
import { SYNC_CHUNK_BYTES } from "../../../lib/cloudSync.ts";
import type { SyncConflictRecord } from "../../../lib/cloudSync.ts";
import { stampMergedRow } from "../../../lib/fieldMerge.ts";
import type { AnyRow } from "../../../lib/fieldMerge.ts";
import { restoreRowCredentials } from "../../../lib/workspaceRows.ts";
import { restoreRowsCredentials } from "../../../lib/workspaceRows.ts";
import { rowsToSnapshot } from "../../../lib/workspaceRows.ts";
import { snapshotToRows } from "../../../lib/workspaceRows.ts";
import { threeWayMerge } from "../../../lib/workspaceRows.ts";
import type { WorkspaceRowsPayload } from "../../../lib/workspaceRows.ts";
import { buildMockRules } from "../../../lib/mock.ts";
import { variablesFrom } from "../../../lib/template.ts";
import type { WorkspaceSnapshot } from "../../../types.ts";
import { messageOf } from "../helpers.ts";
import type { StoreContext } from "../context.ts";
import type { CloudSlice } from "../types.ts";
import { t } from "../../../i18n/index.ts";
import {
  clearAllCrdtStates,
  clearCrdtState,
  resolveCrdtConflictIfActive,
  runCrdtCloudImport,
} from "../crdtImport.ts";

/**
 * 版本冲突重试：服务端 meta 是 delete+insert 单键行，并发同步会偶发 1009
 * （VERSION_CONFLICT）。整包路径一年遇不上几次，分片上传把一次大同步拆成
 * 多个请求，撞上并发窗口的概率随之放大，这里对 1009 做退避重试；其它
 * 错误（凭据、权限、体积）重试没有意义，直接上抛。
 */
const retryConflicts = async <T>(run: () => Promise<T>, attempts = 3): Promise<T> => {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      const retryable = error instanceof CloudError && error.code === 1009;
      if (!retryable || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw lastError;
};

export const createCloudSlice = (ctx: StoreContext): CloudSlice => {
  const { set, get, cloudView, cloudConflictsView, persistFull } = ctx;

  /** 把裁决结果（完整行 / null=删除）写回本地快照并落盘。 */
  const replaceLocalRow = (domain: string, id: string, nextRow: AnyRow | null): void => {
    const currentRows = snapshotToRows(get().snapshot);
    const payload = { ...currentRows } as WorkspaceRowsPayload;
    delete (payload as { meta?: unknown }).meta;
    const buckets = payload as unknown as Record<string, AnyRow[]>;
    const pool = buckets[domain] ?? [];
    buckets[domain] = nextRow
      ? pool.some((item) => item.id === id)
        ? pool.map((item) => (item.id === id ? nextRow : item))
        : [...pool, nextRow]
      : pool.filter((item) => item.id !== id);
    set({ snapshot: rowsToSnapshot(payload, get().snapshot) });
    persistFull();
  };

  /**
   * 裁决后立即把该行上传（脱敏 → 大字段外置 → 整包同步）。
   * 这一步不能省：合成行相对旧基线是「本地改了」，云端版本相对旧基线也是
   * 「云端改了」，若只写回本地快照，下一轮三方合并会把它重新判成冲突，
   * 合成结果永远传不上去。先让服务端收敛到合成行，cloudImport 的收尾
   * 拉取就会看到 L == R，冲突自然消失。
   */
  const uploadResolvedRow = async (
    projectId: number,
    domain: string,
    id: string,
  ): Promise<void> => {
    const redactedRows = snapshotToRows(
      stripForUpload(get().snapshot) as unknown as WorkspaceSnapshot,
    );
    const safeRow = (
      (redactedRows as unknown as Record<string, AnyRow[]>)[domain] ?? []
    ).find((item) => item.id === id);
    if (!safeRow) throw new Error(t("store.cloud.noRedactedRow"));
    const payload = {
      folders: [],
      requests: [],
      environments: [],
      cases: [],
      scenarios: [],
      suites: [],
      artifacts: [],
    } as unknown as WorkspaceRowsPayload;
    (payload as unknown as Record<string, AnyRow[]>)[domain] = [safeRow];
    const sanitized = sanitizeRowsForUpload(payload);
    const { payload: refPayload, blobs } = await extractBlobRefs(sanitized.payload);
    for (const blob of blobs) {
      await retryConflicts(() => cloudPutObject(projectId, blob.bytes, blob.hash));
    }
    await retryConflicts(() => cloudSyncRows(projectId, refPayload));
  };

  /** 裁决收尾：移除该条记录 → 刷新冲突视图 → 跑一轮同步收敛基线。 */
  const finishResolution = async (
    localProjectId: string,
    targetId: number,
    domain: string,
    id: string,
    record: SyncConflictRecord | null,
  ): Promise<void> => {
    const remaining = (record?.entries ?? []).filter(
      (item) => !(item.domain === domain && item.id === id),
    );
    await saveSyncConflicts(localProjectId, targetId, remaining);
    set({ cloudBusy: false, ...(await cloudConflictsView()) });
    await get().cloudImport();
  };

  return {
    // ---- 云端协作：只配置地址 + 一次性登录 + 按行双向同步 ----

    setCloudBaseUrl: (url) => {
      // 原样保存输入（受控输入框若在写入端剥尾部 "/"，用户就打不出 http://）。
      // 是否换了服务器用归一化后的值比较；归一化最终由 cloudBaseUrl() 读取端完成。
      const current = readCloudConnection().baseUrl;
      if (current && normalizeCloudBaseUrl(url) !== normalizeCloudBaseUrl(current)) {
        // Tokens and resolved spaces belong to the old server; never reuse them.
        switchCloudServer(url);
        // 基线与冲突记录是「本机 × 服务端 × 协作空间」的数据，换服务端即作废。
        // 基线仓储内部串行执行，fire-and-forget 也保证「先清后读」。
        void clearAllSyncBaselines();
        void clearAllSyncConflicts();
        clearAllCrdtStates();
        set({ cloudConflicts: [], cloudConflictRecord: null });
      } else {
        writeCloudConnection({ baseUrl: url });
      }
      set({ cloudError: null, ...cloudView() });
    },

    cloudLogin: async (username, password) => {
      if (!readCloudConnection().baseUrl) {
        set({ cloudError: t("store.cloud.baseUrlRequired") });
        return;
      }
      set({ cloudBusy: true, cloudError: null, cloudNotice: null });
      try {
        const tokens = await cloudLoginRequest(username, password);
        set({
          cloudBusy: false,
          cloudNotice: t("store.cloud.loggedIn", {
            name: tokens.user.displayName || tokens.user.username,
          }),
          ...cloudView(),
        });
      } catch (error) {
        set({ cloudBusy: false, cloudError: messageOf(error), ...cloudView() });
      }
    },

    cloudLogout: () => {
      const refresh = cloudSession()?.refresh;
      // Clear locally first so an offline backend cannot keep the UI "logged in".
      clearCloudSession();
      if (refresh) void cloudLogoutRequest(refresh).catch(() => undefined);
      set({
        cloudNotice: t("store.cloud.loggedOut"),
        cloudError: null,
        ...cloudView(),
      });
    },

    cloudImport: async (options) => {
      const connection = readCloudConnection();
      if (!connection.baseUrl) {
        set({ cloudError: t("store.cloud.baseUrlRequired") });
        return;
      }
      if (!connection.session) {
        set({ cloudError: t("store.cloud.loginRequired") });
        return;
      }
      const downloadOnly = options?.downloadOnly === true;
      set({ cloudBusy: true, cloudError: null, cloudNotice: null });
      const localProjectId = get().projectsState?.activeProjectId ?? "default";
      const localProjectName =
        get().projectsState?.projects.find((project) => project.active)?.name ?? t("store.cloud.defaultProject");
      try {
        // 同步目标必须显式选择：只认「已绑定的协作空间」。没有绑定时弹出
        // 选择框（绑定已有空间或新建），绝不静默自动创建或随便挑一个可写
        // 空间——那会把数据同步进用户从未选过的项目。
        const target = await ensureCloudProject(localProjectId);
        if (!target) {
          set({
            cloudBusy: false,
            cloudError: null,
            cloudNotice: null,
            cloudPickerOpen: true,
            cloudPickerProject: { id: localProjectId, name: localProjectName },
            cloudSpaces: null,
            cloudSpacesError: null,
            ...cloudView(),
          });
          void get().cloudLoadSpaces();
          return;
        }

        // 协议 v2（Automerge CRDT + 追加式变更日志）：服务端支持就整轮接管，
        // 不支持则原样回退下面的 v1 三方合并链路。两者绝不混用同一个空间，
        // 避免出现两个真相源（正是这次要根除的缺陷）。
        if (await runCrdtCloudImport(ctx, target, localProjectId, downloadOnly)) return;

        // 仅下载：本地没有可共享实体且绑定到不同（或首个）协作空间时，
        // 整集拉取云端行落到本地，绝不 POST 上传，也不让旧空间的删除墓碑
        // 传播到新空间。典型场景：新装应用 / 空目录换绑到团队已有空间。
        if (downloadOnly) {
          const remote = await cloudGetRows(target.id);
          // 大字段引用先水合，引用绝不能原样进快照/基线。
          await hydrateBlobRows(remote, (hash) => cloudGetObject(target.id, hash));
          const rowsWithoutMeta: WorkspaceRowsPayload = { ...remote };
          delete (rowsWithoutMeta as { meta?: unknown }).meta;
          const merged = rowsToSnapshot(rowsWithoutMeta, get().snapshot);
          merged.tombstones = [];
          set({ snapshot: merged });
          persistFull();
          // 下载完成即建立基线（cursor 取当前版本，后续同步走增量）；
          // 旧冲突记录随旧绑定一并作废。
          await saveSyncBaseline(localProjectId, target.id, rowsWithoutMeta, remote.version);
          await clearSyncConflicts(localProjectId);
          set({ cloudConflicts: [], cloudConflictRecord: null });
          const downloaded = (
            [
              "folders",
              "requests",
              "environments",
              "cases",
              "scenarios",
              "suites",
              "artifacts",
            ] as const
          ).reduce<number>(
            (total, domain) =>
              total +
              ((rowsWithoutMeta[domain] as unknown as Array<{ deleted?: boolean }> | undefined) ?? [])
                .filter((row) => !row.deleted).length,
            0,
          );
          setCloudImportResult({
            at: Date.now(),
            version: remote.version,
            projectId: target.id,
            projectName: target.name,
            localProjectId,
          });
          set({
            cloudBusy: false,
            cloudJustBound: null,
            cloudNotice: t("store.cloud.downloadDone", {
              space: target.name || target.slug,
              project: localProjectName,
              rows: downloaded,
              version: remote.version,
            }),
            ...cloudView(),
          });
          return;
        }

        // 行级同步（基线三方合并 + 游标增量拉取）：以上次成功同步的服务端
        // 行集为共同祖先，仅本地变→上传；仅云端变→下载；双方都变→冲突
        // （保留本地版本，提醒裁决）。拉取带 since 游标：服务端只回基线之后
        // 变更的行（row_version > cursor），overlayRows 摊平到基线上得到
        // 「服务端当前视图」；旧服务端忽略 since 返回全量，overlay 后语义
        // 不变（自动降级）；无基线时 cursor=0，delta 本身就是全量引导。
        const localSnapshot = get().snapshot;
        // 三方合并的比较基准必须是脱敏行集：服务端与基线保存的都是脱敏版本，
        // 用带本机凭据的行去比会把它误判成「本地也改了」，从而在冲突裁决
        // 后的收敛轮反复报冲突。写回快照时 restoreRowsCredentials 会回填凭据。
        const redactedRows = snapshotToRows(
          stripForUpload(localSnapshot) as unknown as WorkspaceSnapshot,
        );
        const baselineRecord = await loadSyncBaseline(localProjectId);
        const baseline =
          baselineRecord && baselineRecord.cloudProjectId === target.id ? baselineRecord : null;
        const baselineRows = baseline?.rows ?? null;
        const cursor = Math.max(0, Math.floor(baseline?.cursor ?? 0));
        // 已经在记录里的冲突行本轮继续挂起：保留本地、不上传、不重复报告。
        const conflictRecord = await loadSyncConflicts(localProjectId);
        const skipIds =
          conflictRecord && conflictRecord.cloudProjectId === target.id
            ? new Set(conflictRecord.entries.map((entry) => `${entry.domain}:${entry.id}`))
            : new Set<string>();
        const delta = await retryConflicts(() => cloudGetRowsSince(target.id, cursor));
        // 大字段引用必须在合并前水合：本地/基线持有真实数据，引用 vs 真实
        // 会被误判成「云端改了」。任一对象缺失即整体失败重试，绝不落库。
        await hydrateBlobRows(delta, (hash) => cloudGetObject(target.id, hash));
        // full=true（墓碑回收水位后的退化全量）时整体替换而非叠加基线。
        const remote = overlayRows(baselineRows, delta, delta.full === true);
        const outcome = threeWayMerge(redactedRows, remote, baselineRows, { skipIds });

        // 本地获胜的行已在脱敏行集里，下面按 id 取出即可（绝不回退到未脱敏行）。
        const domains = [
          "folders",
          "requests",
          "environments",
          "cases",
          "scenarios",
          "suites",
          "artifacts",
        ] as const;
        type RowDomain = (typeof domains)[number];
        const upload = {} as Record<RowDomain, Array<{ id: string }>>;
        for (const domain of domains) {
          const pool = new Map(
            (redactedRows[domain] as unknown as Array<{ id: string }>).map((row) => [row.id, row]),
          );
          // 找不到脱敏对应行时宁可跳过也绝不回退到未脱敏的原始行。
          upload[domain] = (
            outcome.localChanges[domain] as unknown as Array<{ id: string }>
          ).flatMap((row) => {
            const safe = pool.get(row.id);
            return safe ? [safe] : [];
          });
        }

        // 上传前规整数据：把非有限数字显式转成 null（JSON.stringify 也会这么
        // 做），并在同步通知里报出被污染的行；协议标量列取整。
        const sanitized = sanitizeRowsForUpload(upload as unknown as WorkspaceRowsPayload);
        const fixedRows = sanitized.fixed;

        // 大字段外置：超过阈值的行 data 以 sha256 内容寻址上传对象存储，行内
        // 只留引用——行恒小，单行体积不再受同步请求上限约束；同内容幂等去重。
        const { payload: refPayload, blobs } = await extractBlobRefs(sanitized.payload);
        const blobHint = blobs.length ? t("store.cloud.chunkBlobHint", { count: blobs.length }) : "";
        for (const blob of blobs) {
          set({ cloudNotice: t("store.cloud.uploadingBlob", { name: blob.name || blob.id }) });
          await retryConflicts(() => cloudPutObject(target.id, blob.bytes, blob.hash));
        }

        // 分块上传：服务端对单次 sync 请求的全部行 data 求和，超过
        // workspace.maxBytes（默认 5 MiB）就返回 1010 / 413。大字段已外置，
        // 这里按字节预算切普通行；单行超限兜底检查保留（正常不可达）。
        const oversized = findOversizedRows(refPayload);
        if (oversized.length) {
          const first = oversized[0];
          throw new Error(
            t("store.cloud.rowTooLarge", {
              name: first.name || first.id,
              domain: first.domain,
              size: (first.bytes / 1048576).toFixed(1),
              limit: Math.floor(SYNC_CHUNK_BYTES / 1048576),
            }),
          );
        }
        const chunks = chunkRowsForUpload(refPayload);
        if (chunks.length > 1) {
          for (let index = 0; index < chunks.length; index += 1) {
            set({ cloudNotice: t("store.cloud.chunkProgress", { index: index + 1, total: chunks.length }) });
            await retryConflicts(() => cloudSyncRowsAck(target.id, chunks[index]));
          }
        } else if (chunks.length === 1) {
          // 单块整包路径（响应由收尾增量拉取统一取代，不再单独应用）。
          await retryConflicts(() => cloudSyncRows(target.id, chunks[0]));
        }

        // 收尾增量拉取（同游标）：服务端在我们上传期间写入的行——包括自己
        // 上传后应用的行（row_version > cursor）——都会出现，构成新基线与
        // 最终合并输入；本地在此期间的新编辑也经 freshLocalRows 进入下一轮。
        const delta2 = await retryConflicts(() => cloudGetRowsSince(target.id, cursor));
        await hydrateBlobRows(delta2, (hash) => cloudGetObject(target.id, hash));
        const remoteView2 = overlayRows(baselineRows, delta2, delta2.full === true);
        const freshLocalRows = snapshotToRows(get().snapshot);
        const freshRedactedRows = snapshotToRows(
          stripForUpload(get().snapshot) as unknown as WorkspaceSnapshot,
        );
        const outcome2 = threeWayMerge(freshRedactedRows, remoteView2, baselineRows, { skipIds });

        // 本地视图必须用三方合并结果（outcome2.remote）重建，而不是直接套用
        // 服务端行集：threeWayMerge 会保留挂起冲突行的本地版本、本地新建行，
        // 并对「仅云端变」的行回填本机凭据。直接套 remoteView2 会把冲突行
        // 的本地修改静默覆盖成云端版本，与「冲突时保留本地」的承诺相悖。
        // 基线仍保存 remoteView2（服务端脱敏行集），下一轮才有正确的共同祖先。
        const rowsWithoutMeta: WorkspaceRowsPayload = { ...outcome2.remote };
        delete (rowsWithoutMeta as { meta?: unknown }).meta;
        const restoredRows = restoreRowsCredentials(rowsWithoutMeta, freshLocalRows);
        const merged = rowsToSnapshot(restoredRows, get().snapshot);
        // 本次同步已经把删除墓碑送达服务端（或证明删除已被更新的远端版本
        // 覆盖），本地不再需要保留；下次同步以服务端行为准。
        merged.tombstones = [];
        set({ snapshot: merged });
        persistFull();

        // 服务端行集成为新基线（带增量游标）；冲突行持久化待裁决。
        const baselineRows2: WorkspaceRowsPayload = { ...remoteView2 };
        delete (baselineRows2 as { meta?: unknown }).meta;
        await saveSyncBaseline(localProjectId, target.id, baselineRows2, delta2.version);
        const previousConflicts =
          conflictRecord && conflictRecord.cloudProjectId === target.id
            ? conflictRecord.entries
            : [];
        const freshConflicts = outcome2.conflicts.map((conflict) => ({
          domain: conflict.domain as string,
          id: conflict.id,
          name: conflict.name,
          base: conflict.base,
          local: conflict.local,
          remote: conflict.remote,
        }));
        const mergedConflicts = [
          ...previousConflicts,
          ...freshConflicts.filter(
            (conflict) =>
              !previousConflicts.some(
                (entry) => entry.domain === conflict.domain && entry.id === conflict.id,
              ),
          ),
        ];
        await saveSyncConflicts(localProjectId, target.id, mergedConflicts);

        setCloudImportResult({
          at: Date.now(),
          version: delta2.version,
          projectId: target.id,
          projectName: target.name,
          localProjectId,
        });
        const justBound = get().cloudJustBound;
        const reuseHint =
          justBound === "created"
            ? t("store.cloud.justCreated")
            : justBound === "bound"
              ? t("store.cloud.justBound")
              : "";
        const counts = domains.reduce<number>(
          (total, domain) => total + (outcome.localChanges[domain] as unknown[]).length,
          0,
        );
        const sanitizeHint = fixedRows.length
          ? t("store.cloud.sanitizeHint", {
              count: fixedRows.length,
              names: fixedRows.slice(0, 5).join("、") + (fixedRows.length > 5 ? t("store.cloud.sanitizeMore") : ""),
            })
          : "";
        const conflictHint = mergedConflicts.length
          ? t("store.cloud.conflictHint", { count: mergedConflicts.length })
          : "";
        const chunkHint = chunks.length > 1 ? t("store.cloud.chunkHint", { count: chunks.length }) : "";
        set({
          cloudBusy: false,
          cloudJustBound: null,
          cloudNotice: t("store.cloud.syncDone", {
            project: localProjectName,
            space: target.name || target.slug,
            rows: counts,
            chunks: chunkHint,
            blobs: blobHint,
            version: delta2.version,
            reuse: reuseHint,
            sanitize: sanitizeHint,
            conflicts: conflictHint,
          }),
          ...cloudView(),
          ...(await cloudConflictsView()),
        });
      } catch (error) {
        const text =
          error instanceof CloudError && error.code === 1009
            ? t("store.cloud.syncConflictRetry")
            : messageOf(error);
        setCloudImportError(text);
        set({
          cloudBusy: false,
          cloudJustBound: null,
          cloudError: text,
          cloudNotice: null,
          ...cloudView(),
        });
      }
    },

    // ---- 协作空间选择框：首次同步时显式绑定，之后记住绑定 ----

    setCloudPickerOpen: (open) => {
      if (open) {
        const localProjectId = get().projectsState?.activeProjectId ?? "default";
        const localProjectName =
          get().projectsState?.projects.find((project) => project.active)?.name ?? t("store.cloud.defaultProject");
        set({
          cloudPickerOpen: true,
          cloudPickerProject: { id: localProjectId, name: localProjectName },
          cloudSpacesError: null,
        });
        void get().cloudLoadSpaces();
        return;
      }
      set({ cloudPickerOpen: false, cloudPickerProject: null, cloudSpacesError: null });
    },

    cloudLoadSpaces: async () => {
      set({ cloudSpacesBusy: true, cloudSpacesError: null });
      try {
        const page = await cloudListProjects();
        set({ cloudSpacesBusy: false, cloudSpaces: page.records ?? [] });
      } catch (error) {
        set({
          cloudSpacesBusy: false,
          cloudSpaces: [],
          cloudSpacesError: messageOf(error),
        });
      }
    },

    cloudBindSpace: async (spaceId) => {
      const localProjectId = get().projectsState?.activeProjectId ?? "default";
      const space = (get().cloudSpaces ?? []).find((item) => item.id === spaceId);
      if (!space) {
        set({ cloudSpacesError: t("store.cloud.spaceMissing") });
        return;
      }
      const current = cloudProjectFor(localProjectId);
      const localEmpty = isShareableRowsEmpty(snapshotToRows(get().snapshot));
      if (current && current.id !== space.id && !localEmpty) {
        // 换绑 + 本地有数据：绝不静默合并或覆盖。要加入另一个空间请用
        // 「从协作空间拉取项目」新建本地项目；确定放弃本地数据可先解绑。
        set({
          cloudSpacesError: t("store.cloud.rebindBlocked", {
            current: current.name || `#${current.id}`,
            space: space.name,
          }),
        });
        return;
      }
      // 本地为空说明这个本地项目还没有任何属于自己的数据：绑定即「收养」
      // 该协作空间，projects.json 里的项目名以云端返回的名称为准，而不是
      // 保留本地默认名（否则拉完数据项目还叫「默认项目」）。
      const localProjectName =
        get().projectsState?.projects.find((project) => project.active)?.name ?? "";
      if (localEmpty && localProjectName !== space.name) {
        await get().renameProject(localProjectId, space.name);
      }
      setCloudProjectFor(localProjectId, {
        id: space.id,
        name: space.name,
        slug: space.slug,
      });
      if (!current || current.id !== space.id) {
        // 绑定关系变了：旧基线、冲突记录与 v2 CRDT 副本全部作废。
        await clearSyncBaseline(localProjectId);
        await clearSyncConflicts(localProjectId);
        clearCrdtState(localProjectId);
        set({ cloudConflicts: [], cloudConflictRecord: null });
      }
      set({ cloudPickerOpen: false, cloudPickerProject: null, cloudJustBound: "bound" });
      // 本地为空的首次绑定 / 换绑：只下载，绝不把空目录残留的墓碑推上新空间。
      const downloadOnly = localEmpty && (!current || current.id !== space.id);
      await get().cloudImport(downloadOnly ? { downloadOnly: true } : undefined);
    },

    cloudCreateAndBindSpace: async (name, slug) => {
      const localProjectId = get().projectsState?.activeProjectId ?? "default";
      set({ cloudSpacesBusy: true, cloudSpacesError: null });
      try {
        const created = await cloudCreateProject(
          name.trim() || "默认项目",
          slug.trim(),
          "由 Reqora 桌面端创建",
        );
        // 本地为空时同样以云端名称为准：projects.json 里的项目名必须等于
        // 服务端确认过的空间名，而不是留在本地默认名。
        const localEmpty = isShareableRowsEmpty(snapshotToRows(get().snapshot));
        const localProjectName =
          get().projectsState?.projects.find((project) => project.active)?.name ?? "";
        if (localEmpty && localProjectName !== created.name) {
          await get().renameProject(localProjectId, created.name);
        }
        // 新建空间：旧空间残留的 CRDT 副本必须作废，否则会把旧 change 投过去。
        clearCrdtState(localProjectId);
        setCloudProjectFor(localProjectId, {
          id: created.id,
          name: created.name,
          slug: created.slug,
        });
        set({
          cloudSpacesBusy: false,
          cloudPickerOpen: false,
          cloudPickerProject: null,
          cloudJustBound: "created",
        });
        await get().cloudImport();
      } catch (error) {
        set({ cloudSpacesBusy: false, cloudSpacesError: messageOf(error) });
      }
    },

    cloudUnbindProject: () => {
      const localProjectId = get().projectsState?.activeProjectId ?? "default";
      forgetCloudProject(localProjectId);
      // 解绑后基线与冲突记录全部作废；重新绑定时按新空间建立基线。
      void clearSyncBaseline(localProjectId);
      void clearSyncConflicts(localProjectId);
      clearCrdtState(localProjectId);
      set({
        cloudNotice: t("store.cloud.unbound"),
        cloudError: null,
        cloudConflicts: [],
        cloudConflictRecord: null,
        ...cloudView(),
      });
    },

    /** 裁决一条冲突：用本地（上传本地版本）或用云端（写回云端版本）。 */
    cloudResolveConflict: async (domain, id, useLocal) => {
      const localProjectId = get().projectsState?.activeProjectId ?? "default";
      const target = await ensureCloudProject(localProjectId);
      if (!target) {
        set({ cloudError: t("store.cloud.notBoundResolve") });
        return;
      }
      const record = await loadSyncConflicts(localProjectId);
      const entry =
        record && record.cloudProjectId === target.id
          ? record.entries.find((item) => item.domain === domain && item.id === id)
          : undefined;
      if (!entry) return;
      const crdtLocalPool =
        (snapshotToRows(get().snapshot) as unknown as Record<string, AnyRow[]>)[domain] ?? [];
      const crdtLocalRow = crdtLocalPool.find((item) => item.id === id) ?? null;
      if (
        await resolveCrdtConflictIfActive({
          localProjectId,
          domain,
          id,
          choice: useLocal ? "local" : "remote",
          localRow: crdtLocalRow as unknown as Record<string, unknown> | null,
        })
      ) {
        await finishResolution(localProjectId, target.id, domain, id, record);
        return;
      }
      set({ cloudBusy: true, cloudError: null, cloudNotice: null });
      try {
        if (useLocal) {
          // 用本地版本：打严格晚于远端的新时间戳并立即上传，否则服务端
          // LWW 可能因为本地时钟较旧而拒绝采纳这次裁决。
          const localRows = snapshotToRows(get().snapshot);
          const localRow = (
            (localRows as unknown as Record<string, AnyRow[]>)[domain] ?? []
          ).find((item) => item.id === id);
          if (!localRow) throw new Error(t("store.cloud.localRowMissing"));
          const stamped = stampMergedRow(localRow, entry.remote?.updatedAt);
          replaceLocalRow(domain, id, { ...stamped, id });
          await uploadResolvedRow(target.id, domain, id);
        } else {
          // 用云端版本：脱敏的远端行必须用本机行回填凭据后再写回快照。
          const localRows = snapshotToRows(get().snapshot);
          const localRow = (
            (localRows as unknown as Record<string, AnyRow[]>)[domain] ?? []
          ).find((item) => item.id === id);
          const cloudRow = entry.remote
            ? localRow
              ? restoreRowCredentials(entry.remote, localRow)
              : entry.remote
            : null;
          replaceLocalRow(domain, id, cloudRow);
        }
        await finishResolution(localProjectId, target.id, domain, id, record);
      } catch (error) {
        set({ cloudBusy: false, cloudError: messageOf(error) });
      }
    },

    /** 字段级合并裁决：合成行作为一次新的本地编辑写回，随后走常规同步上传。 */
    cloudResolveConflictWithMerge: async (domain, id, mergedRow) => {
      const localProjectId = get().projectsState?.activeProjectId ?? "default";
      const target = await ensureCloudProject(localProjectId);
      if (!target) {
        set({ cloudError: t("store.cloud.notBoundResolve") });
        return;
      }
      const record = await loadSyncConflicts(localProjectId);
      const entry =
        record && record.cloudProjectId === target.id
          ? record.entries.find((item) => item.domain === domain && item.id === id)
          : undefined;
      if (!entry) return;
      if (
        await resolveCrdtConflictIfActive({
          localProjectId,
          domain,
          id,
          choice: mergedRow ? "row" : "delete",
          row: mergedRow as unknown as Record<string, unknown> | null,
        })
      ) {
        await finishResolution(localProjectId, target.id, domain, id, record);
        return;
      }
      set({ cloudBusy: true, cloudError: null, cloudNotice: null });
      try {
        if (mergedRow) {
          const localRows = snapshotToRows(get().snapshot);
          const localRow = (
            (localRows as unknown as Record<string, AnyRow[]>)[domain] ?? []
          ).find((item) => item.id === id);
          // 合成行可能混入了脱敏的云端字段，先按本机行回填凭据，再打严格
          // 晚于远端的新时间戳——否则服务端 LWW 不会采纳这次合并结果。
          const restored = localRow
            ? restoreRowCredentials(mergedRow, localRow)
            : mergedRow;
          const stamped = stampMergedRow(restored, entry.remote?.updatedAt);
          replaceLocalRow(domain, id, { ...stamped, id });
          // 立刻把合成行送达服务端：收尾 cloudImport 的增量拉取才会看到
          // L == R 并收敛，否则下一轮三方合并会把合成结果重新判成冲突。
          await uploadResolvedRow(target.id, domain, id);
        } else {
          replaceLocalRow(domain, id, null);
        }
        await finishResolution(localProjectId, target.id, domain, id, record);
      } catch (error) {
        set({ cloudBusy: false, cloudError: messageOf(error) });
      }
    },

    // ---- 从协作空间拉取项目：本地还没有该项目、服务器已有时的入口 ----

    setCloudPullOpen: (open) => {
      if (open) {
        if (!readCloudConnection().baseUrl) {
          set({ cloudError: t("store.cloud.baseUrlRequired") });
          return;
        }
        if (!readCloudConnection().session) {
          set({ cloudError: t("store.cloud.loginRequired") });
          return;
        }
        set({ cloudPullOpen: true, cloudSpaces: null, cloudSpacesError: null });
        void get().cloudLoadSpaces();
        return;
      }
      set({ cloudPullOpen: false, cloudSpacesError: null });
    },

    cloudPullProject: async (spaceId, localName) => {
      const space = (get().cloudSpaces ?? []).find((item) => item.id === spaceId);
      if (!space) {
        set({ cloudSpacesError: t("store.cloud.spaceMissing") });
        return;
      }
      set({ cloudSpacesBusy: true, cloudSpacesError: null });
      try {
        // 1. 新建并切换到同名本地项目（数据落在全局数据根目录下）。
        const finalName = localName.trim() || space.name;
        await get().createProject(finalName);
        const newLocalId = get().projectsState?.activeProjectId ?? "default";
        // 兜底保证名称：无论创建路径如何，本地项目名必须等于确认时的名字。
        const createdName =
          get().projectsState?.projects.find((project) => project.active)?.name ?? "";
        if (createdName !== finalName) {
          await get().renameProject(newLocalId, finalName);
        }
        // 2. 绑定到所选空间；3. 显式仅下载全量数据到新项目。
        clearCrdtState(newLocalId);
        setCloudProjectFor(newLocalId, {
          id: space.id,
          name: space.name,
          slug: space.slug,
        });
        set({ cloudSpacesBusy: false, cloudPullOpen: false });
        await get().cloudImport({ downloadOnly: true });
      } catch (error) {
        set({ cloudSpacesBusy: false, cloudSpacesError: messageOf(error) });
      }
    },

    /** 自动同步心跳：所有前置条件不满足时静默跳过，绝不打扰用户。 */
    cloudAutoSyncTick: async () => {
      const state = get();
      const minutes = state.snapshot.settings.autoSyncMinutes ?? 5;
      if (minutes <= 0) return;
      if (state.cloudBusy || state.cloudPickerOpen || state.cloudPullOpen || state.isLoading) {
        return;
      }
      const connection = readCloudConnection();
      if (!connection.baseUrl || !connection.session) return;
      const localProjectId = state.projectsState?.activeProjectId ?? "default";
      // 未绑定的项目静默跳过：自动同步绝不替用户做「选协作空间」的决定。
      if (!cloudProjectFor(localProjectId)) return;
      await get().cloudImport();
    },

    // ---- Mock server ----

    startMock: async (port) => {
      set({ mockBusy: true, mockError: null });
      try {
        const rules = get().getMockRules();
        const info = await api.mockStart(port, rules);
        set({
          mock: {
            running: true,
            port: info.port,
            startedAt: info.startedAt,
            requestsServed: 0,
            log: [],
          },
        });
        get().pushConsole({
          level: "info",
          source: "mock",
          text: t("store.mock.started", { port: info.port, count: rules.length }),
        });
      } catch (error) {
        set({ mockError: messageOf(error) });
        get().pushConsole({ level: "error", source: "mock", text: t("store.mock.startFailed", { message: messageOf(error) }) });
      } finally {
        set({ mockBusy: false });
      }
    },

    stopMock: async () => {
      set({ mockBusy: true });
      try {
        await api.mockStop();
        set({
          mock: { running: false, port: null, startedAt: null, requestsServed: 0, log: [] },
          mockError: null,
        });
        get().pushConsole({ level: "info", source: "mock", text: t("store.mock.stopped") });
      } catch (error) {
        set({ mockError: messageOf(error) });
      } finally {
        set({ mockBusy: false });
      }
    },

    refreshMockStatus: async () => {
      try {
        const status = await api.mockStatus();
        const previous = get().mock;
        set({ mock: status });
        const newEntries = status.log.slice(previous.log.length);
        for (const entry of newEntries) {
          get().pushConsole({
            level: entry.status < 400 ? "info" : "warn",
            source: "mock",
            text: `← Mock ${entry.method} ${entry.path} · ${entry.status} · ${entry.durationMs}ms`,
          });
        }
      } catch {
        // Status polling is best effort.
      }
    },

    getMockRules: () => {
      const state = get();
      const environment = state.snapshot.environments.find(
        (item) => item.id === state.snapshot.activeEnvironmentId,
      );
      return buildMockRules(state.snapshot, variablesFrom(environment?.variables ?? []));
    },

  };
};
