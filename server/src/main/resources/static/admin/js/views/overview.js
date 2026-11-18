import { badge, esc, fmtTime, icon } from '../ui.js';

export const title = '概览';
export const description = '系统运行状况与最近的管理操作';

function statCard({ label, value, foot, iconName, tone = 'brand' }) {
  return `<div class="card stat">
    <div class="label">${esc(label)}<span class="iconbox">${icon(iconName)}</span></div>
    <div class="value">${esc(value)}</div>
    <div class="foot">${esc(foot)}</div>
  </div>`;
}

export async function render(ctx) {
  const { root, api, me } = ctx;
  const data = await api.overview();
  const quick = [
    { route: 'users', label: '新建用户', iconName: 'users', show: ctx.can('system:user:write') },
    { route: 'roles', label: '新建角色', iconName: 'shield', show: ctx.can('system:role:write') },
    { route: 'grants', label: '批量授权', iconName: 'key', show: ctx.can('system:user:write') },
    { route: 'projects', label: '项目成员', iconName: 'folder', show: true },
    { route: 'orgs', label: '组织成员', iconName: 'building', show: true },
    { route: 'audit', label: '审计日志', iconName: 'scroll', show: ctx.can('system:audit:read') },
  ].filter((item) => item.show);

  const logs = data.recentLogs || [];
  root.innerHTML = `
    <div class="stats">
      ${statCard({ label: '系统用户', value: data.users, foot: `${data.enabledUsers} 启用 / ${data.disabledUsers} 停用`, iconName: 'users' })}
      ${statCard({ label: '角色 · 权限点', value: `${data.roles} / ${data.permissions}`, foot: '系统级 RBAC 配置', iconName: 'shield' })}
      ${statCard({ label: '协作项目', value: data.projects, foot: `${data.activeProjects} 进行中 / ${data.archivedProjects} 已归档`, iconName: 'folder' })}
      ${statCard({ label: '组织', value: data.organizations, foot: '团队与成员共享空间', iconName: 'building' })}
      ${statCard({ label: '审计记录', value: data.auditTotal, foot: `今日新增 ${data.auditToday} 条`, iconName: 'scroll' })}
    </div>

    <div class="section-title">快捷操作</div>
    <div class="card"><div class="card-body row">
      ${quick.map((item) => `<button class="btn" data-route="${item.route}">${icon(item.iconName, 14)} ${esc(item.label)}</button>`).join('')}
    </div></div>

    <div class="grid-2" style="margin-top:16px">
      <div class="card">
        <div class="card-head"><h3>最近操作</h3><span class="hint">审计日志最新 8 条</span></div>
        ${logs.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>时间</th><th>操作</th><th>操作人</th><th>说明</th></tr></thead><tbody>
          ${logs.map((log) => `<tr>
            <td class="nowrap muted">${esc(fmtTime(log.createdAt))}</td>
            <td class="mono">${esc(log.action)}</td>
            <td>${esc(log.actorName || '—')}</td>
            <td class="truncate" style="max-width:280px" title="${esc(log.detail)}">${esc(log.detail || '—')}</td>
          </tr>`).join('')}
        </tbody></table></div>` : `<div class="empty" style="padding:28px">${icon('info', 26)}<div class="title">暂无审计记录</div><div class="small">${me.superAdmin || ctx.can('system:audit:read') ? '开始管理操作后会出现在这里' : '当前账号无审计日志查看权限'}</div></div>`}
      </div>

      <div class="card">
        <div class="card-head"><h3>当前会话</h3><span class="hint">权限随角色变更实时生效</span></div>
        <div class="card-body">
          <div class="row" style="gap:12px">
            <div class="avatar" style="width:38px;height:38px;font-size:15px">${esc((me.displayName || me.username || 'U').slice(0, 1).toUpperCase())}</div>
            <div><div class="cell-title">${esc(me.displayName || me.username)}</div><div class="small muted">${esc(me.email || me.username)}</div></div>
          </div>
          <div style="margin:14px 0 8px" class="row">
            ${me.superAdmin ? badge('超级管理员', 'brand') : ''}
            ${[...(me.roles || [])].filter((r) => r !== 'SUPER_ADMIN').map((r) => badge(r, 'info')).join('')}
          </div>
          <div class="section-title" style="margin:16px 0 8px">生效的系统权限（${(me.permissions || []).length}）</div>
          <div class="row" style="gap:6px">
            ${(me.permissions || []).length
              ? [...me.permissions].map((p) => `<span class="badge mono">${esc(p)}</span>`).join('')
              : '<span class="muted small">无系统级权限，仅可按项目 / 组织成员身份访问</span>'}
          </div>
          <div class="notice info" style="margin-top:18px">${icon('info')}<div>服务端时间 ${esc(fmtTime(data.serverTime))}。角色与权限每次请求都从数据库读取，修改后立即生效，无需重新登录。</div></div>
        </div>
      </div>
    </div>`;

  root.querySelectorAll('[data-route]').forEach((button) => {
    button.addEventListener('click', () => ctx.navigate(button.dataset.route));
  });
}
