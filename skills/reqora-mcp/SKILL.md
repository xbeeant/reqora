---
name: reqora-mcp
description: 通过 Reqora（驿）MCP 服务操作本机 API 工作台——检索接口与文档、查看/编写用例、运行接口与场景编排、生成测试报告。当用户提到 Reqora、驿、本地 API 工作台、接口用例、场景编排、跑一遍接口测试，或需要把接口调试/回归交给 AI 时使用。
---

# Reqora MCP 使用手册

Reqora 是本地优先的 API 工作台（桌面端 Tauri + 本地 SQLite）。它的 MCP 服务把
**接口管理、用例管理、自动执行、场景编排**暴露成工具，让 AI 直接读同一份项目数据、
跑同一条执行链路。

## 一、连接检查

1. 确认客户端配置里有 `reqora` 这个 MCP 服务（stdio）。
   - 配置入口：`reqora mcp --config` 会打印 Claude Desktop / Claude Code / Cursor / VS Code 的片段。
   - 需要 AI 修改数据时，启动参数必须有 `--allow-write`；没有它写入工具**不会出现在工具列表里**。
2. 第一次对话先调 `reqora_workspace_overview`，确认：项目名、数据路径、接口/用例/场景数量、
   是否允许写入、当前激活环境。
3. 若报「找不到工作区」：让用户确认桌面端已创建项目，或改用 `reqora_list_projects` 拿到
   项目 id 后用 `--workspace <id>` 指定。

## 二、工具速查（26 个）

**读**
- `reqora_workspace_overview` — 项目概览（第一步永远先调它）
- `reqora_list_projects` — 本机项目清单
- `reqora_list_requests` — 搜接口：`query` / `collection` / `protocol`
- `reqora_get_request` — 接口完整定义 + 文档 + 关联用例 + 引用它的场景
- `reqora_list_cases` / `reqora_get_case` — 用例列表 / 单条详情
- `reqora_list_scenarios` / `reqora_get_scenario` — 场景列表（含步骤概览）/ 完整编排
- `reqora_list_suites` — 套件成员与最近结果
- `reqora_list_environments` — 环境变量名（值默认打码）
- `reqora_list_runs` — 运行历史与趋势
- `reqora_get_evidence` — 读取 `reqora.run.v1` 证据文件
- `reqora_diff_runs` / `reqora_explain_failure` — 两次运行对比 / 失败归因

**跑**
- `reqora_send_request` — 临时发一次 HTTP（不必先建接口）
- `reqora_run_request` — 跑已保存接口（含脚本与断言）
- `reqora_run_cases` — 跑一条/多条用例，或某接口全部用例
- `reqora_run_scenario` — 跑场景编排（条件/循环/等待/提取/数据行）
- `reqora_run_suite` — 跑套件

**写（需 `--allow-write`）**
- `reqora_create_request` / `reqora_update_request` / `reqora_delete_request`
- `reqora_create_case` / `reqora_update_case`
- `reqora_create_scenario` / `reqora_update_scenario`

## 三、查找约定

- 所有 `ref` 参数都接受 **id / 完整名称 / 唯一子串**。
- 匹配到多个时会返回候选清单——这时改用 id，不要猜。
- 接口列表里 `cases: 0` 表示该接口还没有用例，是补用例的首选目标。

## 四、标准工作流

### 1. 摸清项目
```
reqora_workspace_overview
→ reqora_list_requests {limit: 200}
→ 对感兴趣的接口 reqora_get_request
```

### 2. 补用例（写）
```
reqora_get_request {ref}                       # 先看文档、参数、响应示例
reqora_create_case {requestRef, name, group:"正向", expectedStatus:200, overrides:{assertions:[...]}}
reqora_create_case {... group:"负向", expectedStatus:400}
reqora_run_cases {requestRef}                  # 立刻验证
```
断言结构：`{source: "status"|"json"|"header"|"text"|"latency", path, op, expected}`；
`op` 支持 `eq ne gt gte lt lte contains matches exists`。JSON 路径用 `$.data.id` 形式。

### 3. 串场景（写）
```
reqora_create_scenario {
  name: "下单链路",
  steps: [
    {caseRef: "正向 · 创建成功", extracts: [{varName: "orderId", source: "json", path: "$.id"}]},
    {caseRef: "查询订单", extracts: [{varName: "qStatus", source: "status", path: ""}]},  # 后续可用 {{orderId}} / {{qStatus}}
    {waitMs: 500},
    {caseRef: "取消订单", condition: {varName: "orderId", op: "exists", value: ""},
     repeat: {count: 2, indexVar: "i"}, continueOnFailure: true}
  ]
}
reqora_run_scenario {ref: "下单链路"}
```

### 4. 回归与诊断
```
reqora_run_suite {ref}            # 套件批量
reqora_run_cases {requestRef, group:"正向"}
```
失败时按顺序看：`error`（请求/脚本错误）→ `assertions`（哪条断言、期望 vs 实际）→
`steps[].extracted`（上一步提取了什么）→ `notes`（脚本告警）。

## 五、判定语义（别用自己的直觉替代）

- **用例**：声明了 `expectedStatus` 就按状态码判定；否则按 HTTP 成功 + 断言 + 脚本 `test()`。
- **场景步骤**：断言驱动——只要没有失败断言/脚本错误，状态码 500 也可能算「通过」。
  因此诊断时先看 `status` 再看 `ok`。
- **跳过**：`skipped: true` 不计失败；`condition` 不满足、步骤停用、步数上限都会导致跳过。
- **数据库步骤**：进程外无法执行，会明确报错「需要在桌面端执行」，不要重试。

## 六、安全与边界

1. 鉴权值、敏感响应头、环境变量值默认打码。**除非用户明确要求，不要传 `revealSecrets: true`**，
   也不要把打码值当作真实值回填到请求里。环境变量里勾选「私密」的项即使 `revealSecrets: true`
   也只返回打码值——这是用户显式设定的本机边界，不要试图绕过；请让用户在桌面端自行填写。
2. 写入前先说明要改什么；批量创建（>5 条）先列清单给用户确认。
3. 写入后提醒用户：桌面端若正打开同一项目，需要切项目或重启才能看到改动（内存快照会覆盖外部修改）。
4. 执行会真实打到目标服务——不要对生产环境随意跑负向/破坏性用例，先确认 `environment`。
5. 报告要给结论：通过/失败数量、失败步骤与断言、耗时；不要只贴原始 JSON。

## 七、常见错误对照

| 返回 | 处理 |
| --- | --- |
| `写入未开启` | 让用户在 MCP 配置里加 `--allow-write` 后重启客户端 |
| `找不到「X」` | 用 `reqora_list_requests` / `reqora_list_cases` 取准确 id |
| `缺少变量 {{baseUrl}}` | 传 `environment`，或用 `variables` 临时补 |
| `URL 无效` | 检查是否漏了 `http://`，或变量未解析 |
| `请求失败：ECONNREFUSED` | 目标服务没起；本地服务先启动再跑 |
