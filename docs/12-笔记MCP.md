# 12 · 课程笔记 MCP 服务器

> 2026-09-27。目标：让 AI（Claude Code / DSH / 任意 MCP 客户端）能读课程笔记并回答问题，
> 但**不是**把几百万字笔记一次灌进上下文——像 Skill 那样分层：先看课程，再看课次，
> 需要时才读某一节的正文。

实现：`packages/notes-mcp`（零依赖，只用 Node 标准库）；CLI 入口 `course mcp`。
协议依据：MCP 规范 [2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)（initialize 版生命周期）
与 [stdio 传输](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#stdio)。

## 1. 分层（渐进式披露）

| 层 | 工具 | 返回什么 | 典型体量 |
|---|---|---|---|
| 1 | `list_courses` | 课程名、课次数、最新课次时间、该课 theme/keywords 汇总 | 一门课 3—5 行 |
| 2 | `get_course` | 某门课的课次清单：lessonTitle、lessonDate、readMinutes、theme、keywords、摘要 | 一节 4—6 行 |
| 2.5 | `search_notes` | 跨课程/跨课次命中的**片段 + 定位**（哪一节）；多词、整句问句、错别字都能用；索引没有命中时自动扫正文 | 每条 2—3 行 |
| 3 | `get_note` | 整篇 Markdown；`section` 只取一节，`maxChars` 限长 | 一节 1—3k 字 |
| 3.5 | `list_terms` | 某门课的概念/法条/案例清单（带次数与落点） | 复习型问题一次看全 |

模型看到的 `instructions`（initialize 响应里）就是这张表的顺序，工具 description 里也写明
「什么时候该用下一层」。这样常见的三种问法各自只花很少的 token：

- 「我有哪些课 / 某课讲到哪了」→ 第 1—2 层，不读正文；
- 「XX 概念在哪几节讲过」→ `search_notes`（默认只查索引，命中处带小节锚点）；
- 「把第 N 节讲给我听」→ `get_course` 拿 slug，再 `get_note(slug, section="…")`。

### 返回示例（都是真实输出，数据是测试夹具）

```
$ list_courses
课程 3 门 / 课次 6 个
- 国际法学｜3 课次｜最新 2026-03-12（第三课 国际法院的管辖）｜教师 张老师
  theme：管辖与可受理性的两道门；反措施的可逆性与相称性；国家责任的三层结构
  keywords：反措施、国际法院、国家责任、归因、解除不法性、比例原则、任择强制管辖、可受理性
  术语：概念 10 / 法条 4 / 案例 2
...

$ get_course(course="国际法学", limit=1)
国际法学｜3 课次｜教师 张老师｜正序
- 第一课 国家责任的构成
  slug: notes/国际法学/第一课-国家责任的构成｜2026-02-20｜18 分钟
  theme：国家责任的三层结构
  keywords：国家责任、归因、反措施、国际法院
  摘要：从初级规则与次级规则的区分出发，讲清国家责任的两个成立条件，并给出归因标准的判断路径。
（还有 2 节未显示，用 limit 调整）

$ search_notes(query="有效控制", includeBody=true)
查询「有效控制」命中 1 处（scope：索引 + 正文；扫描 6 篇）
1. [正文] 国际法学 · 第一课 国家责任的构成
   slug: notes/国际法学/第一课-国家责任的构成｜2026-02-20
   位置：二、归因｜#二-归因
   片段：…「有效控制」标准在这里被反复讨论：只有国家对相关行为行使有效控制时，才可以把行为归因于国家。…

$ get_note(slug="notes/国际法学/第一课-国家责任的构成", section="归因", maxChars=300)
国际法学 · 第一课 国家责任的构成
slug：notes/国际法学/第一课-国家责任的构成｜2026-02-20｜18 分钟｜教师 张老师
theme：国家责任的三层结构
keywords：国家责任、归因、反措施、国际法院
小节（共 7 节）：… / 二、归因 / 三、反措施 / 知识连接
—— 小节「二、归因」（93 字 / 全文 397 字）——
## 二、归因
…
```

被截断时（`maxChars` 或默认 12000 字）返回里会带一行：
`[已截断：只给了前 12000 / 23145 字。可用 section="小节标题" 读某一节，或把 maxChars 提高到最多 60000。]`

## 2. 目录与依赖：为什么是 `packages/notes-mcp`

仓库惯例是 `apps/*` 放「能独立跑起来的东西」（site、worker 都有 bin 与自己的部署方式），
`packages/*` 放被复用的库（`@course/notes`、`@course/publish`…）。MCP 服务器介于两者之间，
最终选 **`packages/notes-mcp`**，理由：

1. 它首先是**协议/查询库**（数据源、分层查询、JSON-RPC），`bin/notes-mcp.mjs` 只是薄薄一层；
2. `course mcp` 要 `import '@course/notes-mcp'`——如果放在 `apps/mcp`，就变成
   「应用依赖另一个应用」，npm workspaces 能跑但语义不对；
3. 测试落在 `packages/notes-mcp/src/*.test.mjs`，正好被根 `npm test` 的 glob 覆盖。

**零依赖**（`dependencies: {}`）：仓库整体是零依赖风格，MCP 的 stdio 传输说白了就是
「一行一条 JSON-RPC」，用 `node:readline` + `JSON.stringify` 三十行就够。不引
`@modelcontextprotocol/sdk` 还带来两个实际好处：客户端挂载时只需一个 `node` 路径，
服务器上 `npm install` 不会因为多一个包而变慢或失败。

## 3. 数据源：本地发布库优先，远程站点兜底

| 优先级 | 来源 | 配置 | 有什么 | 刷新策略 |
|---|---|---|---|---|
| 1 | 本地发布库 `library.json` | `COURSE_LIBRARY` 或 `--library` | 全部字段 + **正文 markdown** | 每次调用 `stat`，mtime/size 变了就重读（进程启动时**不**读死） |
| 2 | 远程站点 | `COURSE_SITE_ORIGIN` 或 `--origin`（默认 `https://course.law-tech.dev`） | `/api/notes` 索引（无正文）+ `/md/<课程>/<课次>.md` 正文 | 短 TTL 缓存，默认 60 秒（`COURSE_MCP_TTL_SECONDS` / `--ttl`）；`/api/notes` 本身是 `no-store` |

- 两者同时配置时**本地优先**，因为只有本地库带正文（`search_notes includeBody` 与
  `get_note` 都不用走网络），且完全离线。
- 本地库配置了但读不到时**直接报错**，不悄悄回落远程——静默降级会让人以为「数据就是旧的」。
- 远程正文路径用的是 `/md/<课程>/<课次>.md`（与站点生成时一致，唯一实现见 @course/publish 的
  markdown-path.mjs，notes-mcp 里是镜像实现）；站点这边静态文件
  带 `max-age=3600`，所以远程数据最坏情况会晚一小时，本地库没有这个问题。

## 4. 协议：stdio + initialize 生命周期

- 传输：stdin/stdout 一行一条 JSON-RPC；**stdout 只写协议消息**，日志（含「就绪」那行）全走 stderr。
- 生命周期：`initialize` →（客户端）`notifications/initialized` → 正常请求；也支持 `ping`。
- 版本协商：支持 `2025-11-25 / 2025-06-18 / 2025-03-26 / 2024-11-05`；客户端要哪个就回哪个，
  不支持的（例如 2026-07-28 之后「无 initialize、元数据放 `_meta`」的新纪元）回自己最新的
  `2025-11-25`。新纪元的客户端会先用 `server/discover` 探测，本服务器对它回 `-32601`，
  客户端按规范回落到 `initialize`——这正是规范给老服务器留的路（
  [Versioning: Backward Compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)）。
- 能力：只声明 `tools` 与 `resources`（不声明 prompts/logging/订阅：没实现就不声明）。
- 错误分工（按规范）：
  | 情形 | 出口 |
  |---|---|
  | 未知工具、`arguments` 不是对象、缺少 `uri` | JSON-RPC `-32602` |
  | 参数类型/范围不对（模型能自己改） | `result.isError=true` + 中文提示 |
  | 未知方法 / 坏消息 / 批量数组 | `-32601` / `-32600` |
  | 资源不存在 | `-32002`（带 `data.uri`） |
  | 其他内部错误 | `-32603`，同时写 stderr 日志 |
- 顺序处理消息：stdio 单连接，顺序处理让响应顺序与日志可复现；工具本身都是毫秒级。
- 客户端关闭 stdin 即退出（规范里唯一可移植的优雅停机方式）。

## 5. 工具清单

| 工具 | 必填 | 可选 | 说明 |
|---|---|---|---|
| `list_courses` | — | `query`、`limit`(≤200) | 第一层；课程名/教师名子串过滤 |
| `get_course` | `course` | `limit`(≤500)、`order`(asc/desc)、`includeOutline` | 第二层；课程名支持部分匹配，歧义时返回候选 |
| `search_notes` | `query` | `course`、`includeBody`、`limit`(≤50) | 跨课次检索；默认先查索引（课程名/标题/小节标题/theme/keywords/概念/法条/案例/摘要），**一条都没命中时自动再扫正文**并在结果里标 `bodyScanned`；`includeBody=true` 表示一开始就连正文一起查 |
| `get_note` | —（`slug` 或 `course`+`lesson` 二选一） | `section`、`maxChars`(200—60000，默认 12000) | 第三层；`section` 按小节标题或标题 id 匹配 |
| `list_terms` | `course` | `kind`(all/concepts/statutes/cases/keywords)、`limit` | 概念/法条/案例清单，带次数与落点锚点 |

约定：`additionalProperties: false`（写错字段名会明确报错，而不是被忽略）；
数字接受数字字符串（模型偶尔写 `"300"`，这属于能自动纠正的小毛病）。

## 6. MCP resources

支持 resources 的客户端（Claude Code、DSH 等）可以不走工具直接读：

| URI | 内容 |
|---|---|
| `notes://courses` | 第一层课程总览（JSON） |
| `notes://course/<课程名>` | 某门课的课次清单（JSON，含 outline） |
| `notes://terms/<课程名>` | 该课概念/法条/案例/关键词清单（JSON） |
| `notes://note/<slug>` | 整篇 Markdown（`text/markdown`） |

课程名与 slug **整段** URL 编码（slug 里的斜杠编码成 `%2F`），例如
`notes://note/notes%2F国际法学%2F第一课-国家责任的构成`；客户端没编码也能读。
`resources/templates/list` 里同时给出三个模板。资源列表每次请求现算（发布库变了立刻可见），
所以没有声明 `listChanged`。

## 7. 挂载

### 7.1 本地（最常用）

先确认发布库在哪：服务器上是 `~/.course-worker/site/library.json`（见 deploy/README）。
本机开发时如果还没有发布库，用 `--origin` 走远程站点。

**Claude Code**（在仓库根目录）：

```bash
claude mcp add course-notes -- node /Users/curacao/Script/course.law-tech.dev/apps/worker/bin/course.mjs mcp \
  --library /Users/curacao/.course-worker/site/library.json
```

或者写进项目的 `.mcp.json`（Claude Code）／`mcpServers` 配置（DSH、Claude Desktop、Cursor 等）：

```json
{
  "mcpServers": {
    "course-notes": {
      "command": "node",
      "args": [
        "/Users/curacao/Script/course.law-tech.dev/apps/worker/bin/course.mjs",
        "mcp",
        "--library",
        "/Users/curacao/.course-worker/site/library.json"
      ]
    }
  }
}
```

**只用远程站点**（不配 library，零本地状态）：

```json
{
  "mcpServers": {
    "course-notes": {
      "command": "node",
      "args": [
        "/Users/curacao/Script/course.law-tech.dev/apps/worker/bin/course.mjs",
        "mcp",
        "--origin",
        "https://course.law-tech.dev",
        "--ttl",
        "60"
      ]
    }
  }
}
```

**用环境变量代替参数**（客户端配置里更干净，也方便和 `~/.course-worker/env` 一致）：

```json
{
  "mcpServers": {
    "course-notes": {
      "command": "node",
      "args": ["/Users/curacao/Script/course.law-tech.dev/apps/worker/bin/course.mjs", "mcp"],
      "env": {
        "COURSE_LIBRARY": "/Users/curacao/.course-worker/site/library.json",
        "COURSE_MCP_TTL_SECONDS": "60"
      }
    }
  }
}
```

优先级：**命令行 > 环境变量 > 默认值**；`COURSE_LIBRARY` 留空即视为没配（走远程）。
也可以直接挂包自带的入口（不经过 worker CLI）：`node packages/notes-mcp/bin/notes-mcp.mjs --library …`。

### 7.2 服务器上的 stdio（ssh 桥接，推荐）

MCP 的 stdio 服务器是**由客户端在本地拉起**的，所以「在服务器上常驻一个 stdio 进程」没有意义：
客户端不在同一个命名空间里，也没有东西去连它的 stdin。要读服务器上那份最新的发布库，
正确做法是让客户端通过 ssh 把远端进程拉起来（数据不出服务器，客户端只拿结果）：

```json
{
  "mcpServers": {
    "course-notes-server": {
      "command": "ssh",
      "args": [
        "-T",
        "-o", "BatchMode=yes",
        "-o", "LogLevel=ERROR",
        "-i", "/Users/curacao/.ssh/lawtech-tencent",
        "ubuntu@124.222.111.108",
        "cd /home/ubuntu/course-runtime && exec node apps/worker/bin/course.mjs mcp --library /home/ubuntu/.course-worker/site/library.json"
      ]
    }
  }
}
```

要点：`-T` 禁掉伪终端（否则远端会把 `\r\n` 塞进协议流，客户端解析直接崩）；
`LogLevel=ERROR` 压掉 ssh 横幅；命令用 `exec` 让 node 取代 shell，`SIGTERM`/stdin EOF 才传得到。
缺点是每次会话都要过一遍 ssh 握手，且远端笔记更新即时可见的前提是 ssh 命令每次都重新启动进程。

### 7.3 HTTP 端点（已内置：站点进程上的 `POST /mcp`）

站点进程（`course-site`，公开角色监听 3100）已经把**同一个协议服务器**挂在 `POST /mcp` 上
（`packages/notes-mcp/src/http.mjs`）：无状态——每次 POST 自带完整 JSON-RPC，不返回
`Mcp-Session-Id`，客户端重连、多实例、重启都不需要重新握手；响应一律 `application/json`
（不用 SSE：CDN / nginx / Cloudflare 对 SSE 的缓冲更难伺候，而我们的工具都是请求-响应式，
没有服务端推送）。

```bash
curl -sS https://course.law-tech.dev/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

规范边界（都有测试钉住）：`GET` → 405（不提供服务端 SSE 流）、`DELETE` → 204（无状态，
没有会话可终止）、通知（无 `id`）→ 202 无响应体、坏 JSON → `-32700`、未知工具 →
`-32602`、请求体超限 → 413、不支持的 `MCP-Protocol-Version` → 400。支持的版本：
2025-11-25 / 2025-06-18 / 2025-03-26 / 2024-11-05。

安全边界（默认开启，都是"存在才校验"，不打断 CLI 客户端）：Origin 与 Host 白名单——
浏览器带来的 Origin 必须在本站域名内，Host 必须是本站域名或本机（防 DNS rebinding），
用 `mcpOrigins` / `mcpHosts` 增补。

#### 7.3.1 请求预算：`/mcp` 与站内搜索共用一本账

限流 / 并发 / 墙钟时间 / 查询长度都实现在 `packages/notes-mcp/src/budget.mjs`，而
`POST /mcp` 与站内搜索 `GET /api/search` 用的是**同一个 budget 实例**——
只给 MCP 加闸门等于留了后门：同一台机器，绕开 MCP 直接刷搜索一样能把它打满。

| 预算 | 默认 | 超了会怎样 |
|---|---|---|
| 每 IP 每窗口请求数 | 300 次 / 60 秒 | 429 + `retry-after` |
| 全局并发 | 8 | 503 + `retry-after: 1` |
| 单次墙钟时间 | 20 秒 | 504（JSON-RPC `-32001`），并中止后台检索 |
| 查询串长度 | 200 字符 | `/api/search` → 400；MCP → `isError: true`（模型改短即可重试） |

站点进程的环境变量：`COURSE_RATE_LIMIT_MAX`、`COURSE_RATE_LIMIT_WINDOW_MS`、
`COURSE_MAX_CONCURRENT`、`COURSE_REQUEST_TIMEOUT_MS`、`COURSE_MAX_QUERY_CHARS`。

**客户端地址怎么算**：默认**不读任何转发头**，只认 TCP 对端地址。只有直连方在
`COURSE_TRUSTED_PROXIES`（生产：`127.0.0.1,::1`——nginx 在本机）里时，才读
X-Forwarded-For，并且取的是**最右不可信跳**：nginx 的 `proxy_add_x_forwarded_for` 会把
真实客户端追加到末尾，所以客户端自己伪造的前缀换不掉身份。前面还有 Cloudflare 时用
`COURSE_CLIENT_IP_HEADER=cf-connecting-ip` 取它设的那个头（同样只在直连方可信时生效）。
两个都不配时所有请求共用一个桶——宁可粗一点，也不认一个随手就能伪造的头。

**取消与泄漏**：每个请求带一个 AbortSignal。客户端中途断开（浏览器取消、代理超时）或
超出时间预算时 abort 它，信号一路传到检索层（在课次之间、远程取正文处检查，抛
`CancelledError` 退出）——不是"把计数减回去然后继续烧 CPU"。并发槽位的归还是**幂等**的：
正常结束（`finish`）与异常断开（`close`）都会归还；以前只挂 `finish`，漏满 8 个之后
所有请求 503，只能重启进程。另外全文检索每 25 条记录让出一次事件循环：本地库的检索是
纯同步循环，不让出的话"一个人搜索"就等于"整站（含静态页面）都卡住"，超时与取消也永远
不会生效。

#### 7.3.2 备选：stdio → HTTP 网桥（不想动站点进程时）

**A. 用现成的 stdio→HTTP 网桥**（改动最小；代价是多一个第三方依赖）。

```bash
npx -y supergateway \
  --stdio "node /home/ubuntu/course-runtime/apps/worker/bin/course.mjs mcp --library /home/ubuntu/.course-worker/site/library.json" \
  --port 8790 --baseUrl http://127.0.0.1:8790
```

用 systemd user unit 托管（stdio 型不需要常驻，HTTP 型才需要）：

```ini
# ~/.config/systemd/user/course-notes-mcp.service
[Unit]
Description=课程笔记 MCP 服务器（stdio 转 HTTP，仅监听本机）
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/course-runtime
Environment=COURSE_LIBRARY=%h/.course-worker/site/library.json
ExecStart=/usr/bin/npx -y supergateway --stdio "/usr/bin/node %h/course-runtime/apps/worker/bin/course.mjs mcp" --port 8790 --baseUrl http://127.0.0.1:8790
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadOnlyPaths=%h/.course-worker/site
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now course-notes-mcp.service
journalctl --user -u course-notes-mcp -f      # 看日志（协议日志都在 stderr → journal）
```

**只监听 127.0.0.1**，对外暴露必须另配鉴权（笔记虽不是机密，但 MCP 端点被任意调用
等于把整库笔记和服务器状态交出去）；要跨机访问就复用现有的 Cloudflare Tunnel
（`course.law-tech.dev` 已经在用）并加访问控制。

**B. 独立进程**：想让 MCP 完全脱离站点进程单独跑时，用
`packages/notes-mcp/bin/notes-mcp.mjs` 配一条 systemd unit（stdio 型不必常驻），数据源给
`COURSE_LIBRARY=<站点目录>/library.json`。站点进程上的 `/mcp` 已经覆盖绝大多数场景，
单独起进程只在"需要独立的发布节奏或端口"时才值得。

## 8. 排错

一行命令手工握手（不装任何客户端）：

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_courses","arguments":{}}}' \
  | node apps/worker/bin/course.mjs mcp --library ~/.course-worker/site/library.json
```

| 现象 | 原因 / 处理 |
|---|---|
| 客户端显示服务器启动失败 / 没有任何工具 | 先手工跑上面那条命令；`course mcp --help` 能打印用法说明配置能解析 |
| 工具返回「读不到发布库 …」 | `COURSE_LIBRARY` 路径不对（或发布库还没生成：先 `course publish`）；也可临时用 `--origin` |
| 数据是旧的 | 本地库按 mtime 即时刷新；远程是短 TTL（默认 60 秒）+ 站点静态文件 `max-age`，`--ttl 0` 可每次重取 |
| 正文读不到（远程） | 站点缺 `/md/<课程>/<课次>.md`（老站点写的是平铺的 `/md/<课次>.md`，跑一次 `course publish --rebuild` 即可）；本地发布库不受影响 |
| 资源列表看不到新笔记 | 资源每次请求现算，客户端可能缓存了 `resources/list`；重连会话即可 |
| ssh 桥接报「Invalid JSON」 | 少了 `-T`，协议流里混进了 `\r` 或 ssh 横幅 |
| stderr 里有 `ExperimentalWarning: SQLite` | 经 `course mcp` 启动时会加载 worker 的账本模块；警告只在 stderr，不影响协议（直接跑 `packages/notes-mcp/bin/notes-mcp.mjs` 则不会出现） |

## 9. 测试

```bash
node --test packages/notes-mcp/src/*.test.mjs     # 包本身，90 个用例
node --test apps/worker/src/mcp.test.mjs          # course mcp 接线，3 个用例
npm test                                          # 全仓（含上面两处）
```

覆盖：分层正确性（列表/课次字段与排序、列表不含正文）、跨课次检索（索引命中、`includeBody`
正文命中并定位到小节、`course` 限定、无命中）、`get_note` 的 `section`/`maxChars` 截取与
可操作报错、两种数据源（本地 mtime 刷新、远程 TTL 缓存与 404/断网报错、本地优先）、
JSON-RPC（`initialize` 版本协商、`tools/list`、`tools/call` 未知工具/坏参数/内部错误、
`resources/*` 与 `-32002`、`ping`、坏消息、批量数组）、stdio（顺序回应、坏 JSON `-32700`、
子进程真实握手与 stdin 关闭退出）、HTTP 传输（七个工具、通知 202、GET 405、坏 JSON、
超大请求体）、**请求预算**（`budget.test.mjs` + `http-budget.test.mjs`：中途断开与请求体
读到一半断开后名额立刻归还且后台被 abort、超时回 504 并中止检索、并发满员 503 后能立刻恢复、
finish/close 双触发只归还一次、坏 JSON/超限/未知工具/内部错误都不漏槽位、不可信直连方
伪造 XFF 换不掉身份、可信代理下按最右不可信跳记账、超长查询在解析前被挡住）。
全部离线：远程测试用 `127.0.0.1` 上的假站点，夹具是
`packages/notes-mcp/src/fixtures/library.json`。

## 10. 取舍与后续

- **不做 prompts 能力**：分层已经由工具与 `instructions` 表达，再加一层提示词模板只会重复。
- **不做资源订阅（`subscribe`/`listChanged`）**：发布是「另一个进程写完就退出」，
  没有可靠的变化通知源；短 TTL 与 mtime 已经够用。
- **不做结构化输出（`outputSchema`/`structuredContent`）**：工具回给模型的是紧凑文本，
  结构化数据走 resources；两套并存会让同一份数据在上下文里出现两次。
- **检索是词面匹配，不是向量检索**：查询会先去疑问词与虚词、再按虚词切开，
  长片段补 2—4 字 n-gram，命中用「字段权重 × 词权重 × IDF」排序（只在一两节出现的专名
  权重最高），一个词都没命中时用语料里出现过的词做编辑距离 1 的回退。
  这套在百来篇笔记的规模上够用，而且完全可解释（能说清"为什么它排第一"）；
  真要做语义检索，应该加在站点侧（一次算好，MCP 只读结果），
  而不是让每个客户端各算一遍。
- **不内置 HTTP 传输**：见 §7.3；在只服务本机与 ssh 桥接的场景里，stdio 更简单也更安全。
- **老笔记没有 theme/keywords 时**：列表里那两行会空着（不影响其他层）；
  用 `course brief --from …` 补一份简报即可。
