import { badge, esc, fmtTime, icon, onError, table, toast } from '../ui.js';

export const title = '角色管理';
export const description = '系统级角色、内置保护与权限点目录';

export async function render(ctx) {
  const { root, api, ui, me } = ctx;
  const [roles, permissions] = await Promise.all([api.roles(), api.permissions()]);
  const canWrite = ctx.can('system:role:write');
  const permByModule = new Map();
  for (const permission of permissions) {
    if (!permByModule.has(permission.module)) permByModule.set(permission.module, []);
    permByModule.get(permission.module).push(permission);
  }

  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>系统角色</h3><span class="hint">共 ${roles.length} 个角色 · ${permissions.length} 个权限点</span>
        <div class="grow"></div>
        <button class="btn sm" data-act="refresh">${icon('refresh', 14)} 刷新</button>
        ${canWrite ? `<button class="btn primary sm" data-act="create">${icon('plus', 14)} 新建角色</button>` : ''}
      </div>
      ${table([
        { title: '角色', render: (r) => `<div class="cell-title mono">${esc(r.code)}</div><div class="cell-sub">${esc(r.name)} ${r.builtin ? badge('内置', 'info') : ''}</div>` },
        { title: '说明', render: (r) => `<span class="muted">${esc(r.description || '—')}</span>` },
        { title: '权限', render: (r) => r.code === 'SUPER_ADMIN'
            ? badge('全部权限（运行时直通）', 'brand')
            : `<span class="badge">${r.permissions.length} 项</span>` },
        { title: '创建时间', render: (r) => `<span class="muted nowrap">${esc(fmtTime(r.createdAt))}</span>` },
        { title: '操作', align: 'right', render: (r) => `<div class="actions">
            ${canWrite ? `<button class="btn sm" data-act="perms" data-id="${r.id}">配置权限</button>
            <button class="btn sm" data-act="edit" data-id="${r.id}" ${r.builtin ? 'disabled title="内置角色不可修改"' : ''}>编辑</button>
            <button class="btn sm danger" data-act="delete" data-id="${r.id}" ${r.builtin ? 'disabled title="内置角色不可删除"' : ''}>${icon('trash', 13)}</button>` : '<span class="muted small">只读</span>'}
          </div>` },
      ], roles, '暂无角色')}
    </div>

    <div class="section-title">权限点目录</div>
    <div class="grid-2">
      ${[...permByModule.entries()].map(([module, items]) => `
        <div class="card">
          <div class="card-head"><h3>${esc(module === 'system' ? '系统管理' : module === 'project' ? '项目' : esc(module))}</h3><span class="hint">${items.length} 项</span></div>
          <div class="card-body" style="padding:8px 18px">
            ${items.map((p) => `<div style="padding:9px 0;border-bottom:1px solid var(--border)">
              <div class="row"><span class="mono cell-title">${esc(p.code)}</span>${badge(p.name, 'brand')}</div>
              <div class="small muted">${esc(p.description || '—')}</div>
              <div class="small muted" style="margin-top:4px">已授予：${roles.filter((r) => r.permissions.includes(p.code)).map((r) => esc(r.code)).join('、') || '无'}</div>
            </div>`).join('')}
          </div>
        </div>`).join('')}
    </div>
    <div class="notice warn" style="margin-top:16px">${icon('alert')}<div>内置角色 <span class="mono">SUPER_ADMIN / ADMIN / USER</span> 不可改名或删除，但可为它们调整权限点。超级管理员在运行时始终绕过权限校验，因此其授权矩阵仅作展示。</div></div>`;

  root.querySelectorAll('[data-act]').forEach((button) => {
    button.addEventListener('click', async () => {
      const action = button.dataset.act;
      const id = Number(button.dataset.id);
      const role = roles.find((item) => item.id === id);
      try {
        if (action === 'refresh') return ctx.rerender();
        if (action === 'create') {
          const ok = await ui.openForm({
            title: '新建角色',
            description: '角色编码创建后不可修改，需为大写字母 / 数字 / 下划线。',
            fields: [
              { name: 'code', label: '角色编码', required: true, placeholder: 'AUDITOR', help: '例如 AUDITOR、TEAM_LEAD' },
              { name: 'name', label: '显示名称', required: true, placeholder: '审计员' },
              { name: 'description', label: '说明', placeholder: '只能查看审计日志' },
              { name: 'permissions', label: '初始权限', type: 'checks', value: [], options: permissions.map((p) => ({ value: p.code, label: `${p.code} · ${p.name}`, desc: p.description })) },
            ],
            wide: true,
            submitLabel: '创建角色',
            onSubmit: async (values) => {
              const created = await api.createRole({
                code: values.code.trim().toUpperCase(),
                name: values.name.trim(),
                description: values.description.trim(),
              });
              if (values.permissions.length) await api.setRolePermissions(created.id, values.permissions);
              toast('角色已创建', 'ok');
            },
          });
          if (ok) ctx.rerender();
          return;
        }
        if (action === 'edit') {
          const ok = await ui.openForm({
            title: `编辑角色 · ${role.code}`,
            fields: [
              { name: 'code', label: '角色编码', type: 'static', value: role.code },
              { name: 'name', label: '显示名称', required: true, value: role.name },
              { name: 'description', label: '说明', value: role.description || '' },
            ],
            submitLabel: '保存',
            onSubmit: async (values) => {
              await api.updateRole(id, { name: values.name.trim(), description: values.description.trim() });
              toast('角色已更新', 'ok');
            },
          });
          if (ok) ctx.rerender();
          return;
        }
        if (action === 'perms') {
          const isSuper = role.code === 'SUPER_ADMIN';
          const ok = await ui.openForm({
            title: `配置权限 · ${role.code}`,
            description: isSuper
              ? '超级管理员在运行时拥有全部权限，此处的勾选仅影响授权矩阵展示。'
              : '覆盖式设置：提交后该角色仅保留勾选的权限点。',
            fields: [{
              name: 'permissions', label: '权限点', type: 'checks',
              value: role.permissions,
              options: permissions.map((p) => ({
                value: p.code,
                label: `${p.code} · ${p.name}`,
                desc: p.description,
                disabled: !me.superAdmin && !ctx.can(p.code),
              })),
            }],
            wide: true,
            submitLabel: '保存权限',
            onSubmit: async (values) => {
              await api.setRolePermissions(id, values.permissions);
              toast('权限已更新，立即生效', 'ok');
            },
          });
          if (ok) ctx.rerender();
          return;
        }
        if (action === 'delete') {
          const ok = await ui.confirmDialog({
            title: '删除角色',
            message: `将删除「${role.code}」并解除所有用户的该角色绑定。`,
            confirmLabel: '删除',
          });
          if (!ok) return;
          await api.deleteRole(id);
          toast('角色已删除', 'ok');
          ctx.rerender();
        }
      } catch (error) {
        onError(error);
      }
    });
  });
}
