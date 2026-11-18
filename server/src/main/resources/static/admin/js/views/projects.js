import { badge, esc, fmtTime, icon, onError, pagerHtml, table, toast } from '../ui.js';

export const title = '项目与成员';
export const description = '项目治理、成员角色与所有者转让';

const PROJECT_ROLES = ['VIEWER', 'EDITOR', 'ADMIN'];
const ROLE_NOTES = {
  VIEWER: '只读：查看项目、成员与工作区',
  EDITOR: '可编辑工作区内容，不可管理成员',
  ADMIN: '可管理成员、修改与归档项目',
  OWNER: '全部能力，含删除项目与转让所有者',
};

export async function render(ctx) {
  const { root, api, ui } = ctx;
  const state = ctx.state;
  state.page = state.page || 1;
  state.size = 20;
  state.keyword = state.keyword || '';

  const pageData = await api.projects(state.page, state.size, state.keyword);
  const projects = pageData.records || [];
  if (!state.projectId || !projects.some((p) => p.id === state.projectId)) {
    state.projectId = projects.length ? projects[0].id : null;
  }
  const project = projects.find((p) => p.id === state.projectId) || null;
  let members = [];
  let memberError = '';
  if (project) {
    try {
      members = await api.members(project.id);
    } catch (error) {
      memberError = error?.message || '无法读取成员列表';
    }
  }
  const canCreate = ctx.can('project:create');
  const roleOfProject = project?.memberRole || '';
  const canManageMembers = ctx.me.superAdmin || ['OWNER', 'ADMIN', 'SYSTEM'].includes(roleOfProject);

  root.innerHTML = `
    <div class="grid-2" style="grid-template-columns: minmax(280px, 360px) minmax(0, 1fr); align-items:start">
      <div class="card">
        <div class="card-head"><h3>项目列表</h3><span class="hint">${pageData.total} 个</span></div>
        <div class="card-body" style="padding:12px">
          <div class="search" style="min-width:0;width:100%">${icon('search')}<input class="input" id="project-search" placeholder="搜索项目名称 / slug" value="${esc(state.keyword)}" /></div>
          <div style="margin-top:10px;max-height:520px;overflow-y:auto">
            ${projects.length ? projects.map((p) => `
              <button class="btn ghost" data-project="${p.id}" style="width:100%;justify-content:flex-start;text-align:left;height:auto;padding:10px;margin-bottom:4px;${p.id === state.projectId ? 'background:var(--brand-soft);color:var(--brand-ink);border-color:transparent' : ''}">
                <span class="grow"><span class="cell-title">${esc(p.name)}</span>
                  <span class="cell-sub mono">${esc(p.slug)} · ${p.status === 'ACTIVE' ? '进行中' : '已归档'}</span></span>
                ${p.memberRole ? badge(p.memberRole, p.memberRole === 'OWNER' ? 'brand' : '') : ''}
              </button>`).join('') : '<div class="empty" style="padding:28px"><div class="small">没有可见项目</div></div>'}
          </div>
        </div>
        <div class="card-foot">${pagerHtml(state.page, state.size, pageData.total)}</div>
        ${canCreate ? '<div class="card-foot"><button class="btn primary sm grow" data-act="create-project">＋ 新建项目</button></div>' : ''}
      </div>

      <div>
        ${!project ? `<div class="card">${ui.emptyState('还没有项目', '创建一个项目后即可管理成员')}</div>` : `
        <div class="card">
          <div class="card-head">
            <h3>${esc(project.name)}</h3><span class="hint mono">${esc(project.slug)}</span>
            <div class="grow"></div>
            ${badge(project.status === 'ACTIVE' ? '进行中' : '已归档', project.status === 'ACTIVE' ? 'ok' : 'warn')}
            <button class="btn sm" data-act="edit-project">编辑</button>
            <button class="btn sm" data-act="archive-project">${project.status === 'ACTIVE' ? '归档' : '恢复'}</button>
            <button class="btn sm danger" data-act="delete-project" title="删除项目">${icon('trash', 13)}</button>
          </div>
          <div class="card-body small muted">
            项目 ID <span class="mono">${project.id}</span> ·
            所有者 <span class="mono">#${project.ownerId}</span> ·
            ${project.orgId ? `所属组织 <span class="mono">#${project.orgId}</span> · ` : '个人项目 · '}
            创建于 ${esc(fmtTime(project.createdAt))} · 你的项目角色 ${badge(roleOfProject || '—', 'info')}
          </div>
        </div>

        <div class="card" style="margin-top:16px">
          <div class="card-head"><h3>项目成员</h3><span class="hint">${members.length} 人</span>
            <div class="grow"></div>
            ${canManageMembers ? `
              <button class="btn sm primary" data-act="add-member">${icon('plus', 14)} 添加成员</button>
              <button class="btn sm" data-act="transfer">转让所有者</button>` : ''}
          </div>
          ${memberError ? `<div class="card-body"><div class="notice danger">${icon('alert')}<div>${esc(memberError)}</div></div></div>` : ''}
          ${table([
            { title: '成员', render: (m) => `<div class="cell-title">${esc(m.username || '(已删除)')}</div><div class="cell-sub">${esc(m.displayName || '')} ${esc(m.email || '')}</div>` },
            { title: '角色', render: (m) => m.role === 'OWNER'
                ? badge('OWNER', 'brand')
                : `<select class="select" data-member-role="${m.userId}" ${canManageMembers ? '' : 'disabled'}>
                    ${PROJECT_ROLES.map((r) => `<option value="${r}" ${m.role === r ? 'selected' : ''}>${r}</option>`).join('')}
                  </select>` },
            { title: '加入时间', render: (m) => `<span class="muted nowrap">${esc(fmtTime(m.createdAt))}</span>` },
            { title: '操作', align: 'right', render: (m) => `<div class="actions">
                ${canManageMembers && m.role !== 'OWNER' ? `<button class="btn sm danger" data-act="remove-member" data-id="${m.userId}">移除</button>` : '<span class="muted small">—</span>'}
              </div>` },
          ], members, '该项目还没有成员')}
        </div>

        <div class="card" style="margin-top:16px">
          <div class="card-head"><h3>项目角色能力矩阵</h3></div>
          <div class="card-body small">${Object.entries(ROLE_NOTES).map(([role, note]) => `
            <div class="row" style="padding:5px 0;border-bottom:1px solid var(--border)">
              ${badge(role, role === 'OWNER' ? 'brand' : 'info')}<span class="muted">${esc(note)}</span>
            </div>`).join('')}
            <div class="muted" style="margin-top:10px">组织项目的成员还会继承组织角色：MEMBER → 只读，ADMIN / OWNER → 可编辑。显式项目成员角色优先。</div>
          </div>
        </div>`}
      </div>
    </div>`;

  let debounce;
  document.getElementById('project-search')?.addEventListener('input', (event) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.keyword = event.target.value.trim();
      state.page = 1;
      state.projectId = null;
      ctx.rerender();
    }, 320);
  });
  root.querySelectorAll('[data-page]').forEach((button) => {
    button.addEventListener('click', () => { state.page = Number(button.dataset.page); state.projectId = null; ctx.rerender(); });
  });
  root.querySelectorAll('[data-project]').forEach((button) => {
    button.addEventListener('click', () => { state.projectId = Number(button.dataset.project); ctx.rerender(); });
  });
  root.querySelectorAll('select[data-member-role]').forEach((select) => {
    select.addEventListener('change', async () => {
      try {
        await api.setMemberRole(project.id, Number(select.dataset.memberRole), select.value);
        toast('项目成员角色已更新', 'ok');
        ctx.rerender();
      } catch (error) { onError(error); ctx.rerender(); }
    });
  });

  root.querySelectorAll('[data-act]').forEach((button) => {
    button.addEventListener('click', async () => {
      const action = button.dataset.act;
      try {
        if (action === 'create-project') {
          const ok = await ui.openForm({
            title: '新建项目',
            description: '创建者自动成为 OWNER。slug 用于唯一标识项目。',
            fields: [
              { name: 'name', label: '项目名称', required: true, placeholder: '支付网关 API' },
              { name: 'slug', label: '项目标识 slug', required: true, placeholder: 'payment-gateway', help: '小写字母、数字、连字符，且以字母或数字开头' },
              { name: 'description', label: '说明', placeholder: '可选' },
            ],
            submitLabel: '创建项目',
            onSubmit: async (values) => {
              const created = await api.createProject({
                name: values.name.trim(), slug: values.slug.trim().toLowerCase(), description: values.description.trim(),
              });
              state.projectId = created.id;
              state.page = 1;
              toast('项目已创建', 'ok');
            },
          });
          if (ok) ctx.rerender();
          return;
        }
        if (action === 'edit-project') {
          const ok = await ui.openForm({
            title: `编辑项目 · ${project.slug}`,
            fields: [
              { name: 'name', label: '项目名称', required: true, value: project.name },
              { name: 'description', label: '说明', value: project.description || '' },
            ],
            submitLabel: '保存',
            onSubmit: async (values) => {
              await api.updateProject(project.id, { name: values.name.trim(), description: values.description.trim() });
              toast('项目已更新', 'ok');
            },
          });
          if (ok) ctx.rerender();
          return;
        }
        if (action === 'archive-project') {
          const archived = project.status === 'ACTIVE';
          await api.archiveProject(project.id, archived);
          toast(archived ? '项目已归档' : '项目已恢复', 'ok');
          ctx.rerender();
          return;
        }
        if (action === 'delete-project') {
          const ok = await ui.confirmDialog({
            title: '删除项目',
            message: `将永久删除「${project.name}」及其成员关系与工作区数据，此操作不可撤销。`,
            confirmLabel: '删除项目',
          });
          if (!ok) return;
          await api.deleteProject(project.id);
          state.projectId = null;
          toast('项目已删除', 'ok');
          ctx.rerender();
          return;
        }
        if (action === 'add-member') {
          const ok = await ui.openForm({
            title: `添加成员 · ${project.name}`,
            description: '输入系统中已存在的用户名。OWNER 需通过「转让所有者」设置。',
            fields: [
              { name: 'username', label: '用户名', required: true, placeholder: 'zhangsan' },
              { name: 'role', label: '项目角色', type: 'select', value: 'VIEWER', options: PROJECT_ROLES.map((r) => ({ value: r, label: `${r} — ${ROLE_NOTES[r]}` })) },
            ],
            submitLabel: '添加成员',
            onSubmit: async (values) => {
              await api.addMember(project.id, { username: values.username.trim(), role: values.role });
              toast('成员已添加', 'ok');
            },
          });
          if (ok) ctx.rerender();
          return;
        }
        if (action === 'remove-member') {
          const userId = Number(button.dataset.id);
          const ok = await ui.confirmDialog({ title: '移除成员', message: '确定从项目中移除该成员吗？', confirmLabel: '移除' });
          if (!ok) return;
          await api.removeMember(project.id, userId);
          toast('成员已移除', 'ok');
          ctx.rerender();
          return;
        }
        if (action === 'transfer') {
          const candidates = members.filter((m) => m.role !== 'OWNER');
          const ok = await ui.openForm({
            title: '转让项目所有者',
            description: '转让后你将变为 ADMIN，新所有者获得全部能力。',
            fields: [{
              name: 'userId', label: '新所有者', type: 'select',
              value: candidates[0]?.userId || '',
              options: candidates.map((m) => ({ value: m.userId, label: `${m.username} (${m.displayName || m.email || m.userId}) — 当前 ${m.role}` })),
            }],
            submitLabel: '转让',
            onSubmit: async (values) => {
              if (!values.userId) throw new Error('请先添加至少一名成员');
              await api.transferOwner(project.id, Number(values.userId));
              toast('所有者已转让', 'ok');
            },
          });
          if (ok) ctx.rerender();
        }
      } catch (error) {
        onError(error);
      }
    });
  });
}
