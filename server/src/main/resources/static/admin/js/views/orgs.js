import { badge, esc, fmtTime, icon, onError, table, toast } from '../ui.js';
import { getState } from '../api.js';

export const title = '组织与成员';
export const description = '团队、组织成员角色与邀请链接';

const ASSIGNABLE = ['MEMBER', 'ADMIN'];

export async function render(ctx) {
  const { root, api, ui } = ctx;
  const state = ctx.state;
  const useAdmin = ctx.can('system:org:read');
  const canWrite = ctx.can('system:org:write');

  let orgs = [];
  try {
    orgs = useAdmin ? await api.adminOrgs() : await api.myOrgs();
  } catch (error) {
    root.innerHTML = ui.errorCard(error);
    return;
  }
  if (!state.orgId || !orgs.some((org) => org.id === state.orgId)) {
    state.orgId = orgs.length ? orgs[0].id : null;
  }
  const org = orgs.find((item) => item.id === state.orgId) || null;

  let members = [];
  let memberError = '';
  let invites = [];
  let inviteError = '';
  if (org) {
    try {
      members = useAdmin ? await api.adminOrgMembers(org.id) : await api.orgMembers(org.id);
    } catch (error) { memberError = error?.message || '无法读取组织成员'; }
    try {
      invites = await api.invites(org.id);
    } catch (error) { inviteError = error?.message || '无法读取邀请链接（需要组织管理员权限）'; }
  }

  root.innerHTML = `
    <div class="grid-2" style="grid-template-columns: minmax(260px, 330px) minmax(0, 1fr); align-items:start">
      <div class="card">
        <div class="card-head"><h3>组织列表</h3><span class="hint">${orgs.length} 个${useAdmin ? '' : ' · 我加入的'}</span></div>
        <div class="card-body" style="padding:10px;max-height:560px;overflow-y:auto">
          ${orgs.length ? orgs.map((item) => `
            <button class="btn ghost" data-org="${item.id}" style="width:100%;justify-content:flex-start;text-align:left;height:auto;padding:10px;margin-bottom:4px;${item.id === state.orgId ? 'background:var(--brand-soft);color:var(--brand-ink);border-color:transparent' : ''}">
              <span class="grow"><span class="cell-title">${esc(item.name)}</span>
                <span class="cell-sub mono">${esc(item.slug)}</span>
                <span class="cell-sub">${item.memberCount !== undefined ? `${item.memberCount} 名成员 · ${item.projectCount} 个项目` : `我的角色 ${esc(item.memberRole || '')}`}</span></span>
            </button>`).join('') : '<div class="empty" style="padding:26px"><div class="small">还没有组织</div></div>'}
        </div>
        <div class="card-foot"><button class="btn primary sm grow" data-act="create-org">＋ 创建组织</button></div>
      </div>

      <div>
        ${!org ? `<div class="card">${ui.emptyState('还没有组织', '创建一个组织后可邀请成员加入')}</div>` : `
        <div class="card">
          <div class="card-head"><h3>${esc(org.name)}</h3><span class="hint mono">${esc(org.slug)}</span>
            <div class="grow"></div>${badge(org.status || 'ACTIVE', 'ok')}</div>
          <div class="card-body small muted">
            组织 ID <span class="mono">${org.id}</span> ·
            所有者 <span class="mono">${esc(org.ownerName || `#${org.ownerId}`)}</span> ·
            ${org.description ? esc(org.description) : '无说明'}
          </div>
        </div>

        <div class="card" style="margin-top:16px">
          <div class="card-head"><h3>组织成员</h3><span class="hint">${members.length} 人</span>
            <div class="grow"></div>
            ${canWrite ? `<button class="btn sm primary" data-act="add-member">${icon('plus', 14)} 添加成员</button>` : ''}
          </div>
          ${memberError ? `<div class="card-body"><div class="notice danger">${icon('alert')}<div>${esc(memberError)}</div></div></div>` : ''}
          ${table([
            { title: '成员', render: (m) => `<div class="cell-title">${esc(m.username)}</div><div class="cell-sub">${esc(m.displayName || '')} ${esc(m.email || '')}</div>` },
            { title: '角色', render: (m) => m.role === 'OWNER'
                ? badge('OWNER', 'brand')
                : canWrite
                  ? `<select class="select" data-org-role="${m.userId}">${ASSIGNABLE.map((r) => `<option value="${r}" ${m.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select>`
                  : badge(m.role, 'info') },
            { title: '加入时间', render: (m) => `<span class="muted nowrap">${esc(fmtTime(m.joinedAt))}</span>` },
            { title: '操作', align: 'right', render: (m) => `<div class="actions">
                ${canWrite && m.role !== 'OWNER' ? `<button class="btn sm danger" data-act="remove-member" data-id="${m.userId}">移除</button>` : '<span class="muted small">—</span>'}
              </div>` },
          ], members, '该组织还没有成员')}
          ${canWrite ? '' : `<div class="card-foot small muted">只读模式：需要 <span class="mono">system:org:write</span> 才能添加 / 调整 / 移除组织成员。</div>`}
        </div>

        <div class="card" style="margin-top:16px">
          <div class="card-head"><h3>邀请链接</h3><span class="hint">用于让新成员自助加入组织</span>
            <div class="grow"></div><button class="btn sm primary" data-act="create-invite">${icon('link', 14)} 生成邀请</button>
          </div>
          ${inviteError ? `<div class="card-body"><div class="notice warn">${icon('alert')}<div>${esc(inviteError)}</div></div></div>` : ''}
          ${table([
            { title: '标签', render: (i) => `<div class="cell-title">${esc(i.label || '未命名邀请')}</div><div class="cell-sub">ID #${i.id}</div>` },
            { title: '加入角色', render: (i) => badge(i.role, i.role === 'ADMIN' ? 'warn' : 'info') },
            { title: '使用情况', render: (i) => `${i.usedCount} / ${i.maxUses} 次` },
            { title: '过期时间', render: (i) => `<span class="muted nowrap">${esc(fmtTime(i.expiresAt))}</span>` },
            { title: '状态', render: (i) => badge(i.status, i.status === 'ACTIVE' ? 'ok' : '') },
            { title: '操作', align: 'right', render: (i) => `<div class="actions"><button class="btn sm danger" data-act="revoke-invite" data-id="${i.id}">撤销</button></div>` },
          ], invites, '暂无邀请链接')}
        </div>`}
      </div>
    </div>
    <div class="notice info" style="margin-top:16px">${icon('info')}<div>组织角色：MEMBER（只读继承）、ADMIN（可管理组织与邀请）、OWNER（创建者，唯一且不可移除）。组织项目的成员会自动继承组织角色，显式项目成员设置优先。</div></div>`;

  root.querySelectorAll('[data-org]').forEach((button) => {
    button.addEventListener('click', () => { state.orgId = Number(button.dataset.org); ctx.rerender(); });
  });
  root.querySelectorAll('select[data-org-role]').forEach((select) => {
    select.addEventListener('change', async () => {
      try {
        await api.setOrgMemberRole(org.id, Number(select.dataset.orgRole), select.value);
        toast('组织成员角色已更新', 'ok');
        ctx.rerender();
      } catch (error) { onError(error); ctx.rerender(); }
    });
  });

  root.querySelectorAll('[data-act]').forEach((button) => {
    button.addEventListener('click', async () => {
      const action = button.dataset.act;
      try {
        if (action === 'create-org') {
          const ok = await ui.openForm({
            title: '创建组织',
            description: '创建者自动成为组织 OWNER。',
            fields: [
              { name: 'name', label: '组织名称', required: true, placeholder: '平台研发组' },
              { name: 'slug', label: '组织标识 slug', required: true, placeholder: 'platform-team', help: '小写字母、数字、连字符' },
              { name: 'description', label: '说明', placeholder: '可选' },
            ],
            submitLabel: '创建组织',
            onSubmit: async (values) => {
              const created = await api.createOrg({
                name: values.name.trim(), slug: values.slug.trim().toLowerCase(), description: values.description.trim(),
              });
              state.orgId = created.id;
              toast('组织已创建', 'ok');
            },
          });
          if (ok) ctx.rerender();
          return;
        }
        if (action === 'add-member') {
          const ok = await ui.openForm({
            title: `添加组织成员 · ${org.name}`,
            description: '输入系统中已存在的用户名。OWNER 由创建组织时确定，不可指派。',
            fields: [
              { name: 'username', label: '用户名', required: true, placeholder: 'zhangsan' },
              { name: 'role', label: '组织角色', type: 'select', value: 'MEMBER', options: [
                { value: 'MEMBER', label: 'MEMBER — 普通成员（组织项目只读）' },
                { value: 'ADMIN', label: 'ADMIN — 组织管理员（可管理邀请）' },
              ] },
            ],
            submitLabel: '添加成员',
            onSubmit: async (values) => {
              await api.addOrgMember(org.id, { username: values.username.trim(), role: values.role });
              toast('成员已加入组织', 'ok');
            },
          });
          if (ok) ctx.rerender();
          return;
        }
        if (action === 'remove-member') {
          const ok = await ui.confirmDialog({ title: '移除组织成员', message: '确定从组织中移除该成员吗？', confirmLabel: '移除' });
          if (!ok) return;
          await api.removeOrgMember(org.id, Number(button.dataset.id));
          toast('成员已移除', 'ok');
          ctx.rerender();
          return;
        }
        if (action === 'create-invite') {
          const ok = await ui.openForm({
            title: '生成邀请链接',
            description: '令牌仅在创建时展示一次，请妥善保存。',
            fields: [
              { name: 'label', label: '标签', placeholder: '2026 秋招新同事' },
              { name: 'role', label: '加入后角色', type: 'select', value: 'MEMBER', options: [
                { value: 'MEMBER', label: 'MEMBER — 普通成员' }, { value: 'ADMIN', label: 'ADMIN — 组织管理员' },
              ] },
              { name: 'maxUses', label: '最大使用次数', type: 'number', value: 10, min: 1, max: 100 },
              { name: 'expiresInHours', label: '有效期（小时）', type: 'number', value: 168, min: 1, max: 720 },
            ],
            submitLabel: '生成',
            onSubmit: async (values) => {
              const result = await api.createInvite(org.id, {
                label: values.label.trim(), role: values.role,
                maxUses: Number(values.maxUses), expiresInHours: Number(values.expiresInHours),
              });
              await ui.openForm({
                title: '邀请已生成',
                description: '把「令牌」发给对方，对方在客户端「设置 → 协作空间 → 接受邀请」处输入即可加入。令牌仅展示一次。',
                fields: [
                  { name: 'token', label: '邀请令牌（可手动选中复制）', type: 'static', value: result.token },
                  { name: 'api', label: '服务地址', type: 'static', value: getState().server },
                  { name: 'id', label: '邀请 ID', type: 'static', value: result.invite?.id ?? '' },
                ],
                submitLabel: '完成',
                onSubmit: async () => {},
              });
              toast('邀请链接已生成', 'ok');
            },
          });
          if (ok) ctx.rerender();
          return;
        }
        if (action === 'revoke-invite') {
          const ok = await ui.confirmDialog({ title: '撤销邀请', message: '撤销后该邀请链接立即失效。', confirmLabel: '撤销' });
          if (!ok) return;
          await api.revokeInvite(org.id, Number(button.dataset.id));
          toast('邀请已撤销', 'ok');
          ctx.rerender();
        }
      } catch (error) {
        onError(error);
      }
    });
  });
}
