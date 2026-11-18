#!/usr/bin/env node
/**
 * End-to-end smoke test against a running server + real MySQL.
 * Usage: SMOKE_ADMIN_PASSWORD=... node scripts/smoke.mjs
 * Optional: BASE_URL (default http://127.0.0.1:8080), SMOKE_ADMIN_USERNAME (default admin).
 */
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8080";
const ADMIN = process.env.SMOKE_ADMIN_USERNAME ?? process.env.REQORA_ADMIN_USERNAME ?? "admin";
const PASSWORD = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.REQORA_ADMIN_PASSWORD;
if (!PASSWORD) {
  console.error("请设置 SMOKE_ADMIN_PASSWORD（或 REQORA_ADMIN_PASSWORD）");
  process.exit(2);
}

const suffix = Date.now().toString(36);
let checks = 0;

async function call(method, path, { token, body, expectCode = 0, expectStatus = 200 } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, expectStatus,
      `${method} ${path}: HTTP ${response.status} 期望 ${expectStatus} → ${JSON.stringify(payload)}`);
  assert.equal(payload.code, expectCode,
      `${method} ${path}: code ${payload.code} 期望 ${expectCode} → ${payload.message}`);
  checks++;
  return payload.data;
}

function ok(label) {
  console.log(`  ✓ ${label}`);
}

const run = async () => {
  console.log(`冒烟目标：${BASE}`);
  await call("GET", "/health");
  await call("GET", "/ready");
  ok("健康检查 /health /ready");

  // Unauthenticated request must be rejected with the normalized envelope.
  await call("GET", "/api/v1/projects", { expectCode: 1002, expectStatus: 401 });
  ok("未认证访问返回 1002/401");

  const adminTokens = await call("POST", "/api/v1/auth/login",
      { body: { username: ADMIN, password: PASSWORD } });
  const adminToken = adminTokens.accessToken;
  const me = await call("GET", "/api/v1/auth/me", { token: adminToken });
  assert.equal(me.username, ADMIN);
  assert.equal(me.superAdmin, true);
  ok("管理员登录与 /me");

  const refreshed = await call("POST", "/api/v1/auth/refresh",
      { body: { refreshToken: adminTokens.refreshToken } });
  assert.ok(refreshed.accessToken);
  await call("POST", "/api/v1/auth/refresh",
      { body: { refreshToken: adminTokens.refreshToken }, expectCode: 1008, expectStatus: 401 });
  ok("刷新令牌轮换与旧令牌失效");

  const aliceName = `alice_${suffix}`;
  const aliceTokens = await call("POST", "/api/v1/auth/register", {
    body: { username: aliceName, email: `${aliceName}@example.com`, password: "alice-pass-123" },
  });
  const aliceToken = aliceTokens.accessToken;
  ok("用户注册即登录");

  const users = await call("GET", "/api/v1/users?keyword=alice", { token: adminToken });
  assert.ok(users.total >= 1);
  const roles = await call("GET", "/api/v1/roles", { token: adminToken });
  assert.ok(roles.some((role) => role.code === "SUPER_ADMIN"));
  const permissions = await call("GET", "/api/v1/roles/permissions", { token: adminToken });
  assert.ok(permissions.length >= 8);
  ok("用户 / 角色 / 权限管理读取");

  await call("GET", "/api/v1/users", { token: aliceToken, expectCode: 1003, expectStatus: 403 });
  ok("普通用户访问系统管理接口被拒绝 (1003/403)");

  const project = await call("POST", "/api/v1/projects", {
    token: adminToken,
    body: { name: "冒烟项目", slug: `smoke-${suffix}`, description: "e2e" },
  });
  assert.equal(project.memberRole, "OWNER");
  const projectId = project.id;
  ok("创建项目自动成为 OWNER");

  const member = await call("POST", `/api/v1/projects/${projectId}/members`, {
    token: adminToken,
    body: { username: aliceName, role: "VIEWER" },
  });
  const aliceId = member.userId;
  const members = await call("GET", `/api/v1/projects/${projectId}/members`, { token: adminToken });
  assert.equal(members.length, 2);
  ok("添加成员与成员列表");

  // ---- 工作区行级同步（V4 统一行模型） ----
  const emptyRows = () => ({
    folders: [], requests: [], environments: [], cases: [],
    scenarios: [], suites: [], artifacts: [],
  });

  const firstSync = await call("POST", `/api/v1/projects/${projectId}/workspace/rows`, {
    token: adminToken,
    body: {
      ...emptyRows(),
      folders: [{ id: "c1", name: "示例集合", auth: null, position: 0, updatedAt: 100 }],
      requests: [{
        id: "r1", folderId: "c1", folderPath: "auth", name: "登录",
        method: "POST", url: "{{base}}/login", protocol: "http",
        position: 0, updatedAt: 111, data: { headers: [] },
      }],
    },
  });
  assert.equal(firstSync.version, 1);
  assert.equal(firstSync.folders.length, 1);
  assert.equal(firstSync.requests.length, 1);
  ok("工作区行级同步首次上传 v1");

  const pulled = await call("GET", `/api/v1/projects/${projectId}/workspace/rows`, { token: aliceToken });
  assert.equal(pulled.folders.length, 1);
  ok("VIEWER 可拉取行集");

  await call("POST", `/api/v1/projects/${projectId}/workspace/rows`, {
    token: aliceToken,
    body: emptyRows(),
    expectCode: 1003,
    expectStatus: 403,
  });
  ok("VIEWER 同步行被拒绝 (1003/403)");

  // 陈旧行（updatedAt 更小）不覆盖服务端已存的行——行级 last-writer-wins。
  await call("POST", `/api/v1/projects/${projectId}/workspace/rows`, {
    token: adminToken,
    body: {
      ...emptyRows(),
      requests: [{
        id: "r1", folderId: "c1", folderPath: "", name: "旧名",
        method: "GET", url: "", protocol: "http",
        position: 0, updatedAt: 50, data: {},
      }],
    },
  });
  const afterStale = await call("GET", `/api/v1/projects/${projectId}/workspace/rows`, { token: adminToken });
  const staleRow = afterStale.requests.find((row) => row.id === "r1");
  assert.equal(staleRow.name, "登录");
  ok("陈旧行不覆盖服务端（行级 last-writer-wins）");

  // 软删墓碑保留在行集中并传播删除。
  await call("POST", `/api/v1/projects/${projectId}/workspace/rows`, {
    token: adminToken,
    body: {
      ...emptyRows(),
      requests: [{
        id: "r1", folderId: "c1", folderPath: "", name: "登录",
        method: "POST", url: "", protocol: "http",
        position: 0, updatedAt: 2000, deleted: true, data: {},
      }],
    },
  });
  const afterDelete = await call("GET", `/api/v1/projects/${projectId}/workspace/rows`, { token: adminToken });
  assert.ok(afterDelete.requests.find((row) => row.id === "r1").deleted);
  ok("软删墓碑保留并传播删除");

  await call("PUT", `/api/v1/projects/${projectId}/members/${aliceId}/role`, {
    token: adminToken,
    body: { role: "EDITOR" },
  });
  const editorWrite = await call("POST", `/api/v1/projects/${projectId}/workspace/rows`, {
    token: aliceToken,
    body: {
      ...emptyRows(),
      environments: [{ id: "e1", name: "测试", position: 0, updatedAt: 300, data: { variables: [] } }],
    },
  });
  assert.equal(editorWrite.version, 4); // v1 首传、v2 陈旧、v3 墓碑、v4 环境
  ok("成员角色升级为 EDITOR 后可同步行");

  await call("POST", `/api/v1/projects/${projectId}/members/transfer-owner`, {
    token: aliceToken,
    body: { userId: me.id },
    expectCode: 1003,
    expectStatus: 403,
  });
  ok("非 OWNER 转让被拒绝");

  // ---- 组织与邀请（P1-5） ----
  const org = await call("POST", "/api/v1/orgs", {
    token: adminToken,
    body: { name: "冒烟组织", slug: `smoke-org-${Date.now()}`, description: "" },
  });
  assert.equal(org.memberRole, "OWNER");
  ok("创建组织，创建者自动成为 OWNER");

  const myOrgs = await call("GET", "/api/v1/orgs", { token: adminToken });
  assert.ok(myOrgs.some((item) => item.id === org.id));
  const orgMembers = await call("GET", `/api/v1/orgs/${org.id}/members`, { token: adminToken });
  assert.equal(orgMembers.length, 1);
  ok("我的组织列表与成员列表");

  const invite = await call("POST", `/api/v1/orgs/${org.id}/invitations`, {
    token: adminToken,
    body: { role: "MEMBER", maxUses: 2, expiresInHours: 24, label: "smoke" },
  });
  assert.ok(invite.token.length >= 32);
  const inviteRows = await call("GET", `/api/v1/orgs/${org.id}/invitations`, { token: adminToken });
  assert.equal(inviteRows.length, 1);
  assert.equal(inviteRows[0].token, undefined);
  ok("生成邀请链接，列表不泄露原始令牌");

  const accepted = await call("POST", `/api/v1/invitations/${invite.token}/accept`, {
    token: aliceToken, body: {},
  });
  assert.equal(accepted.orgId, org.id);
  assert.equal(accepted.role, "MEMBER");
  await call("POST", `/api/v1/invitations/${invite.token}/accept`, {
    token: aliceToken, body: {}, expectCode: 1005, expectStatus: 409,
  });
  ok("成员通过邀请加入，重复加入被拒绝");

  const orgProject = await call("POST", "/api/v1/projects", {
    token: adminToken,
    body: {
      name: "组织项目",
      slug: `smoke-org-project-${Date.now()}`,
      description: "",
      orgId: org.id,
    },
  });
  assert.equal(orgProject.orgId, org.id);
  const orgProjectList = await call("GET", "/api/v1/projects", { token: aliceToken });
  assert.ok(orgProjectList.records.some((item) => item.id === orgProject.id));
  await call("GET", `/api/v1/projects/${orgProject.id}/workspace/head`, { token: aliceToken });
  await call("POST", `/api/v1/projects/${orgProject.id}/workspace/rows`, {
    token: aliceToken,
    body: emptyRows(),
    expectCode: 1003, expectStatus: 403,
  });
  ok("组织项目对成员可见且只读（普通成员同步行被拒绝）");

  await call("DELETE", `/api/v1/orgs/${org.id}/invitations/${invite.invite.id}`, { token: adminToken });
  await call("POST", `/api/v1/invitations/${invite.token}/accept`, {
    token: adminToken, body: {}, expectCode: 1008, expectStatus: 401,
  });
  ok("撤销邀请后令牌立即失效");

  await call("POST", `/api/v1/orgs/${org.id}/leave`, { token: aliceToken, body: {} });
  await call("DELETE", `/api/v1/projects/${orgProject.id}`, { token: adminToken });
  ok("成员退出组织，组织项目清理完成");

  const logs = await call("GET", "/api/v1/audit/logs", { token: adminToken });
  assert.ok(logs.total >= 5);
  ok("审计日志可查询");

  // ---- 文档站分享：公开读取无需认证，管理端点要求项目权限 ----
  const docPayload = {
    version: 1,
    title: "冒烟文档",
    generatedAt: new Date().toISOString(),
    chapters: [{
      id: "c1", slug: "auth", title: "接口鉴权", group: "guide", groupLabel: "指南",
      body: "## 认证方式", errorCodes: { columns: [], rows: [] },
    }],
    collections: [{ id: "col1", name: "示例集合", requests: [] }],
    totalRequests: 0,
  };
  const published = await call("POST", `/api/v1/projects/${projectId}/doc-sites`, {
    token: adminToken, body: { payload: docPayload, title: "冒烟文档" },
  });
  assert.ok(published.token.length >= 32);
  const publicDoc = await call("GET", `/api/v1/doc-sites/${encodeURIComponent(published.token)}`);
  assert.equal(publicDoc.title, "冒烟文档");
  assert.equal(publicDoc.chapters.length, 1);
  const shareList = await call("GET", `/api/v1/projects/${projectId}/doc-sites`, { token: adminToken });
  assert.equal(shareList.length, 1);
  assert.equal(shareList[0].token, undefined);
  ok("创建文档分享并匿名公开读取（不带 Authorization）");

  await call("POST", `/api/v1/projects/${projectId}/doc-sites`, {
    token: aliceToken, body: { payload: docPayload }, expectCode: 1003, expectStatus: 403,
  });
  ok("无项目写权限的用户不能发布文档分享");

  const rotated = await call("POST", `/api/v1/projects/${projectId}/doc-sites/${published.share.id}/token`, {
    token: adminToken, body: {},
  });
  assert.notEqual(rotated.token, published.token);
  await call("GET", `/api/v1/doc-sites/${encodeURIComponent(published.token)}`, {
    expectCode: 1004, expectStatus: 404,
  });
  const rotatedDoc = await call("GET", `/api/v1/doc-sites/${encodeURIComponent(rotated.token)}`);
  assert.equal(rotatedDoc.title, "冒烟文档");
  ok("轮换令牌后旧链接立即失效，新链接可用");

  await call("PUT", `/api/v1/projects/${projectId}/doc-sites/${published.share.id}`, {
    token: adminToken,
    body: { payload: { ...docPayload, title: "更新后的文档" }, title: "更新后的文档" },
  });
  const updatedDoc = await call("GET", `/api/v1/doc-sites/${encodeURIComponent(rotated.token)}`);
  assert.equal(updatedDoc.title, "更新后的文档");
  ok("重新发布内容保持原链接不变");

  await call("DELETE", `/api/v1/projects/${projectId}/doc-sites/${published.share.id}`, { token: adminToken });
  await call("GET", `/api/v1/doc-sites/${encodeURIComponent(rotated.token)}`, {
    expectCode: 1004, expectStatus: 404,
  });
  ok("撤销分享后公开链接立即失效");

  await call("POST", `/api/v1/projects/${projectId}/doc-sites`, {
    token: adminToken, body: { payload: { collections: "bad" } },
    expectCode: 1001, expectStatus: 400,
  });
  ok("非法 payload 被拒绝");

  await call("DELETE", `/api/v1/projects/${projectId}`, { token: adminToken });
  await call("GET", `/api/v1/projects/${projectId}`, {
    token: adminToken, expectCode: 1004, expectStatus: 404,
  });
  ok("删除项目级联清理，后续访问 404");

  console.log(`\n全部通过：${checks} 个 HTTP 断言`);
};

run().catch((error) => {
  console.error("\n冒烟失败：", error.message);
  process.exit(1);
});
