/** Response viewer / console / JSON tree / SSE / binary body strings. */

export const zh = {
  // common
  "response.common.copy": "复制",
  "response.common.copied": "已复制",
  "response.common.refresh": "刷新",
  "response.common.clear": "清空",
  "response.common.loading": "加载中…",
  "response.common.retry": "重试",
  "response.common.cancel": "取消",
  "response.download.saved": "已下载：{name} · {size}",
  "response.download.failed": "响应文件保存失败",
  "response.download.dismiss": "关闭提示",

  // cookies
  "response.cookies.setCookieTitle": "本次响应 Set-Cookie",
  "response.cookies.none": "响应未设置 Cookie",
  "response.cookies.jarTitle": "共享 Cookie Jar（跨请求自动携带）",
  "response.cookies.jarEmpty": "Jar 为空",
  "response.cookies.jarHint":
    "发送一个会返回 Set-Cookie 的请求后，Cookie 会出现在这里并随后续同域请求自动携带（可在设置中关闭）。",
  "response.cookies.session": "会话",

  // image preview
  "response.image.sniffed": "按文件签名识别（Content-Type 未声明图片）",
  "response.image.truncated": "响应体已截断，预览可能不完整",
  "response.image.resetZoom": "重置缩放",
  "response.image.copyBase64": "复制 base64",
  "response.image.alt": "响应体图片预览",

  // timing
  "response.timing.none.title": "该响应没有阶段耗时",
  "response.timing.none.desc":
    "这条响应没有阶段打点，只有总耗时 {total}（例如历史记录或旧版本生成的响应）。重新发送一次即可查看 DNS、连接、首字节与传输拆解。",
  "response.timing.total": "总耗时",
  "response.timing.ttfb": "首字节",
  "response.timing.protocol": "协议",
  "response.timing.connection": "连接",
  "response.timing.reused": "复用",
  "response.timing.new": "新建",
  "response.timing.chartAria": "请求各阶段耗时瀑布图",
  "response.timing.col.phase": "阶段",
  "response.timing.col.duration": "耗时",
  "response.timing.col.percent": "占比",
  "response.timing.col.note": "说明",
  "response.timing.reuseNote": "本次未发生新的 DNS 解析或连接建立。",
  "response.timing.note":
    "DNS 与连接阶段由 reqwest 的解析器 / 连接器真实打点；「服务器处理」为首字节时间扣除本地连接开销，「传输」为响应体读取耗时。HTTPS 下 TCP 与 TLS 握手在同一个连接器调用中完成，reqwest 不暴露单独的 TLS 检查点，因此两者合并展示、不给出估算数字。",
  "response.timing.jump": "查看耗时拆解",

  // raw view
  "response.raw.request": "请求",
  "response.raw.response": "响应",
  "response.raw.note": "按实际发送 / 接收内容原样重建 · HTTP/2 与自动解压下与线上字节不完全一致",
  "response.raw.copy": "复制报文",
  "response.raw.none.title": "该响应没有原始报文",
  "response.raw.none.desc":
    "这条响应没有附带原始报文（例如历史记录或旧版本生成的响应）。重新发送一次即可查看请求与响应的完整报文。",

  // tabs & header
  "response.tab.sse": "SSE / 时间线",
  "response.tab.timing": "耗时",
  "response.tab.raw": "原始报文",
  "response.tab.validate": "校验",
  "response.tab.code": "代码",
  "response.tabsAria": "响应详情",
  "response.sse.streaming": "流式接收中",
  "response.sse.ended": "流式结束",
  "response.sse.summary": "{events} 个事件 · {chars} 字",
  "response.missingVars": "未定义的变量（已按原样发送）：",
  "response.truncatedBanner":
    "完整响应体已落盘，按滚动位置分块加载（共 {size}{decoded}；内联仅含前 {inline} 预览）。",
  "response.truncatedDecoded": " · 已解码 {encoding}",
  "response.sending": "正在发送请求…",

  // code tab
  "response.code.badge": "可复制的请求代码",
  "response.code.selectAria": "代码语言或模板",
  "response.code.builtin": "内置 · {label}",
  "response.code.divider": "── 自定义模板 ──",
  "response.code.manageTitle": "新建 / 编辑 / 删除自定义模板",
  "response.code.manage": "管理模板",
  "response.code.warn": "变量已按当前环境展开，鉴权值也会显示，请勿外发",
  "response.code.unknownVars": "模板中有未识别的变量：",
  "response.code.empty": "（模板内容为空，点「管理模板」编辑）",
  "response.code.reset": "还原生成结果",

  // empty state
  "response.empty.error.title": "请求未成功",
  "response.empty.title": "还没有响应",
  "response.empty.error.desc": "查看上方错误信息，修正后重新发送。",
  "response.empty.desc": "填写 URL 点击「发送」，响应体、状态码、脚本日志与断言结果会出现在这里。",

  // tests
  "response.tests.empty.title": "还没有测试结果",
  "response.tests.empty.desc": "在「Tests / 后置脚本」里用 test() 写命名测试，或在「Assertions」里添加声明式断言。",
  "response.tests.script": "脚本",
  "response.tests.assertion": "断言",

  // logs
  "response.logs.count": "{count} 条日志",
  "response.logs.duration": "脚本耗时 {ms} ms",
  "response.logs.mutations": "变更：{list}",
  "response.logs.preError": "前置脚本：{message}",
  "response.logs.postError": "后置脚本：{message}",
  "response.logs.empty.title": "没有脚本日志",
  "response.logs.empty.desc": "在 pre/post 脚本里调用 log() 后，输出会显示在这里。",

  // assertions
  "response.assertions.empty.title": "没有声明式断言",
  "response.assertions.empty.desc": "在请求配置区「Assertions」添加规则后重新发送。",
  "response.assertions.passed": "{passed} / {total} 通过",
  "response.assertions.actual": "实际值：",

  // validate
  "response.validate.noDocs.title": "接口文档未定义响应示例",
  "response.validate.noDocs.desc":
    "在请求配置区「文档」标签添加响应示例（状态码 + JSON body）后，每次响应会自动校验状态码、Content-Type 与 JSON 结构是否符合文档。",
  "response.validate.pass.title": "响应符合文档定义（状态码 / Content-Type / JSON 结构）",
  "response.validate.pass.desc":
    "状态码 {status} 命中文档示例 · Content-Type 家族一致 · JSON 字段结构与示例匹配（多余字段已忽略）",
  "response.validate.summary": "{total} 项差异 · {errors} 错误 / {warnings} 警告",
  "response.validate.note": "校验不阻断请求，仅提示与文档的偏差",

  // body
  "response.body.empty.title": "响应体为空",
  "response.body.empty.desc": "服务器返回 {status}，但没有响应内容。",
  "response.body.truncatedNotice":
    "响应体较大，已启用分块加载与虚拟滚动；格式化 / JSON 树仅解析内联预览，完整内容请用 Text 视图。",
  "response.body.viewFullText": "查看完整文本",

  // jsonpath
  "response.jsonpath.placeholder": "JSONPath 过滤，例如 $.items[?(@.id > 2)].name",
  "response.jsonpath.aria": "JSONPath 过滤表达式",
  "response.jsonpath.clear": "清除",
  "response.jsonpath.browse": "树形浏览",
  "response.jsonpath.matches": "匹配 {count}{plus} 项",
  "response.jsonpath.onlyMatches": "仅命中",
  "response.jsonpath.collapse": "收起",
  "response.jsonpath.expandAll": "展开全部",
  "response.jsonpath.copyTitle": "点击复制 JSONPath",
  "response.jsonpath.more": "仅列出前 50 项，共 {total}{plus} 项",

  // json tree
  "response.tree.copyPath": "复制 JSONPath：{path}",
  "response.tree.collapse": "折叠",
  "response.tree.expand": "展开",
  "response.tree.items": "{count} 项",

  // console
  "response.console.aria": "控制台",
  "response.console.title": "控制台",
  "response.console.all": "全部",
  "response.console.autoScroll": "自动滚动",
  "response.console.clear": "清空控制台",
  "response.console.collapse": "收起控制台",
  "response.console.close": "关闭",
  "response.console.empty": "暂无日志。发送请求、连接 WebSocket、启动 Mock 或导入数据后，事件会实时显示在这里。",
  "response.console.source.http": "网络",
  "response.console.source.ws": "WS",
  "response.console.source.mqtt": "MQTT",
  "response.console.source.soap": "SOAP",
  "response.console.source.grpc": "gRPC",
  "response.console.source.mock": "Mock",
  "response.console.source.script": "脚本",
  "response.console.source.scenario": "场景",
  "response.console.source.import": "数据",

  // sse viewer
  "response.sse.error": "连接异常",
  "response.sse.stopped": "已停止",
  "response.sse.done": "已完成",
  "response.sse.events": "{count} 个事件",
  "response.sse.chars": "{count} 字",
  "response.sse.truncated": "已达上限，内容被截断",
  "response.sse.tab.timeline": "时间线",
  "response.sse.tab.raw": "原始事件",
  "response.sse.tab.settings": "合并规则",
  "response.sse.empty.title": "还没有 SSE 事件流",
  "response.sse.empty.intro": "当响应的 Content-Type 是",
  "response.sse.empty.mid": "时，这里会自动把事件片段",
  "response.sse.empty.merge": "提前拼接",
  "response.sse.empty.outro": "成可读文本，并展示时间线。可在请求「Settings」里把流式模式设为「强制开启」。",
  "response.sse.empty.example": "node examples/sse-server.mjs → 发送示例集合里的「SSE 流式示例」",
  "response.sse.reasoning": "思考过程 · {count} 字",
  "response.sse.mergedTitle": "合并后的响应内容",
  "response.sse.autoHint": "自动识别格式，逐帧拼接",
  "response.sse.offHint": "当前为「分条展示」，没有生成合并文本。切到「时间线」查看每条事件，或在「合并规则」中改回自动合并。",
  "response.sse.waiting": "等待第一个可合并的事件片段…",
  "response.sse.noText": "没有从事件中识别出文本片段。若响应是自定义 JSON 格式，请在「合并规则」里配置 JSONPath。",
  "response.sse.filterPlaceholder": "过滤事件 / data…",
  "response.sse.filterAria": "过滤 SSE 事件",
  "response.sse.waitingEvents": "等待事件…",
  "response.sse.noMatch": "没有匹配的事件",
  "response.sse.noData": "(无 data)",
  "response.sse.snippetTitle": "提取出的片段",
  "response.sse.rawTitle": "按到达顺序拼接的原始事件流",
  "response.sse.mergeMode": "合并方式",
  "response.sse.mode.auto.label": "自动合并",
  "response.sse.mode.auto.hint": "自动识别 OpenAI / Gemini / Claude / 纯文本格式",
  "response.sse.mode.jsonPath.label": "自定义 JSONPath",
  "response.sse.mode.jsonPath.hint": "从每个事件的 JSON 中按路径提取片段",
  "response.sse.mode.rawText.label": "原样拼接 data",
  "response.sse.mode.rawText.hint": "把每条 data 字段直接首尾相接",
  "response.sse.mode.off.label": "分条展示",
  "response.sse.mode.off.hint": "不拼接，只看事件时间线",
  "response.sse.textPath": "文本片段路径",
  "response.sse.textPathAria": "文本片段 JSONPath",
  "response.sse.reasoningPath": "思考过程路径（可选）",
  "response.sse.reasoningPathAria": "思考过程 JSONPath",
  "response.sse.ruleHint.a": "修改规则会立刻用",
  "response.sse.ruleHint.b": "已经收到的事件",
  "response.sse.ruleHint.c": "重新拼接，不需要重发请求。当前已识别格式：",
  "response.sse.ruleHint.d": "；合并结果 {merged} 字，思考过程 {reasoning} 字。",

  // binary editor
  "response.binary.removeFile": "移除文件",
  "response.binary.pick": "选择文件",
  "response.binary.hint": "文件以 base64 经 IPC 传给 Rust，作为原始请求体发送；如未填写 Content-Type 则默认",
  "response.binary.hintEnd": "。",
};

export const en = {
  // common
  "response.common.copy": "Copy",
  "response.common.copied": "Copied",
  "response.common.refresh": "Refresh",
  "response.common.clear": "Clear",
  "response.common.loading": "Loading…",
  "response.common.retry": "Retry",
  "response.common.cancel": "Cancel",
  "response.download.saved": "Downloaded: {name} · {size}",
  "response.download.failed": "Could not save the response file",
  "response.download.dismiss": "Dismiss",

  // cookies
  "response.cookies.setCookieTitle": "Set-Cookie in this response",
  "response.cookies.none": "No cookies set in this response",
  "response.cookies.jarTitle": "Shared cookie jar (carried automatically across requests)",
  "response.cookies.jarEmpty": "Jar is empty",
  "response.cookies.jarHint":
    "Send a request that returns Set-Cookie and the cookies will appear here, carried automatically for later same-domain requests (can be turned off in settings).",
  "response.cookies.session": "Session",

  // image preview
  "response.image.sniffed": "Detected by file signature (Content-Type did not declare an image)",
  "response.image.truncated": "Body truncated; preview may be incomplete",
  "response.image.resetZoom": "Reset zoom",
  "response.image.copyBase64": "Copy base64",
  "response.image.alt": "Response body image preview",

  // timing
  "response.timing.none.title": "No phase timings for this response",
  "response.timing.none.desc":
    "This response has no phase checkpoints, only a total time of {total} (e.g. a response from history or an older version). Resend once to see the DNS, connection, first-byte and transfer breakdown.",
  "response.timing.total": "Total",
  "response.timing.ttfb": "First byte",
  "response.timing.protocol": "Protocol",
  "response.timing.connection": "Connection",
  "response.timing.reused": "Reused",
  "response.timing.new": "New",
  "response.timing.chartAria": "Waterfall of request phase timings",
  "response.timing.col.phase": "Phase",
  "response.timing.col.duration": "Duration",
  "response.timing.col.percent": "Share",
  "response.timing.col.note": "Notes",
  "response.timing.reuseNote": "No new DNS resolution or connection was made this time.",
  "response.timing.note":
    "The DNS and connection phases are real checkpoints from reqwest's resolver / connector; \"server processing\" is first-byte time minus local connection overhead, and \"transfer\" is the time spent reading the body. Over HTTPS the TCP and TLS handshakes complete within a single connector call, and reqwest does not expose a separate TLS checkpoint, so the two are shown merged with no estimated figures.",
  "response.timing.jump": "View timing breakdown",

  // raw view
  "response.raw.request": "Request",
  "response.raw.response": "Response",
  "response.raw.note":
    "Rebuilt verbatim from what was sent / received · not byte-identical on the wire under HTTP/2 and automatic decompression",
  "response.raw.copy": "Copy message",
  "response.raw.none.title": "No raw message for this response",
  "response.raw.none.desc":
    "This response has no raw message attached (e.g. a response from history or an older version). Resend once to view the full request and response messages.",

  // tabs & header
  "response.tab.sse": "SSE / Timeline",
  "response.tab.timing": "Timing",
  "response.tab.raw": "Raw",
  "response.tab.validate": "Validate",
  "response.tab.code": "Code",
  "response.tabsAria": "Response details",
  "response.sse.streaming": "Streaming",
  "response.sse.ended": "Stream ended",
  "response.sse.summary": "{events} events · {chars} chars",
  "response.missingVars": "Undefined variables (sent as-is):",
  "response.truncatedBanner":
    "The full body is stored on disk and loaded in chunks as you scroll ({size}{decoded}; only the first {inline} is inlined as a preview).",
  "response.truncatedDecoded": " · decoded from {encoding}",
  "response.sending": "Sending request…",

  // code tab
  "response.code.badge": "Copyable request code",
  "response.code.selectAria": "Code language or template",
  "response.code.builtin": "Built-in · {label}",
  "response.code.divider": "── Custom templates ──",
  "response.code.manageTitle": "Create / edit / delete custom templates",
  "response.code.manage": "Manage templates",
  "response.code.warn":
    "Variables are expanded with the current environment; auth values are shown too — do not share externally",
  "response.code.unknownVars": "Unrecognized variables in the template:",
  "response.code.empty": "(Template is empty — click \"Manage templates\" to edit)",
  "response.code.reset": "Reset to generated",

  // empty state
  "response.empty.error.title": "Request did not succeed",
  "response.empty.title": "No response yet",
  "response.empty.error.desc": "Check the error above, fix it and resend.",
  "response.empty.desc":
    "Fill in a URL and hit \"Send\"; the response body, status code, script logs and assertion results will appear here.",

  // tests
  "response.tests.empty.title": "No test results yet",
  "response.tests.empty.desc":
    "Write named tests with test() under \"Tests / post-script\", or add declarative assertions under \"Assertions\".",
  "response.tests.script": "Script",
  "response.tests.assertion": "Assertion",

  // logs
  "response.logs.count": "{count} logs",
  "response.logs.duration": "Script took {ms} ms",
  "response.logs.mutations": "Mutations: {list}",
  "response.logs.preError": "Pre-script: {message}",
  "response.logs.postError": "Post-script: {message}",
  "response.logs.empty.title": "No script logs",
  "response.logs.empty.desc": "Call log() in pre/post scripts and the output will show up here.",

  // assertions
  "response.assertions.empty.title": "No declarative assertions",
  "response.assertions.empty.desc": "Add rules under \"Assertions\" in the request config, then resend.",
  "response.assertions.passed": "{passed} / {total} passed",
  "response.assertions.actual": "Actual: ",

  // validate
  "response.validate.noDocs.title": "No response examples defined in the API docs",
  "response.validate.noDocs.desc":
    "After adding response examples (status code + JSON body) under the \"Docs\" tab in the request config, every response is automatically checked against the docs for status code, Content-Type and JSON structure.",
  "response.validate.pass.title":
    "Response matches the documented definition (status / Content-Type / JSON structure)",
  "response.validate.pass.desc":
    "Status {status} matched a documented example · Content-Type family matches · JSON structure matches the example (extra fields ignored)",
  "response.validate.summary": "{total} differences · {errors} errors / {warnings} warnings",
  "response.validate.note":
    "Validation never blocks the request; it only flags deviations from the docs",

  // body
  "response.body.empty.title": "Empty response body",
  "response.body.empty.desc": "The server returned {status} with no response content.",
  "response.body.truncatedNotice":
    "The body is large, so chunked loading and virtual scrolling are enabled. Pretty / JSON tree only parse the inlined preview — use the Text view for the full content.",
  "response.body.viewFullText": "View full text",

  // jsonpath
  "response.jsonpath.placeholder": "JSONPath filter, e.g. $.items[?(@.id > 2)].name",
  "response.jsonpath.aria": "JSONPath filter expression",
  "response.jsonpath.clear": "Clear",
  "response.jsonpath.browse": "Tree browsing",
  "response.jsonpath.matches": "{count}{plus} matches",
  "response.jsonpath.onlyMatches": "Matches only",
  "response.jsonpath.collapse": "Collapse",
  "response.jsonpath.expandAll": "Expand all",
  "response.jsonpath.copyTitle": "Click to copy JSONPath",
  "response.jsonpath.more": "Showing the first 50 of {total}{plus} matches",

  // json tree
  "response.tree.copyPath": "Copy JSONPath: {path}",
  "response.tree.collapse": "Collapse",
  "response.tree.expand": "Expand",
  "response.tree.items": "{count} items",

  // console
  "response.console.aria": "Console",
  "response.console.title": "Console",
  "response.console.all": "All",
  "response.console.autoScroll": "Auto scroll",
  "response.console.clear": "Clear console",
  "response.console.collapse": "Collapse console",
  "response.console.close": "Close",
  "response.console.empty":
    "No logs yet. Send a request, connect over WebSocket, start Mock or import data and events will appear here live.",
  "response.console.source.http": "Network",
  "response.console.source.ws": "WS",
  "response.console.source.mqtt": "MQTT",
  "response.console.source.soap": "SOAP",
  "response.console.source.grpc": "gRPC",
  "response.console.source.mock": "Mock",
  "response.console.source.script": "Script",
  "response.console.source.scenario": "Scenario",
  "response.console.source.import": "Data",

  // sse viewer
  "response.sse.error": "Connection error",
  "response.sse.stopped": "Stopped",
  "response.sse.done": "Completed",
  "response.sse.events": "{count} events",
  "response.sse.chars": "{count} chars",
  "response.sse.truncated": "Limit reached; content truncated",
  "response.sse.tab.timeline": "Timeline",
  "response.sse.tab.raw": "Raw events",
  "response.sse.tab.settings": "Merge rules",
  "response.sse.empty.title": "No SSE event stream yet",
  "response.sse.empty.intro": "When the response Content-Type is",
  "response.sse.empty.mid": " the event fragments are automatically",
  "response.sse.empty.merge": "merged ahead of time",
  "response.sse.empty.outro":
    " into readable text as it arrives, with a timeline shown. You can set streaming mode to \"Force on\" under the request's \"Settings\".",
  "response.sse.empty.example":
    "node examples/sse-server.mjs → send the \"SSE Stream Example\" in the sample collection",
  "response.sse.reasoning": "Reasoning · {count} chars",
  "response.sse.mergedTitle": "Merged response text",
  "response.sse.autoHint": "Format auto-detected; frames merged one by one",
  "response.sse.offHint":
    "Currently in \"Per-event\" mode, so no merged text is produced. Switch to \"Timeline\" to view each event, or switch back to auto-merge under \"Merge rules\".",
  "response.sse.waiting": "Waiting for the first mergeable event fragment…",
  "response.sse.noText":
    "No text fragments were recognized in the events. If the response uses a custom JSON format, configure a JSONPath under \"Merge rules\".",
  "response.sse.filterPlaceholder": "Filter events / data…",
  "response.sse.filterAria": "Filter SSE events",
  "response.sse.waitingEvents": "Waiting for events…",
  "response.sse.noMatch": "No matching events",
  "response.sse.noData": "(no data)",
  "response.sse.snippetTitle": "Extracted snippet",
  "response.sse.rawTitle": "Raw event stream in arrival order",
  "response.sse.mergeMode": "Merge mode",
  "response.sse.mode.auto.label": "Auto merge",
  "response.sse.mode.auto.hint": "Auto-detects OpenAI / Gemini / Claude / plain-text formats",
  "response.sse.mode.jsonPath.label": "Custom JSONPath",
  "response.sse.mode.jsonPath.hint": "Extracts fragments from each event's JSON by path",
  "response.sse.mode.rawText.label": "Concatenate data verbatim",
  "response.sse.mode.rawText.hint": "Joins each event's data field end to end",
  "response.sse.mode.off.label": "Per-event",
  "response.sse.mode.off.hint": "No merging; view the event timeline only",
  "response.sse.textPath": "Text fragment path",
  "response.sse.textPathAria": "Text fragment JSONPath",
  "response.sse.reasoningPath": "Reasoning path (optional)",
  "response.sse.reasoningPathAria": "Reasoning JSONPath",
  "response.sse.ruleHint.a": "Rules apply immediately, re-merging from",
  "response.sse.ruleHint.b": "events already received",
  "response.sse.ruleHint.c": " — no need to resend the request. Detected format: ",
  "response.sse.ruleHint.d": "; merged text {merged} chars, reasoning {reasoning} chars.",

  // binary editor
  "response.binary.removeFile": "Remove file",
  "response.binary.pick": "Choose file",
  "response.binary.hint":
    "The file is passed to Rust over IPC as base64 and sent as the raw request body; if no Content-Type is set, the default is",
  "response.binary.hintEnd": ".",
};
