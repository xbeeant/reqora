import { useEffect, useState } from "react";
import { Building2, Copy, Link2, LogOut, Plus, Users } from "lucide-react";
import {
  cloudAcceptInvite,
  cloudCreateInvite,
  cloudCreateOrg,
  cloudLeaveOrg,
  cloudListInvites,
  cloudListOrgs,
  cloudOrgMembers,
} from "../lib/cloud.ts";
import type { CloudInvite, CloudOrg, CloudOrgMember } from "../lib/cloud.ts";
import { useWorkspace } from "../store/workspace";
import { Button, inputClass } from "./ui";

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug.length >= 2 ? slug : `org-${Date.now().toString(36)}`;
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : "操作失败";

/** Organization / team management and invitation links (P1-5). */
export function OrgPanel() {
  const cloudUser = useWorkspace((state) => state.cloudUser);
  const [orgs, setOrgs] = useState<CloudOrg[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [members, setMembers] = useState<CloudOrgMember[]>([]);
  const [invites, setInvites] = useState<CloudInvite[]>([]);
  const [createdToken, setCreatedToken] = useState("");
  const [acceptToken, setAcceptToken] = useState("");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = async () => {
    if (!cloudUser) return;
    try {
      setOrgs(await cloudListOrgs());
    } catch (caught) {
      setError(message(caught));
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudUser]);

  const selectOrg = async (orgId: number) => {
    setSelected(orgId);
    setCreatedToken("");
    setError(null);
    try {
      const [memberRows, inviteRows] = await Promise.all([
        cloudOrgMembers(orgId),
        cloudListInvites(orgId).catch(() => [] as CloudInvite[]),
      ]);
      setMembers(memberRows);
      setInvites(inviteRows);
    } catch (caught) {
      setError(message(caught));
    }
  };

  const createOrg = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      await cloudCreateOrg(name, slugify(name));
      setNewName("");
      setNotice("组织已创建，现在可以生成邀请链接");
      await refresh();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  };

  const createInvite = async () => {
    if (selected === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await cloudCreateInvite(selected, {
        role: "MEMBER",
        maxUses: 10,
        expiresInHours: 168,
        label: "桌面端邀请",
      });
      setCreatedToken(result.token);
      setNotice("邀请链接已生成，请复制后发给成员（令牌只显示一次）");
      await selectOrg(selected);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  };

  const acceptInvite = async () => {
    const token = acceptToken.trim();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const result = await cloudAcceptInvite(token);
      setAcceptToken("");
      setNotice(`已加入「${result.orgName}」，角色 ${result.role}`);
      await refresh();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  };

  const leaveOrg = async (orgId: number) => {
    setBusy(true);
    try {
      await cloudLeaveOrg(orgId);
      if (selected === orgId) {
        setSelected(null);
        setMembers([]);
        setInvites([]);
      }
      setNotice("已退出组织");
      await refresh();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  };

  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(createdToken);
      setNotice("邀请令牌已复制");
    } catch {
      setNotice("复制失败，请手动选中下方令牌复制");
    }
  };

  return (
    <section className="border-t border-surface-border pt-5">
      <h3 className="mb-3 flex items-center gap-1.5 text-xs font-semibold text-ink">
        <Building2 className="h-3.5 w-3.5" />
        组织与邀请
      </h3>
      {!cloudUser ? (
        <p className="text-2xs text-ink-faint">请先在「协作空间（后端服务）」登录，之后可创建团队或接受邀请。</p>
      ) : (
        <div className="space-y-3">
          <p className="text-2xs leading-relaxed text-ink-faint">
            组织下可创建项目，组织成员自动获得项目只读权限，组织管理员可编辑工作区。
            邀请链接的令牌只保存 SHA-256 摘要，创建时展示一次。
          </p>

          <div className="flex items-center gap-2">
            <input
              className={`${inputClass} !h-8 min-w-0 flex-1 !text-xs`}
              placeholder="新组织名称"
              aria-label="新组织名称"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
            <Button size="sm" disabled={busy || !newName.trim()} onClick={() => void createOrg()}>
              <Plus className="h-3.5 w-3.5" />
              创建组织
            </Button>
          </div>

          {orgs.length > 0 && (
            <div className="space-y-1.5">
              {orgs.map((org) => (
                <div
                  key={org.id}
                  className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 ${
                    selected === org.id
                      ? "border-blue-300 bg-blue-50"
                      : "border-surface-border bg-surface-muted"
                  }`}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => void selectOrg(org.id)}
                  >
                    <span className="block truncate text-xs text-ink">{org.name}</span>
                    <span className="block font-mono text-2xs text-ink-faint">
                      {org.slug} · {org.memberRole}
                    </span>
                  </button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void leaveOrg(org.id)}
                  >
                    <LogOut className="h-3 w-3" />
                    退出
                  </Button>
                </div>
              ))}
            </div>
          )}

          {selected !== null && (
            <div className="space-y-2 rounded-md border border-surface-border px-2.5 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex items-center gap-1 text-2xs text-ink-soft">
                  <Users className="h-3 w-3" />
                  {members.length} 位成员
                </span>
                <Button size="sm" disabled={busy} onClick={() => void createInvite()}>
                  <Link2 className="h-3.5 w-3.5" />
                  生成邀请
                </Button>
              </div>
              {members.length > 0 && (
                <p className="truncate text-2xs text-ink-faint">
                  {members.map((member) => `${member.username}(${member.role})`).join(" · ")}
                </p>
              )}
              {invites.length > 0 && (
                <p className="text-2xs text-ink-faint">
                  有效邀请 {invites.filter((item) => item.status === "ACTIVE").length} 条 ·
                  累计使用 {invites.reduce((total, item) => total + (item.usedCount ?? 0), 0)} 次
                </p>
              )}
              {createdToken && (
                <div className="rounded-md border border-blue-200 bg-blue-50 px-2 py-1.5">
                  <div className="flex items-center gap-1.5">
                    <code className="min-w-0 flex-1 truncate font-mono text-2xs text-blue-800">
                      {createdToken}
                    </code>
                    <Button size="sm" onClick={() => void copyToken()}>
                      <Copy className="h-3 w-3" />
                      复制
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            <input
              className={`${inputClass} !h-8 min-w-0 flex-1 font-mono !text-xs`}
              placeholder="粘贴邀请令牌加入组织"
              aria-label="邀请令牌"
              value={acceptToken}
              onChange={(event) => setAcceptToken(event.target.value)}
            />
            <Button size="sm" disabled={busy || !acceptToken.trim()} onClick={() => void acceptInvite()}>
              接受邀请
            </Button>
          </div>

          {notice && <p className="text-2xs text-emerald-600">{notice}</p>}
          {error && <p className="text-2xs text-red-600">{error}</p>}
        </div>
      )}
    </section>
  );
}
