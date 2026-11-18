// Tiny REST client for the self-hosted console. The page itself is public;
// every /api/v1 call carries a Bearer token and honours the unified ApiResponse.

const SERVER_KEY = 'reqora.admin.server.v1';
const SESSION_KEY = 'reqora.admin.session.v1';
const REMEMBER_KEY = 'reqora.admin.remember.v1';

export class ApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

const state = {
  server: localStorage.getItem(SERVER_KEY) || location.origin,
  access: '',
  refresh: '',
  user: null,
};

function readSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.access ? parsed : null;
  } catch {
    return null;
  }
}

function writeSession(session, remember) {
  const raw = session ? JSON.stringify(session) : '';
  if (session) {
    if (remember) {
      localStorage.setItem(SESSION_KEY, raw);
      sessionStorage.removeItem(SESSION_KEY);
    } else {
      sessionStorage.setItem(SESSION_KEY, raw);
      localStorage.removeItem(SESSION_KEY);
    }
    localStorage.setItem(REMEMBER_KEY, remember ? '1' : '0');
  } else {
    localStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_KEY);
  }
  state.access = session?.access || '';
  state.refresh = session?.refresh || '';
}

export function getState() {
  return state;
}

export function setServer(url) {
  const clean = String(url || '').trim().replace(/\/+$/, '') || location.origin;
  state.server = clean;
  localStorage.setItem(SERVER_KEY, clean);
  return clean;
}

export function serverFromQuery() {
  const value = new URLSearchParams(location.search).get('server');
  if (value) setServer(value);
  return state.server;
}

async function raw(path, options) {
  let response;
  try {
    response = await fetch(`${state.server}${path}`, {
      ...options,
      headers: { ...(options.headers || {}) },
    });
  } catch {
    throw new ApiError('无法连接服务，请检查服务地址与网络', -1, 0);
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || (payload && payload.code !== 0)) {
    throw new ApiError(
      payload?.message || `请求失败（HTTP ${response.status}）`,
      payload?.code ?? response.status,
      response.status,
    );
  }
  return payload?.data ?? null;
}

export async function request(method, path, body, { retry = true } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';
  if (state.access) headers.Authorization = `Bearer ${state.access}`;
  try {
    return await raw(path, {
      method,
      headers,
      body: body === undefined || body === null ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    const authEndpoint = ['/auth/login', '/auth/register', '/auth/refresh']
      .some((fragment) => path.includes(fragment));
    if (retry && error.status === 401 && state.refresh && !authEndpoint) {
      const renewed = await tryRefresh();
      if (renewed) return request(method, path, body, { retry: false });
    }
    // Only an active shell should be bounced to the login screen; restore()
    // runs before the shell exists and handles its own failure path.
    if (error.status === 401 && document.querySelector('.shell')) {
      window.dispatchEvent(new CustomEvent('admin:session-expired'));
    }
    throw error;
  }
}

async function tryRefresh() {
  try {
    const data = await raw('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ refreshToken: state.refresh }),
    });
    const session = {
      access: data.accessToken || data.access,
      refresh: data.refreshToken || data.refresh,
    };
    if (!session.access || !session.refresh) return false;
    writeSession(session, localStorage.getItem(REMEMBER_KEY) === '1');
    return true;
  } catch {
    return false;
  }
}

export async function login({ server, username, password, remember }) {
  if (server) setServer(server);
  const data = await raw('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const session = {
    access: data.accessToken || data.access,
    refresh: data.refreshToken || data.refresh,
  };
  if (!session.access) throw new ApiError('登录响应缺少访问令牌', -1, 0);
  writeSession(session, remember);
  state.user = await request('GET', '/api/v1/auth/me');
  return state.user;
}

export async function logout() {
  try {
    if (state.refresh) {
      await request('POST', '/api/v1/auth/logout', { refreshToken: state.refresh }, { retry: false });
    }
  } catch {
    // Local sign-out must succeed even when the server is offline.
  }
  writeSession(null, false);
  state.user = null;
}

export async function restore() {
  const session = readSession();
  if (!session) return false;
  writeSession(session, localStorage.getItem(REMEMBER_KEY) === '1');
  try {
    state.user = await request('GET', '/api/v1/auth/me');
    return true;
  } catch {
    writeSession(null, false);
    state.user = null;
    return false;
  }
}

// ---- Domain helpers -------------------------------------------------------

export const api = {
  me: () => request('GET', '/api/v1/auth/me'),
  overview: () => request('GET', '/api/v1/admin/overview'),

  users: (page, size, keyword) =>
    request('GET', `/api/v1/users?page=${page}&size=${size}${keyword ? `&keyword=${encodeURIComponent(keyword)}` : ''}`),
  user: (id) => request('GET', `/api/v1/users/${id}`),
  createUser: (body) => request('POST', '/api/v1/users', body),
  setUserStatus: (id, enabled) => request('PUT', `/api/v1/users/${id}/status`, { enabled }),
  setUserRoles: (id, roles) => request('PUT', `/api/v1/users/${id}/roles`, { roles }),
  resetUserPassword: (id, password) => request('PUT', `/api/v1/users/${id}/password`, { password }),
  deleteUser: (id) => request('DELETE', `/api/v1/users/${id}`),

  roles: () => request('GET', '/api/v1/roles'),
  permissions: () => request('GET', '/api/v1/roles/permissions'),
  createRole: (body) => request('POST', '/api/v1/roles', body),
  updateRole: (id, body) => request('PUT', `/api/v1/roles/${id}`, body),
  deleteRole: (id) => request('DELETE', `/api/v1/roles/${id}`),
  setRolePermissions: (id, permissions) =>
    request('PUT', `/api/v1/roles/${id}/permissions`, { permissions }),
  batchGrant: (body) => request('POST', '/api/v1/admin/grants/batch', body),

  projects: (page, size, keyword) =>
    request('GET', `/api/v1/projects?page=${page}&size=${size}${keyword ? `&keyword=${encodeURIComponent(keyword)}` : ''}`),
  createProject: (body) => request('POST', '/api/v1/projects', body),
  updateProject: (id, body) => request('PUT', `/api/v1/projects/${id}`, body),
  archiveProject: (id, archived) =>
    request('PUT', `/api/v1/projects/${id}/archive?archived=${archived}`),
  deleteProject: (id) => request('DELETE', `/api/v1/projects/${id}`),

  members: (projectId) => request('GET', `/api/v1/projects/${projectId}/members`),
  addMember: (projectId, body) => request('POST', `/api/v1/projects/${projectId}/members`, body),
  setMemberRole: (projectId, userId, role) =>
    request('PUT', `/api/v1/projects/${projectId}/members/${userId}/role`, { role }),
  removeMember: (projectId, userId) =>
    request('DELETE', `/api/v1/projects/${projectId}/members/${userId}`),
  transferOwner: (projectId, userId) =>
    request('POST', `/api/v1/projects/${projectId}/members/transfer-owner`, { userId }),

  adminOrgs: () => request('GET', '/api/v1/admin/orgs'),
  myOrgs: () => request('GET', '/api/v1/orgs'),
  createOrg: (body) => request('POST', '/api/v1/orgs', body),
  adminOrgMembers: (orgId) => request('GET', `/api/v1/admin/orgs/${orgId}/members`),
  orgMembers: (orgId) => request('GET', `/api/v1/orgs/${orgId}/members`),
  addOrgMember: (orgId, body) => request('POST', `/api/v1/admin/orgs/${orgId}/members`, body),
  setOrgMemberRole: (orgId, userId, role) =>
    request('PUT', `/api/v1/admin/orgs/${orgId}/members/${userId}/role`, { role }),
  removeOrgMember: (orgId, userId) =>
    request('DELETE', `/api/v1/admin/orgs/${orgId}/members/${userId}`),
  invites: (orgId) => request('GET', `/api/v1/orgs/${orgId}/invitations`),
  createInvite: (orgId, body) => request('POST', `/api/v1/orgs/${orgId}/invitations`, body),
  revokeInvite: (orgId, id) => request('DELETE', `/api/v1/orgs/${orgId}/invitations/${id}`),

  auditLogs: (page, size, keyword, action) =>
    request('GET', `/api/v1/audit/logs?page=${page}&size=${size}`
      + `${keyword ? `&keyword=${encodeURIComponent(keyword)}` : ''}`
      + `${action ? `&action=${encodeURIComponent(action)}` : ''}`),
  auditActions: () => request('GET', '/api/v1/audit/actions'),

  changePassword: (oldPassword, newPassword) =>
    request('POST', '/api/v1/users/me/password', { oldPassword, newPassword }),

  adminDocSites: (page, size, projectId, status, keyword) => {
    const params = new URLSearchParams({ page: String(page), size: String(size) });
    if (projectId != null) params.set('projectId', String(projectId));
    if (status) params.set('status', status);
    if (keyword) params.set('keyword', keyword);
    return request('GET', `/api/v1/admin/doc-sites?${params.toString()}`);
  },

  revokeDocSite: (shareId, projectId) =>
    request('DELETE', `/api/v1/projects/${projectId}/doc-sites/${shareId}`),
};
