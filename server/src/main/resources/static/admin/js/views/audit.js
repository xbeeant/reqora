import { badge, esc, fmtTime, icon, onError, pagerHtml, table, toast } from '../ui.js';

export const title = '审计日志';
export const description = '所有管理操作的追加式留痕，支持筛选与导出';

function actionTone(action) {
  if (/delete|remove|revoke|disable/i.test(action)) return 'danger';
  if (/create|add|invite/i.test(action)) return 'ok';
  if (/role|permission|grant|status|transfer/i.test(action)) return 'warn';
  return 'info';
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

export async function render(ctx) {
  const { root, api, ui } = ctx;
  const state = ctx.state;
  state.page = state.page || 1;
  state.size = 20;
  state.keyword = state.keyword || '';
  state.action = state.action || '';

  const [pageData, actions] = await Promise.all([
    api.auditLogs(state.page, state.size, state.keyword, state.action),
    api.auditActions().catch(() => []),
  ]);
  const rows = pageData.records || [];

  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>操作记录</h3><span class="hint">共 ${pageData.total} 条</span>
        <div class="grow"></div>
        <div class="search">${icon('search')}<input class="input" id="audit-search" placeholder="搜索操作人 / 动作 / 详情" value="${esc(state.keyword)}" /></div>
        <select class="select" id="audit-action" style="width:190px">
          <option value="">全部操作类型</option>
          ${actions.map((a) => `<option value="${esc(a)}" ${state.action === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}
        </select>
        <button class="btn sm" data-act="refresh">${icon('refresh', 14)}</button>
        <button class="btn sm" data-act="csv">导出当前页</button>
      </div>
      ${table([
        { title: '时间', render: (r) => `<span class="nowrap muted">${esc(fmtTime(r.createdAt))}</span>` },
        { title: '操作', render: (r) => badge(r.action, actionTone(r.action)) },
        { title: '操作人', render: (r) => `<div class="cell-title">${esc(r.actorName || '—')}</div><div class="cell-sub">#${r.actorId}</div>` },
        { title: '目标', render: (r) => `<span class="mono">${esc(r.targetType || '—')}${r.targetId ? ` · ${esc(r.targetId)}` : ''}</span>` },
        { title: '说明', render: (r) => `<div class="truncate" style="max-width:320px" title="${esc(r.detail)}">${esc(r.detail || '—')}</div>` },
        { title: '操作', align: 'right', render: (r) => `<div class="actions"><button class="btn sm" data-act="detail" data-id="${r.id}">详情</button></div>` },
      ], rows, '没有匹配的审计记录')}
      <div class="card-foot"><div class="grow"></div>${pagerHtml(state.page, state.size, pageData.total)}</div>
    </div>
    <div class="notice info" style="margin-top:14px">${icon('info')}<div>审计日志只追加、不修改，且从不记录密码、令牌或工作区内容。导出仅包含当前页已加载的记录。</div></div>`;

  let debounce;
  document.getElementById('audit-search').addEventListener('input', (event) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { state.keyword = event.target.value.trim(); state.page = 1; ctx.rerender(); }, 320);
  });
  document.getElementById('audit-action').addEventListener('change', (event) => {
    state.action = event.target.value;
    state.page = 1;
    ctx.rerender();
  });
  root.querySelectorAll('[data-page]').forEach((button) => {
    button.addEventListener('click', () => { state.page = Number(button.dataset.page); ctx.rerender(); });
  });

  root.querySelectorAll('[data-act]').forEach((button) => {
    button.addEventListener('click', async () => {
      const action = button.dataset.act;
      try {
        if (action === 'refresh') return ctx.rerender();
        if (action === 'csv') {
          const head = ['时间', '操作', '操作人', '目标类型', '目标 ID', '说明', '请求 ID', 'IP'];
          const body = rows.map((r) => [r.createdAt, r.action, r.actorName, r.targetType, r.targetId, r.detail, r.requestId, r.ip].map(csvCell).join(','));
          const blob = new Blob(['\uFEFF' + [head.map(csvCell).join(','), ...body].join('\n')], { type: 'text/csv;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = `reqora-audit-${new Date().toISOString().slice(0, 10)}.csv`;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          toast('已导出当前页', 'ok');
          return;
        }
        if (action === 'detail') {
          const log = rows.find((r) => String(r.id) === button.dataset.id);
          await ui.openForm({
            title: `审计详情 · #${log.id}`,
            fields: [
              { name: 'time', label: '时间', type: 'static', value: fmtTime(log.createdAt) },
              { name: 'action', label: '操作', type: 'static', value: log.action },
              { name: 'actor', label: '操作人', type: 'static', value: `${log.actorName || '—'} (#${log.actorId})` },
              { name: 'target', label: '目标', type: 'static', value: `${log.targetType || '—'} · ${log.targetId || '—'}` },
              { name: 'detail', label: '说明', type: 'textarea', value: log.detail || '' },
              { name: 'requestId', label: '请求 ID', type: 'static', value: log.requestId || '—' },
              { name: 'ip', label: '来源 IP', type: 'static', value: log.ip || '—' },
            ],
            submitLabel: '关闭',
            onSubmit: async () => {},
          });
        }
      } catch (error) {
        onError(error);
      }
    });
  });
}
