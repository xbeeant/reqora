import * as apiModule from './api.js';
import * as ui from './ui.js';
import { ApiError, api, getState, login, logout, restore, serverFromQuery } from './api.js';

import * as overview from './views/overview.js';
import * as users from './views/users.js';
import * as roles from './views/roles.js';
import * as grants from './views/grants.js';
import * as projects from './views/projects.js';
import * as orgs from './views/orgs.js';
import * as audit from './views/audit.js';
import * as docSites from './views/doc-sites.js';
import * as account from './views/account.js';

const VIEWS = { overview, users, roles, grants, projects, orgs, audit, docSites, account };
const ROUTES = [
  { id: 'overview', label: '概览', icon: 'overview', group: '总览', perm: 'console' },
  { id: 'users', label: '用户管理', icon: 'users', group: '身份与权限', perm: 'system:user:read' },
  { id: 'roles', label: '角色管理', icon: 'shield', group: '身份与权限', perm: 'system:role:read' },
  { id: 'grants', label: '授权管理', icon: 'key', group: '身份与权限', perm: 'system:role:read' },
  { id: 'projects', label: '项目与成员', icon: 'folder', group: '协作资源', perm: null },
  { id: 'orgs', label: '组织与成员', icon: 'building', group: '协作资源', perm: null },
  { id: 'audit', label: '审计日志', icon: 'scroll', group: '协作资源', perm: 'system:audit:read' },
  { id: 'docSites', label: '文档发布', icon: 'globe', group: '协作资源', perm: null },
  { id: 'account', label: '我的账号', icon: 'user', group: '设置', perm: null },
];

const THEME_KEY = 'reqora.admin.theme.v1';
const stateByRoute = {};
let renderToken = 0;

function theme() {
  return localStorage.getItem(THEME_KEY) || 'light';
}
function applyTheme(value) {
  document.documentElement.setAttribute('data-theme', value);
  localStorage.setItem(THEME_KEY, value);
}

function can(permission) {
  const me = getState().user;
  if (!me) return false;
  if (me.superAdmin) return true;
  const perms = me.permissions || [];
  if (permission === 'console') {
    return ['system:user:read', 'system:role:read', 'system:org:read', 'system:audit:read']
      .some((p) => perms.includes(p));
  }
  return perms.includes(permission);
}

function visibleRoutes() {
  return ROUTES.filter((route) => !route.perm || can(route.perm));
}

function currentRoute() {
  const raw = (location.hash || '').replace(/^#\/?/, '').split('?')[0];
  return VIEWS[raw] ? raw : (can('console') ? 'overview' : 'projects');
}

function navigate(id) {
  location.hash = `#/${id}`;
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

function renderLogin(message) {
  const app = document.getElementById('app');
  const server = serverFromQuery();
  app.innerHTML = `<div class="login-wrap"><div class="login-card">
    <div class="login-brand">
      <div class="mark">R</div>
      <div><h1>Reqora 管理端</h1><p>用户 · 角色 · 授权 · 项目成员 · 审计</p></div>
    </div>
    <form id="login-form" novalidate>
      <div class="field">
        <label for="login-server">服务地址</label>
        <input class="input" id="login-server" name="server" value="${ui.esc(server)}" placeholder="http://127.0.0.1:18080" autocomplete="off" />
        <div class="help">默认使用当前站点；管理端可指向任意已部署的 Reqora 服务。</div>
      </div>
      <div class="field">
        <label for="login-user">用户名</label>
        <input class="input" id="login-user" name="username" placeholder="admin" autocomplete="username" required />
      </div>
      <div class="field">
        <label for="login-pass">密码</label>
        <input class="input" id="login-pass" name="password" type="password" placeholder="••••••••" autocomplete="current-password" required />
      </div>
      <label class="check-item" style="padding-left:0">
        <input type="checkbox" id="login-remember" /> <span>在此浏览器保留登录状态</span>
      </label>
      <div id="login-error" class="field-error">${ui.esc(message || '')}</div>
      <button class="btn primary" type="submit">登录</button>
    </form>
    <div class="login-hint">仅静态页面公开，所有数据接口均需 Bearer 令牌。登录凭据默认保存在当前标签页的会话存储中，关闭标签页即失效。</div>
  </div></div>`;

  const form = document.getElementById('login-form');
  const errorBox = document.getElementById('login-error');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.textContent = '';
    const button = form.querySelector('button[type=submit]');
    const values = new FormData(form);
    if (!values.get('username') || !values.get('password')) {
      errorBox.textContent = '请输入用户名和密码';
      return;
    }
    button.disabled = true;
    button.textContent = '登录中…';
    try {
      await login({
        server: values.get('server'),
        username: String(values.get('username')).trim(),
        password: String(values.get('password')),
        remember: document.getElementById('login-remember').checked,
      });
      await bootShell();
    } catch (error) {
      errorBox.textContent = error?.message || '登录失败';
      button.disabled = false;
      button.textContent = '登录';
    }
  });
  setTimeout(() => document.getElementById('login-user')?.focus(), 50);
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function renderShell() {
  const me = getState().user;
  const app = document.getElementById('app');
  const routes = visibleRoutes();
  let lastGroup = '';
  const navHtml = routes.map((route) => {
    let groupHtml = '';
    if (route.group !== lastGroup) {
      lastGroup = route.group;
      groupHtml = `<div class="nav-group">${ui.esc(route.group)}</div>`;
    }
    return `${groupHtml}<button class="nav-item" data-route="${route.id}">${ui.icon(route.icon)}<span>${ui.esc(route.label)}</span></button>`;
  }).join('');

  app.innerHTML = `<div class="shell">
    <aside class="sidebar" id="sidebar">
      <div class="brand">
        <div class="mark">R</div>
        <div><div class="brand-name">Reqora</div><div class="brand-sub">管理控制台</div></div>
      </div>
      <nav class="nav">${navHtml}</nav>
      <div class="sidebar-foot">
        <a href="${ui.esc(getState().server)}/health" target="_blank" rel="noopener">${ui.icon('activity', 13)} 服务健康检查</a>
        <div style="margin-top:4px">本地优先 · 可自托管</div>
      </div>
    </aside>
    <div class="main">
      <header class="topbar">
        <button class="btn icon ghost menu-toggle" id="menu-toggle" aria-label="菜单">${ui.icon('menu')}</button>
        <div><h2 id="page-title">概览</h2><div class="sub" id="page-sub"></div></div>
        <div class="spacer"></div>
        <button class="btn icon ghost" id="theme-toggle" title="切换主题">${ui.icon(theme() === 'dark' ? 'sun' : 'moon')}</button>
        <button class="btn sm" id="logout-btn">${ui.icon('logout', 13)} 退出</button>
        <div class="user-chip">
          <div class="avatar">${ui.esc((me.displayName || me.username || 'U').slice(0, 1).toUpperCase())}</div>
          <div class="name" title="${ui.esc(me.username)}">${ui.esc(me.displayName || me.username)}</div>
        </div>
      </header>
      <main class="content" id="view-root">${ui.loading()}</main>
    </div>
  </div>`;

  app.querySelectorAll('[data-route]').forEach((button) => {
    button.addEventListener('click', () => {
      navigate(button.dataset.route);
      document.getElementById('sidebar')?.classList.remove('open');
    });
  });
  document.getElementById('menu-toggle').addEventListener('click', () => {
    document.getElementById('sidebar')?.classList.toggle('open');
  });
  document.getElementById('theme-toggle').addEventListener('click', () => {
    const next = theme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    document.getElementById('theme-toggle').innerHTML = ui.icon(next === 'dark' ? 'sun' : 'moon');
  });
  document.getElementById('logout-btn').addEventListener('click', async () => {
    if (!(await ui.confirmDialog({ title: '退出登录', message: '确定要退出管理端吗？', confirmLabel: '退出' }))) return;
    await logout();
    renderLogin();
  });
}

async function renderRoute() {
  const route = currentRoute();
  const view = VIEWS[route];
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.classList.toggle('active', button.dataset.route === route);
  });
  document.getElementById('page-title').textContent = view.title || route;
  document.getElementById('page-sub').textContent = view.description || '';

  const definition = ROUTES.find((r) => r.id === route);
  const root = document.getElementById('view-root');
  if (definition?.perm && !can(definition.perm)) {
    root.innerHTML = `<div class="notice warn">${ui.icon('lock')}<div>当前账号没有「${ui.esc(definition.label)}」所需的权限，请联系超级管理员授权。</div></div>`;
    return;
  }

  const token = ++renderToken;
  root.innerHTML = ui.loading();
  if (!stateByRoute[route]) stateByRoute[route] = {};
  const ctx = {
    root,
    api,
    apiModule,
    ui,
    state: stateByRoute[route],
    me: getState().user,
    can,
    navigate,
    rerender: () => { if (token === renderToken) renderRoute(); },
    refreshMe: async () => { getState().user = await api.me(); renderShell(); navigate(route); renderRoute(); },
  };
  try {
    await view.render(ctx);
  } catch (error) {
    if (token !== renderToken) return;
    root.innerHTML = ui.errorCard(error);
  }
}

async function bootShell() {
  if (!getState().user) {
    getState().user = await api.me();
  }
  applyTheme(theme());
  renderShell();
  if (!location.hash || !VIEWS[(location.hash || '').replace(/^#\/?/, '').split('?')[0]]) {
    location.hash = `#/${can('console') ? 'overview' : 'projects'}`;
  }
  await renderRoute();
}

window.addEventListener('hashchange', renderRoute);
window.addEventListener('admin:session-expired', () => {
  if (!document.getElementById('login-form')) {
    ui.toast('登录已失效，请重新登录', 'warn');
    renderLogin('登录已失效，请重新登录');
  }
});

applyTheme(theme());
serverFromQuery();
restore().then((ok) => {
  if (ok) return bootShell();
  renderLogin();
}).catch((error) => renderLogin(error instanceof ApiError ? error.message : '无法连接服务'));
