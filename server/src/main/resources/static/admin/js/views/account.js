import { badge, copyText, esc, fmtTime, icon, onError, toast } from '../ui.js';
import { getState, logout } from '../api.js';

export const title = '我的账号';
export const description = '个人资料、生效权限与会话管理';

export async function render(ctx) {
  const { root, api, ui, me } = ctx;
  const state = getState();

  root.innerHTML = `
    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h3>账号信息</h3></div>
        <div class="card-body">
          <div class="row" style="gap:14px">
            <div class="avatar" style="width:46px;height:46px;font-size:18px">${esc((me.displayName || me.username || 'U').slice(0, 1).toUpperCase())}</div>
            <div><div style="font-size:16px;font-weight:650">${esc(me.displayName || me.username)}</div>
              <div class="small muted">${esc(me.username)} · ${esc(me.email || '—')}</div></div>
          </div>
          <div class="section-title">角色</div>
          <div class="row" style="gap:6px">
            ${me.superAdmin ? badge('SUPER_ADMIN', 'brand') : ''}
            ${[...(me.roles || [])].filter((r) => r !== 'SUPER_ADMIN').map((r) => badge(r, 'info')).join('') || '<span class="muted small">未分配系统角色</span>'}
          </div>
          <div class="section-title">生效权限（${(me.permissions || []).length}）</div>
          <div class="row" style="gap:6px">
            ${(me.permissions || []).map((p) => `<span class="badge mono">${esc(p)}</span>`).join('') || '<span class="muted small">仅拥有项目 / 组织成员权限</span>'}
          </div>
          <div class="section-title">会话</div>
          <div class="small muted">账号创建于 ${esc(fmtTime(me.createdAt))}。服务端每次请求都会重新读取角色与状态，管理员调整后立即生效。</div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>安全与连接</h3></div>
        <div class="card-body">
          <div class="field">
            <label>服务地址</label>
            <div class="row">
              <div class="input mono grow" style="background:var(--surface-2);border-style:dashed">${esc(state.server)}</div>
              <button class="btn sm" data-act="copy-server">${icon('copy', 13)} 复制</button>
            </div>
            <div class="help">管理端页面本身不带凭据；所有 API 请求均使用会话中保存的 Bearer 令牌。</div>
          </div>
          <div class="field">
            <label>修改密码</label>
            <div class="small muted">修改成功后当前账号的所有刷新令牌会失效，需要重新登录。</div>
            <button class="btn" data-act="change-password" style="margin-top:10px">${icon('lock', 14)} 修改密码</button>
          </div>
          <div class="field" style="margin-bottom:0">
            <label>退出登录</label>
            <div class="small muted">凭据默认保存在当前标签页会话中；如勾选「保留登录状态」，会保存在本浏览器，退出后一并清除。</div>
            <button class="btn danger" data-act="logout" style="margin-top:10px">${icon('logout', 14)} 退出管理端</button>
          </div>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="card-head"><h3>管理端能力一览</h3></div>
      <div class="card-body small muted">
        概览（聚合统计与最近操作）· 用户管理（增删改、角色、启停、重置密码）· 角色管理（自定义角色与内置保护）·
        授权管理（角色 × 权限矩阵、用户批量授予）· 项目与成员（项目治理、成员角色、所有者转让）·
        组织与成员（组织成员角色、邀请链接）· 审计日志（筛选、详情、CSV 导出）。所有写操作均写入服务端审计日志。
      </div>
    </div>`;

  root.querySelectorAll('[data-act]').forEach((button) => {
    button.addEventListener('click', async () => {
      const action = button.dataset.act;
      try {
        if (action === 'copy-server') return copyText(state.server);
        if (action === 'change-password') {
          const ok = await ui.openForm({
            title: '修改密码',
            description: '密码长度 8–72 位。修改后需要重新登录。',
            fields: [
              { name: 'oldPassword', label: '当前密码', type: 'password', required: true },
              { name: 'newPassword', label: '新密码', type: 'password', required: true, placeholder: '至少 8 位' },
            ],
            submitLabel: '修改密码',
            onSubmit: async (values) => {
              await api.changePassword(values.oldPassword, values.newPassword);
              toast('密码已修改，请重新登录', 'ok');
            },
          });
          if (ok) {
            await logout();
            window.dispatchEvent(new CustomEvent('admin:session-expired'));
          }
          return;
        }
        if (action === 'logout') {
          const ok = await ui.confirmDialog({ title: '退出登录', message: '确定要退出管理端吗？', confirmLabel: '退出' });
          if (!ok) return;
          await logout();
          window.dispatchEvent(new CustomEvent('admin:session-expired'));
        }
      } catch (error) {
        onError(error);
      }
    });
  });
}
