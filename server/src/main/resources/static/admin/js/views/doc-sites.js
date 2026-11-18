import { badge, esc, fmtTime, icon, onError, pagerHtml, table, toast } from '../ui.js';

export const title = '文档发布';
export const description = '查看和管理所有已发布的文档站分享';

const STATUS_LABELS = { ACTIVE: '已发布', REVOKED: '已撤销', EXPIRED: '已过期' };
const STATUS_BADGES = { ACTIVE: 'ok', REVOKED: 'danger', EXPIRED: 'warn' };

export async function render(ctx) {
  const { root, api } = ctx;
  const state = ctx.state;
  state.page = state.page || 1;
  state.size = 20;
  state.projectId = null;
  state.status = '';
  state.keyword = '';

  // Load projects for filter dropdown
  let projects = [];
  try {
    const pageData = await api.projects(1, 100, '');
    projects = pageData.records || [];
  } catch {
    // Non-fatal: filter dropdown will show as "全部项目"
  }
  const hasProjects = projects.length > 0;

  const docSites = await api.adminDocSites(state.page, state.size, state.projectId, state.status, state.keyword);
  const total = docSites.total || 0;

  root.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><h3>文档发布</h3></div>
      <div class="card-body">
        <div class="toolbar" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          ${hasProjects ? `
          <select id="filter-project" class="select" style="min-width:200px">
            <option value="">全部项目</option>
            ${projects.map((p) => `<option value="${p.id}" ${state.projectId === p.id ? 'selected' : ''}>${esc(p.name)} (${esc(p.slug)})</option>`).join('')}
          </select>` : '<span class="muted" style="min-width:200px">全部项目</span>'}
          <select id="filter-status" class="select" style="min-width:120px">
            <option value="">全部状态</option>
            <option value="ACTIVE" ${state.status === 'ACTIVE' ? 'selected' : ''}>已发布</option>
            <option value="REVOKED" ${state.status === 'REVOKED' ? 'selected' : ''}>已撤销</option>
            <option value="EXPIRED" ${state.status === 'EXPIRED' ? 'selected' : ''}>已过期</option>
          </select>
          <input id="filter-search" class="input" placeholder="搜索文档标题…" value="${esc(state.keyword)}" style="min-width:220px" />
          <span class="grow"></span>
          <span class="muted" style="font-size:12px">共 ${total} 条</span>
        </div>
      </div>
    </div>
    <div class="card">
      ${total === 0 ? `<div class="empty" style="padding:28px">${icon('info', 26)}<div class="title">暂无已发布文档</div><div class="small">项目下没有 ACTIVE 状态的文档站分享</div></div>` : table([
        {
          title: '项目',
          render: (d) => `<div class="cell-title">${esc(d.projectName)}</div><div class="cell-sub mono">${esc(d.projectSlug)}</div>`
        },
        { title: '标题', render: (d) => esc(d.title || '—') },
        {
          title: '状态',
          render: (d) => badge(STATUS_LABELS[d.status] || d.status, STATUS_BADGES[d.status] || '')
        },
        { title: '浏览量', render: (d) => String(d.viewCount || 0) },
        { title: '过期时间', render: (d) => d.expiresAt ? esc(fmtTime(d.expiresAt)) : '<span class="muted">永不过期</span>' },
        { title: '创建时间', render: (d) => esc(fmtTime(d.createdAt)) },
        {
          title: '操作',
          align: 'right',
          render: (d) => {
            const isRevoked = d.status === 'REVOKED';
            const btns = [
              `<button class="btn sm" data-act="view" data-id="${d.id}" ${isRevoked ? 'disabled' : ''}>${icon('external', 12)} 查看</button>`
            ];
            if (!isRevoked) {
              btns.push(`<button class="btn sm danger" data-act="revoke" data-id="${d.id}">${icon('trash', 12)} 撤销</button>`);
            }
            return `<div class="actions">${btns.join('')}</div>`;
          }
        }
      ], docSites.records, '')}
    </div>
    <div style="margin-top:12px;display:flex;justify-content:flex-end">${pagerHtml(state.page, state.size, total)}</div>`;

  // --- Event handlers ---

  let searchTimer;
  document.getElementById('filter-search')?.addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.keyword = event.target.value.trim();
      state.page = 1;
      ctx.rerender();
    }, 400);
  });

  document.getElementById('filter-project')?.addEventListener('change', (event) => {
    state.projectId = event.target.value ? Number(event.target.value) : null;
    state.page = 1;
    ctx.rerender();
  });

  document.getElementById('filter-status')?.addEventListener('change', (event) => {
    state.status = event.target.value;
    state.page = 1;
    ctx.rerender();
  });

  root.querySelectorAll('[data-page]').forEach((button) => {
    button.addEventListener('click', () => {
      state.page = Number(button.dataset.page);
      ctx.rerender();
    });
  });

  root.querySelectorAll('[data-act]').forEach((button) => {
    button.addEventListener('click', async () => {
      const action = button.dataset.act;
      const id = Number(button.dataset.id);
      try {
        if (action === 'view') {
          const record = docSites.records?.find(r => r.id === id);
          if (record) {
            toast(`查看文档：${esc(record.title || '—')}（项目：${esc(record.projectName)}）`, 'ok');
          }
        }
        if (action === 'revoke') {
          const record = docSites.records?.find(r => r.id === id);
          if (!record) {
            onError(new Error('无法找到文档记录'));
            return;
          }
          const ok = await ctx.ui.confirmDialog({
            title: '撤销文档分享',
            message: `撤销「${esc(record.title || '—')}」后，公开链接将立即失效，确定继续？`,
            confirmLabel: '撤销',
          });
          if (!ok) return;
          await api.revokeDocSite(id, record.projectId);
          toast('文档分享已撤销', 'ok');
          ctx.rerender();
        }
      } catch (error) {
        onError(error);
        ctx.rerender();
      }
    });
  });
}
