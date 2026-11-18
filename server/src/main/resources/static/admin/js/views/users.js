import { esc, fmtTime, icon, onError, pagerHtml, statusBadge, table, toast } from '../ui.js';

export const title = '用户管理';
export const description = '创建账号、分配角色、启停与重置密码';

const FALLBACK_ROLES = ['USER', 'ADMIN', 'SUPER_ADMIN'];

async function loadRoles(api, superAdmin) {
  try {
    const roles = await api.roles();
    return roles.map((role) => ({
      value: role.code,
      label: `${role.code} · ${role.name}`,
      desc: role.description || (role.builtin ? '系统内置角色' : '自定义角色'),
    }));
  } catch {
    return FALLBACK_ROLES.map((code) => ({ value: code, label: code, desc: '' }));
  }
}

export async function render(ctx) {
  const { root, api, ui, me } = ctx;
  const state = ctx.state;
  state.page = state.page || 1;
  state.size = 20;
  state.keyword = state.keyword || '';

  const [pageData, roleOptions] = await Promise.all([
    api.users(state.page, state.size, state.keyword),
    loadRoles(api, me.superAdmin),
  ]);
  const rows = pageData.records || [];
  const canWrite = ctx.can('system:user:write');
  const assignable = me.superAdmin
    ? roleOptions
    : roleOptions.filter((option) => option.value === 'USER');

  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>全部用户</h3><span class="hint">共 ${pageData.total} 个账号</span>
        <div class="grow"></div>
        <div class="search">${icon('search')}<input class="input" id="user-search" placeholder="搜索用户名 / 邮箱 / 姓名" value="${esc(state.keyword)}" /></div>
        <button class="btn sm" data-act="refresh" title="刷新">${icon('refresh', 14)}</button>
        ${canWrite ? `<button class="btn primary sm" data-act="create">${icon('plus', 14)} 新建用户</button>` : ''}
      </div>
      ${table([
        { title: '用户', render: (r) => `<div class="cell-title">${esc(r.username)}</div><div class="cell-sub">${esc(r.displayName || '')}</div>` },
        { title: '邮箱', key: 'email' },
        { title: '状态', render: (r) => statusBadge(r.status === 1) },
        { title: '创建时间', render: (r) => `<span class="muted nowrap">${esc(fmtTime(r.createdAt))}</span>` },
        { title: '操作', align: 'right', render: (r) => `<div class="actions">
            <button class="btn sm" data-act="detail" data-id="${r.id}">详情</button>
            ${canWrite ? `
              <button class="btn sm" data-act="roles" data-id="${r.id}">角色</button>
              <button class="btn sm" data-act="password" data-id="${r.id}">重置密码</button>
              <button class="btn sm ${r.status === 1 ? 'danger' : ''}" data-act="status" data-id="${r.id}" data-enabled="${r.status === 1 ? 0 : 1}">${r.status === 1 ? '停用' : '启用'}</button>
              <button class="btn sm danger" data-act="delete" data-id="${r.id}" title="删除">${icon('trash', 13)}</button>` : ''}
          </div>` },
      ], rows, '没有匹配的用户')}
      <div class="card-foot"><div class="grow"></div>${pagerHtml(state.page, state.size, pageData.total)}</div>
    </div>
    ${canWrite ? `<div class="notice info" style="margin-top:14px">${icon('info')}<div>新建 / 改角色操作遵循防提权规则：非超级管理员只能分配 <span class="mono">USER</span> 角色；系统会阻止移除最后一个超级管理员。</div></div>` : ''}`;

  const search = document.getElementById('user-search');
  let debounce;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.keyword = search.value.trim();
      state.page = 1;
      ctx.rerender();
    }, 320);
  });
  root.querySelectorAll('[data-page]').forEach((button) => {
    button.addEventListener('click', () => {
      state.page = Number(button.dataset.page);
      ctx.rerender();
    });
  });

  const findRow = (id) => rows.find((row) => String(row.id) === String(id));

  root.querySelectorAll('[data-act]').forEach((button) => {
    button.addEventListener('click', async () => {
      const action = button.dataset.act;
      const id = Number(button.dataset.id);
      const row = findRow(id);
      try {
        if (action === 'refresh') return ctx.rerender();
        if (action === 'create') {
          const ok = await ui.openForm({
            title: '新建用户',
            description: '账号创建后立即启用；密码长度 8–72 位。',
            fields: [
              { name: 'username', label: '用户名', required: true, placeholder: 'zhangsan', help: '字母、数字、点、下划线、连字符，3–64 位' },
              { name: 'email', label: '邮箱', type: 'email', required: true, placeholder: 'user@example.com' },
              { name: 'displayName', label: '显示名称', placeholder: '张三' },
              { name: 'password', label: '初始密码', type: 'password', required: true, placeholder: '至少 8 位' },
              { name: 'roles', label: '系统角色', type: 'checks', value: ['USER'], options: assignable },
            ],
            submitLabel: '创建用户',
            onSubmit: async (values) => {
              if (!values.roles.length) values.roles = ['USER'];
              await api.createUser({
                username: values.username.trim(),
                email: values.email.trim(),
                displayName: values.displayName.trim(),
                password: values.password,
                roles: values.roles,
              });
              toast('用户已创建', 'ok');
            },
          });
          if (ok) ctx.rerender();
          return;
        }
        if (action === 'detail') {
          const detail = await api.user(id);
          await ui.openForm({
            title: `用户详情 · ${row?.username || id}`,
            description: '账号状态与生效权限',
            fields: [
              { name: 'id', label: '用户 ID', type: 'static', value: detail.id },
              { name: 'status', label: '状态', type: 'static', value: detail.status === 1 ? '已启用' : '已停用' },
              { name: 'roles', label: '角色', type: 'static', value: [...(detail.roles || [])].join(', ') || '—' },
              { name: 'perms', label: '生效权限', type: 'static', value: [...(detail.permissions || [])].join(', ') || '—' },
              { name: 'created', label: '创建时间', type: 'static', value: fmtTime(detail.createdAt) },
            ],
            submitLabel: '关闭',
            onSubmit: async () => {},
          });
          return;
        }
        if (action === 'roles') {
          const detail = await api.user(id);
          const options = me.superAdmin
            ? roleOptions
            : roleOptions.map((option) => ({ ...option, disabled: option.value !== 'USER' }));
          const ok = await ui.openForm({
            title: `分配角色 · ${row?.username || id}`,
            description: '覆盖式设置，提交后该账号仅保留勾选的角色。',
            fields: [{ name: 'roles', label: '系统角色', type: 'checks', value: [...(detail.roles || [])], options }],
            submitLabel: '保存角色',
            onSubmit: async (values) => {
              if (!values.roles.length) throw new Error('至少保留一个角色');
              await api.setUserRoles(id, values.roles);
              toast('角色已更新，立即生效', 'ok');
            },
          });
          if (ok) ctx.rerender();
          return;
        }
        if (action === 'password') {
          const ok = await ui.openForm({
            title: `重置密码 · ${row?.username || id}`,
            description: '重置后该账号所有登录令牌立即失效。',
            fields: [{ name: 'password', label: '新密码', type: 'password', required: true, placeholder: '至少 8 位' }],
            submitLabel: '重置密码',
            onSubmit: async (values) => {
              await api.resetUserPassword(id, values.password);
              toast('密码已重置', 'ok');
            },
          });
          if (ok) ctx.rerender();
          return;
        }
        if (action === 'status') {
          const enabled = button.dataset.enabled === '1';
          const ok = await ui.confirmDialog({
            title: enabled ? '启用账号' : '停用账号',
            message: `确定${enabled ? '启用' : '停用'}「${row?.username || id}」吗？${enabled ? '' : '该账号的所有登录令牌会立即失效。'}`,
            confirmLabel: enabled ? '启用' : '停用',
            danger: !enabled,
          });
          if (!ok) return;
          await api.setUserStatus(id, enabled);
          toast(enabled ? '账号已启用' : '账号已停用', 'ok');
          ctx.rerender();
          return;
        }
        if (action === 'delete') {
          const ok = await ui.confirmDialog({
            title: '删除用户',
            message: `将永久删除「${row?.username || id}」及其角色、成员关系与刷新令牌。若该用户仍拥有项目或组织，操作会被服务端拒绝。`,
            confirmLabel: '删除',
          });
          if (!ok) return;
          await api.deleteUser(id);
          toast('用户已删除', 'ok');
          ctx.rerender();
        }
      } catch (error) {
        onError(error);
      }
    });
  });
}
