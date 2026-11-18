import { badge, esc, icon, onError, toast } from '../ui.js';

export const title = '授权管理';
export const description = '角色 × 权限矩阵，以及用户角色的批量授予';

export async function render(ctx) {
  const { root, api, ui } = ctx;
  const [roles, permissions] = await Promise.all([api.roles(), api.permissions()]);
  const canWrite = ctx.can('system:role:write');
  const canUserWrite = ctx.can('system:user:write');
  const state = ctx.state;
  state.selected = state.selected || new Set();
  state.grantRoles = state.grantRoles || new Set();
  state.mode = state.mode || 'add';
  state.userKeyword = state.userKeyword || '';
  state.users = state.users || [];

  if (!state.usersLoaded) {
    const page = await api.users(1, 100, state.userKeyword);
    state.users = page.records || [];
    state.usersLoaded = true;
  }

  const selectedUsers = state.users.filter((user) => state.selected.has(String(user.id)));

  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>角色 × 权限矩阵</h3>
        <span class="hint">${canWrite ? '点击复选框即时保存，变更立即生效' : '当前账号只有查看权限'}</span>
        <div class="grow"></div>
        <button class="btn sm" data-act="refresh">${icon('refresh', 14)} 刷新</button>
      </div>
      <div class="table-wrap" style="padding-bottom:4px">
        <table class="table matrix">
          <thead><tr>
            <th style="min-width:170px">角色</th>
            ${permissions.map((p) => `<th class="perm" title="${esc(p.code)}：${esc(p.description || p.name)}">${esc(p.code)}</th>`).join('')}
          </tr></thead>
          <tbody>
            ${roles.map((role) => `<tr>
              <td><div class="cell-title mono">${esc(role.code)}</div><div class="cell-sub">${esc(role.name)} ${role.builtin ? badge('内置', 'info') : ''}</div></td>
              ${permissions.map((p) => {
                const checked = role.code === 'SUPER_ADMIN' || role.permissions.includes(p.code);
                const disabled = !canWrite || role.code === 'SUPER_ADMIN';
                return `<td class="center"><input type="checkbox" data-role-id="${role.id}" data-role-code="${esc(role.code)}" data-perm="${esc(p.code)}"
                  ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} title="${esc(p.name)}" /></td>`;
              }).join('')}
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="card-foot"><span class="small muted">超级管理员运行时绕过所有校验，因此该行固定为全选且不可编辑。</span></div>
    </div>

    <div class="section-title">批量授予用户角色</div>
    ${canUserWrite ? `
    <div class="card">
      <div class="card-head"><h3>选择用户</h3><span class="hint">已选 ${state.selected.size} 人</span>
        <div class="grow"></div>
        <div class="search">${icon('search')}<input class="input" id="grant-search" placeholder="搜索用户" value="${esc(state.userKeyword)}" /></div>
        <button class="btn sm" data-act="search">搜索</button>
      </div>
      <div class="card-body">
        <div class="check-list" style="max-height:220px">
          ${state.users.length ? state.users.map((user) => `
            <label class="check-item">
              <input type="checkbox" data-user="${user.id}" ${state.selected.has(String(user.id)) ? 'checked' : ''} />
              <span><strong>${esc(user.username)}</strong> <span class="muted">${esc(user.displayName || '')}</span>
                <span class="desc">${esc(user.email)} ${user.status === 1 ? '' : '· 已停用'}</span></span>
            </label>`).join('') : '<span class="muted small">没有匹配的用户，试试其他关键字</span>'}
        </div>
        <div class="row" style="margin-top:12px">
          <button class="btn sm" data-act="select-all">全选当前结果</button>
          <button class="btn sm ghost" data-act="clear-users">清空选择</button>
        </div>
      </div>
      <div class="card-head" style="border-top:1px solid var(--border)"><h3>授权设置</h3></div>
      <div class="card-body">
        <div class="grid-2">
          <div class="field" style="margin:0">
            <label>角色</label>
            <div class="check-list" style="max-height:190px">
              ${roles.map((role) => `<label class="check-item">
                <input type="checkbox" data-grant-role="${esc(role.code)}" ${state.grantRoles.has(role.code) ? 'checked' : ''} />
                <span><strong>${esc(role.code)}</strong><span class="desc">${esc(role.name)} · ${role.permissions.length} 项权限</span></span>
              </label>`).join('')}
            </div>
          </div>
          <div>
            <div class="field">
              <label for="grant-mode">操作方式</label>
              <select class="select" id="grant-mode">
                <option value="add" ${state.mode === 'add' ? 'selected' : ''}>追加角色（保留原有角色）</option>
                <option value="remove" ${state.mode === 'remove' ? 'selected' : ''}>移除指定角色</option>
                <option value="replace" ${state.mode === 'replace' ? 'selected' : ''}>覆盖为指定角色</option>
              </select>
              <div class="help">服务端会逐账号检查防提权规则，并阻止移除最后一个超级管理员。</div>
            </div>
            <div class="notice ${state.mode === 'replace' ? 'warn' : 'info'}">${icon('info')}<div id="grant-summary">${esc(summaryText(state, selectedUsers.length))}</div></div>
            <button class="btn primary" data-act="apply" style="margin-top:14px">${icon('key', 14)} 应用授权</button>
          </div>
        </div>
      </div>
    </div>` : `<div class="notice warn">${icon('lock')}<div>批量授权需要 <span class="mono">system:user:write</span> 权限，当前账号无法使用。</div></div>`}

    <div class="notice info" style="margin-top:16px">${icon('info')}<div>授权层次：系统角色决定管理端能力；项目成员角色（OWNER / ADMIN / EDITOR / VIEWER）决定项目内能力；组织角色（OWNER / ADMIN / MEMBER）决定团队内能力。三层相互独立，可在「项目与成员」「组织与成员」页分别调整。</div></div>`;

  function summaryText(s, count) {
    const rolesText = [...s.grantRoles].join('、') || '（未选角色）';
    const modeText = { add: '追加', remove: '移除', replace: '覆盖为' }[s.mode];
    return `将对 ${count} 个账号${modeText}角色：${rolesText}`;
  }

  root.querySelectorAll('input[data-user]').forEach((box) => {
    box.addEventListener('change', () => {
      if (box.checked) state.selected.add(box.dataset.user);
      else state.selected.delete(box.dataset.user);
      ctx.rerender();
    });
  });
  root.querySelectorAll('input[data-grant-role]').forEach((box) => {
    box.addEventListener('change', () => {
      if (box.checked) state.grantRoles.add(box.dataset.grantRole);
      else state.grantRoles.delete(box.dataset.grantRole);
      ctx.rerender();
    });
  });
  const modeSelect = document.getElementById('grant-mode');
  modeSelect?.addEventListener('change', () => { state.mode = modeSelect.value; ctx.rerender(); });

  root.querySelectorAll('input[data-perm]:not([disabled])').forEach((box) => {
    box.addEventListener('change', async () => {
      const roleId = Number(box.dataset.roleId);
      const role = roles.find((r) => r.id === roleId);
      const boxes = [...root.querySelectorAll(`input[data-role-id="${roleId}"]`)];
      const next = boxes.filter((b) => b.checked).map((b) => b.dataset.perm);
      box.disabled = true;
      try {
        await api.setRolePermissions(roleId, next);
        role.permissions = next;
        toast(`${role.code} 的权限已更新`, 'ok');
      } catch (error) {
        box.checked = !box.checked;
        onError(error);
      } finally {
        box.disabled = false;
      }
    });
  });

  root.querySelectorAll('[data-act]').forEach((button) => {
    button.addEventListener('click', async () => {
      const action = button.dataset.act;
      try {
        if (action === 'refresh') { state.usersLoaded = false; return ctx.rerender(); }
        if (action === 'search') {
          state.userKeyword = document.getElementById('grant-search').value.trim();
          state.usersLoaded = false;
          return ctx.rerender();
        }
        if (action === 'select-all') {
          state.users.forEach((user) => state.selected.add(String(user.id)));
          return ctx.rerender();
        }
        if (action === 'clear-users') {
          state.selected.clear();
          return ctx.rerender();
        }
        if (action === 'apply') {
          const userIds = [...state.selected].map(Number);
          const roleCodes = [...state.grantRoles];
          if (!userIds.length) return toast('请先选择用户', 'warn');
          if (!roleCodes.length) return toast('请至少选择一个角色', 'warn');
          const ok = await ui.confirmDialog({
            title: '确认批量授权',
            message: `${summaryText(state, userIds.length)}。此操作会写入审计日志。`,
            confirmLabel: '应用授权',
          });
          if (!ok) return;
          const result = await api.batchGrant({ userIds, roleCodes, mode: state.mode });
          if (result.skipped?.length) {
            toast(`已更新 ${result.updated} 人，跳过 ${result.skipped.length} 人：${result.skipped[0]}`, 'warn');
          } else {
            toast(`已更新 ${result.updated} 个账号`, 'ok');
          }
          state.usersLoaded = false;
          ctx.rerender();
        }
      } catch (error) {
        onError(error);
      }
    });
  });
}
