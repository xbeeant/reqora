// Read-only smoke checks for the self-hosted admin console API.
// Usage: set -a; source server/.env; set +a; node server/scripts/smoke-admin.mjs
// Requires a running backend + MySQL. Never creates or mutates data.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function loadDotEnv() {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}
loadDotEnv();

const port = process.env.REQORA_SERVER_PORT || '18080';
const base = (process.env.REQORA_SMOKE_BASE || `http://127.0.0.1:${port}`).replace(/\/+$/, '');
const username = process.env.REQORA_ADMIN_USERNAME || 'admin';
const password = process.env.REQORA_ADMIN_PASSWORD;
assert.ok(password, '缺少 REQORA_ADMIN_PASSWORD（请 source server/.env）');

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ✓ ${label}`); };

async function call(method, urlPath, { token, body } = {}) {
  const response = await fetch(`${base}${urlPath}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => null);
  assert.ok(response.ok, `${method} ${urlPath} -> HTTP ${response.status}: ${payload?.message || ''}`);
  assert.equal(payload?.code, 0, `${method} ${urlPath} -> code ${payload?.code}: ${payload?.message}`);
  return payload.data;
}

function assertPage(data, label) {
  assert.ok(Array.isArray(data?.records), `${label} 缺少 records`);
  assert.equal(typeof data?.total, 'number', `${label} 缺少 total`);
  ok(label);
}

console.log(`管理端只读冒烟：${base}`);

const health = await call('GET', '/health');
assert.equal(health.status, 'ok');
ok('/health');

const tokens = await call('POST', '/api/v1/auth/login', { body: { username, password } });
assert.ok(tokens.accessToken && tokens.refreshToken, '登录未返回令牌对');
ok('管理员登录');

const token = tokens.accessToken;
const me = await call('GET', '/api/v1/auth/me', { token });
assert.ok(me.superAdmin || (me.permissions || []).length > 0, '账号没有任何管理权限');
ok('/auth/me 具备管理权限');

const overview = await call('GET', '/api/v1/admin/overview', { token });
for (const key of ['users', 'roles', 'permissions', 'projects', 'organizations', 'auditTotal', 'recentLogs']) {
  assert.ok(overview[key] !== undefined, `overview 缺少 ${key}`);
}
assert.ok(Array.isArray(overview.recentLogs));
ok('/admin/overview 聚合统计');

const permissions = await call('GET', '/api/v1/roles/permissions', { token });
assert.ok(Array.isArray(permissions) && permissions.length >= 10, '权限点数量不足（V6 应新增 2 项）');
for (const permission of permissions) {
  assert.equal(typeof permission.description, 'string', `权限点 ${permission.code} 缺少 description`);
}
ok(`/roles/permissions 共 ${permissions.length} 项，均带说明`);

const orgCodes = permissions.filter((p) => p.code.startsWith('system:org:')).map((p) => p.code);
assert.deepEqual(orgCodes.sort(), ['system:org:read', 'system:org:write']);
ok('V6 组织权限点已生效');

const roles = await call('GET', '/api/v1/roles', { token });
assert.ok(Array.isArray(roles) && roles.some((r) => r.code === 'SUPER_ADMIN'));
ok('/roles 内置角色存在');

const orgs = await call('GET', '/api/v1/admin/orgs', { token });
assert.ok(Array.isArray(orgs), '/admin/orgs 应返回数组');
for (const org of orgs) {
  assert.equal(typeof org.memberCount, 'number');
  assert.equal(typeof org.projectCount, 'number');
}
ok(`/admin/orgs 共 ${orgs.length} 个组织`);

const actions = await call('GET', '/api/v1/audit/actions', { token });
assert.ok(Array.isArray(actions), '/audit/actions 应返回数组');
ok(`/audit/actions 共 ${actions.length} 种操作类型`);

assertPage(await call('GET', '/api/v1/audit/logs?page=1&size=5&keyword=', { token }), '/audit/logs 分页');
assertPage(await call('GET', '/api/v1/users?page=1&size=5', { token }), '/users 分页');
assertPage(await call('GET', '/api/v1/projects?page=1&size=5', { token }), '/projects 分页');

if (orgs.length) {
  const members = await call('GET', `/api/v1/admin/orgs/${orgs[0].id}/members`, { token });
  assert.ok(Array.isArray(members), '组织成员应返回数组');
  ok(`/admin/orgs/{id}/members 共 ${members.length} 人`);
}

console.log(`\n管理端冒烟通过：${checks} 项断言`);
