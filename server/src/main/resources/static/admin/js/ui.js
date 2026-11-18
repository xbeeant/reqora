// Shared rendering + interaction helpers. Everything is string-based so views
// can re-render themselves without a virtual DOM or any external dependency.

const PATHS = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 8.3-8.3 2 2-2 2 2 2-3 3-2-2-2 2"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  building: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 21v-4h6v4M8 7h.01M12 7h.01M16 7h.01M8 11h.01M12 11h.01M16 11h.01"/>',
  scroll: '<path d="M5 3h11a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M8 7h7M8 11h7M8 15h5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  alert: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 9v4M12 17h.01"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  activity: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};

export function icon(name, size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || PATHS.info}</svg>`;
}

export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function fmtTime(value) {
  if (!value) return '—';
  const text = String(value).replace('T', ' ');
  return text.length >= 16 ? text.slice(0, 16) : text;
}

export function badge(text, tone = '') {
  return `<span class="badge ${tone}">${esc(text)}</span>`;
}

export function statusBadge(enabled) {
  return enabled ? badge('已启用', 'ok') : badge('已停用', 'danger');
}

export function loading(text = '正在加载…') {
  return `<div class="loading"><div class="spinner"></div>${esc(text)}</div>`;
}

export function emptyState(title, description = '') {
  return `<div class="empty">${icon('folder', 30)}<div class="title">${esc(title)}</div>${description ? `<div class="small">${esc(description)}</div>` : ''}</div>`;
}

export function errorCard(error) {
  return `<div class="card"><div class="card-body"><div class="notice danger">${icon('alert')}<div><strong>加载失败</strong><div class="small">${esc(error?.message || '未知错误')}</div></div></div></div></div>`;
}

export function toast(message, tone = '') {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const node = document.createElement('div');
  node.className = `toast ${tone}`;
  node.innerHTML = `${icon(tone === 'ok' ? 'check' : tone === 'danger' ? 'alert' : 'info')}<div>${esc(message)}</div>`;
  root.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    node.style.transition = '.2s';
    setTimeout(() => node.remove(), 220);
  }, tone === 'danger' ? 5200 : 3200);
}

export function onError(error) {
  toast(error?.message || '操作失败', 'danger');
}

export function pagerHtml(page, size, total) {
  const pages = Math.max(1, Math.ceil((total || 0) / size));
  const current = Math.min(Math.max(1, page), pages);
  return `<div class="pager">
    <button class="btn sm" data-page="${current - 1}" ${current <= 1 ? 'disabled' : ''}>${icon('left', 13)}</button>
    <span>第 ${current} / ${pages} 页 · 共 ${total || 0} 条</span>
    <button class="btn sm" data-page="${current + 1}" ${current >= pages ? 'disabled' : ''}>${icon('right', 13)}</button>
  </div>`;
}

/** columns: [{ title, key, render(row), width, align }] */
export function table(columns, rows, emptyText = '暂无数据') {
  if (!rows || rows.length === 0) return emptyState(emptyText);
  return `<div class="table-wrap"><table class="table"><thead><tr>${
    columns.map((c) => {
      const styles = [c.width ? `width:${c.width}` : '', c.align === 'right' ? 'text-align:right' : '']
        .filter(Boolean).join(';');
      return `<th${styles ? ` style="${styles}"` : ''}>${esc(c.title)}</th>`;
    }).join('')
  }</tr></thead><tbody>${
    rows.map((row) => `<tr>${columns.map((c) => `<td${c.align === 'right' ? ' style="text-align:right"' : ''}>${c.render ? c.render(row) : esc(row[c.key])}</td>`).join('')}</tr>`).join('')
  }</tbody></table></div>`;
}

function fieldHtml(field) {
  const id = `f_${field.name}`;
  const label = field.label ? `<label for="${id}">${esc(field.label)}${field.required ? ' <span style="color:var(--danger)">*</span>' : ''}</label>` : '';
  let control = '';
  const value = field.value ?? '';
  if (field.type === 'select') {
    control = `<select class="select" id="${id}" name="${field.name}" ${field.disabled ? 'disabled' : ''}>${
      (field.options || []).map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')
    }</select>`;
  } else if (field.type === 'textarea') {
    control = `<textarea class="textarea" id="${id}" name="${field.name}" rows="${field.rows || 3}" placeholder="${esc(field.placeholder || '')}">${esc(value)}</textarea>`;
  } else if (field.type === 'checks') {
    const selected = new Set(Array.isArray(value) ? value.map(String) : []);
    control = `<div class="check-list">${(field.options || []).map((o) => `
      <label class="check-item">
        <input type="checkbox" name="${field.name}" value="${esc(o.value)}" ${selected.has(String(o.value)) ? 'checked' : ''} ${o.disabled ? 'disabled' : ''} />
        <span><strong>${esc(o.label)}</strong>${o.desc ? `<span class="desc">${esc(o.desc)}</span>` : ''}</span>
      </label>`).join('') || '<span class="muted small">暂无可选项</span>'}</div>`;
  } else if (field.type === 'static') {
    control = `<div class="input mono" style="background:var(--surface-2);border-style:dashed">${esc(value)}</div>`;
  } else {
    control = `<input class="input" id="${id}" name="${field.name}" type="${field.type || 'text'}"
      value="${esc(value)}" placeholder="${esc(field.placeholder || '')}"
      ${field.required ? 'required' : ''} ${field.min !== undefined ? `min="${field.min}"` : ''} ${field.max !== undefined ? `max="${field.max}"` : ''} autocomplete="off" />`;
  }
  return `<div class="field">${label}${control}${field.help ? `<div class="help">${esc(field.help)}</div>` : ''}</div>`;
}

function readForm(form, fields) {
  const values = {};
  for (const field of fields) {
    if (field.type === 'checks') {
      values[field.name] = [...form.querySelectorAll(`input[name="${field.name}"]:checked`)].map((el) => el.value);
    } else if (field.type === 'static') {
      values[field.name] = field.value ?? '';
    } else {
      values[field.name] = form.elements[field.name]?.value ?? '';
    }
  }
  return values;
}

function closeModal(host) {
  host?.remove();
}

/** Promise<boolean>: resolves true after a successful submit, false on cancel. */
export function openForm({ title, description = '', fields = [], submitLabel = '保存', danger = false, wide = false, onSubmit }) {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.className = 'modal-backdrop';
    host.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head"><h3>${esc(title)}</h3>${description ? `<p>${esc(description)}</p>` : ''}</div>
      <form class="modal-body" novalidate>${fields.map(fieldHtml).join('')}<div class="modal-error" hidden></div></form>
      <div class="modal-foot">
        <button class="btn" data-role="cancel">取消</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-role="submit">${danger ? icon('trash', 14) : icon('check', 14)}${esc(submitLabel)}</button>
      </div>
    </div>`;
    document.getElementById('modal-root').appendChild(host);
    const form = host.querySelector('form');
    const errBox = host.querySelector('.modal-error');
    const submit = host.querySelector('[data-role="submit"]');
    let keyHandler = null;
    const finish = (result) => {
      if (keyHandler) document.removeEventListener('keydown', keyHandler);
      closeModal(host);
      resolve(result);
    };
    host.querySelector('[data-role="cancel"]').addEventListener('click', () => finish(false));
    host.addEventListener('mousedown', (event) => { if (event.target === host) finish(false); });
    keyHandler = (event) => {
      if (event.key === 'Escape') finish(false);
    };
    document.addEventListener('keydown', keyHandler);
    const showError = (message) => { errBox.textContent = message; errBox.hidden = false; };
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      errBox.hidden = true;
      const values = readForm(form, fields);
      for (const field of fields) {
        if (field.required && field.type !== 'checks' && !String(values[field.name] || '').trim()) {
          showError(`请填写「${field.label || field.name}」`);
          return;
        }
      }
      submit.disabled = true;
      submit.textContent = '处理中…';
      try {
        await onSubmit(values);
        finish(true);
      } catch (error) {
        showError(error?.message || '操作失败');
        submit.disabled = false;
        submit.innerHTML = `${danger ? icon('trash', 14) : icon('check', 14)}${esc(submitLabel)}`;
      }
    });
    submit.addEventListener('click', () => form.requestSubmit());
    form.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target.tagName !== 'TEXTAREA') {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    const first = form.querySelector('input:not([type=hidden]), select, textarea');
    if (first) setTimeout(() => first.focus(), 40);
  });
}

export function confirmDialog({ title = '确认操作', message, confirmLabel = '确定', danger = true }) {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.className = 'modal-backdrop';
    host.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head"><h3>${esc(title)}</h3><p>${esc(message || '')}</p></div>
      <div class="modal-foot">
        <button class="btn" data-role="cancel">取消</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-role="ok">${esc(confirmLabel)}</button>
      </div>
    </div>`;
    document.getElementById('modal-root').appendChild(host);
    let keyHandler = null;
    const finish = (value) => {
      if (keyHandler) document.removeEventListener('keydown', keyHandler);
      host.remove();
      resolve(value);
    };
    host.querySelector('[data-role="cancel"]').addEventListener('click', () => finish(false));
    host.querySelector('[data-role="ok"]').addEventListener('click', () => finish(true));
    host.addEventListener('mousedown', (event) => { if (event.target === host) finish(false); });
    keyHandler = (event) => { if (event.key === 'Escape') finish(false); };
    document.addEventListener('keydown', keyHandler);
  });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板', 'ok');
  } catch {
    toast('复制失败，请手动选择文本', 'warn');
  }
}
