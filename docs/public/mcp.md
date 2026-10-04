# 笔记 MCP：让 AI 直接读这个站点的笔记

本站是北大法学课程笔记（商法概论、刑事执行法、国际刑法学、法律实证分析等）。每节课有一篇结构化中文笔记，另有每节一张 A4 的「一页纸摘要」。

**这个 MCP 解决的问题**：AI 要回答"跨课次、跨课程"的问题（例如"老师几次讲到法人人格否认，讲法有什么变化"），把全部笔记塞进上下文既不现实也没必要。这个服务器让 AI 先用课程结构、摘要与索引缩小范围，再按需进入具体小节正文——像 Skill 一样渐进式披露。

## 零、先理解内容层：什么用于导航，什么才是依据

| 内容 | 最适合回答 | AI 怎么取 | 地位 |
|---|---|---|---|
| `theme` / `keywords` / 课次摘要 | "这门课或这几节大概讲什么" | `list_courses` / `get_course` | 导航 |
| 一页纸 | "这一节考前快速过一遍" | `llms.txt` 里的「一页纸 Markdown」 | 派生速览 |
| 概念 / 法条 / 案例索引 | "这门课有哪些核心对象、分别在哪" | `list_terms` | 导航 + 落点 |
| 专题整合 | "这几节课合起来形成什么知识框架" | `get_course` 看 `topics` → `fetch(topic:<id>)` | 中观派生结构 |
| 知识地图 | "整门课的课次与概念怎么连起来" | `llms.txt` / 站点知识地图 | 宏观导航 |
| 单课笔记 | "老师具体怎么讲、依据和论证是什么" | `get_note`，优先 `section` | **事实源** |

派生内容的作用是**压缩、组织和定位**。它们与原笔记冲突时，以单课笔记为准；回答跨课次问题时，也尽量把结论落回具体课程、课次和小节。

## 一、挂载

任选一种，写进客户端的 `mcpServers` 配置。

**A. 远程模式（推荐，零本地状态）**——直接读线上站点：

```json
{
  "mcpServers": {
    "course-notes": {
      "command": "node",
      "args": ["/绝对路径/course.law-tech.dev/apps/worker/bin/course.mjs", "mcp",
               "--origin", "https://course.law-tech.dev", "--ttl", "60"]
    }
  }
}
```

**B. 本地发布库**（有 `library.json` 时最快，含正文，按 mtime 自动刷新）：

```json
{
  "mcpServers": {
    "course-notes": {
      "command": "node",
      "args": ["/绝对路径/course.law-tech.dev/apps/worker/bin/course.mjs", "mcp",
               "--library", "/绝对路径/library.json"]
    }
  }
}
```

**C. ssh 桥接服务器上的发布库**（数据不出服务器，永远最新）：

```json
{
  "mcpServers": {
    "course-notes-server": {
      "command": "ssh",
      "args": ["-T", "-o", "BatchMode=yes", "ubuntu@服务器地址",
               "cd /home/ubuntu/course-runtime && exec node apps/worker/bin/course.mjs mcp --library /home/ubuntu/.course-worker/site/library.json"]
    }
  }
}
```

`-T` 不能省：伪终端会往协议流里塞 `\r\n`，握手会失败。

## 二、工具

| 工具 | 用在哪一层 | 参数 | 返回 |
|---|---|---|---|
| `list_courses` | 第一层：有哪些课 | 无 | 课程名、课次数、最新课次时间，以及这门课所有主题与关键词 |
| `get_course` | 第二层：这门课讲了什么 | `course`（必填，支持部分匹配）、`outline` | 课次摘要 + 当前专题清单；专题带 `fetchId`、Markdown/JSON 地址（**不含单课正文**） |
| `search_notes` | 跨课次/跨课程检索 | `query`（必填）、`course`、`includeBody` | 命中片段 + 定位（哪门课、哪一节、正文哪个小节） |
| `get_note` | 第三层：读正文 | `slug` 或 `course`+`lesson`、`section`（只取某一节）、`maxChars`（默认 12000，上限 60000） | 笔记 Markdown；被截断时会说明还有哪些小节可取 |
| `list_terms` | 术语清单 | `course`、`kind`（concept/statute/case） | 这门课的概念/法条/案例，含出现次数与落点 |
| `fetch` | 标准文档读取 | search 的笔记 id，或 `get_course` 返回的 `topic:<id>` | 原笔记/小节，或专题 Markdown |

**资源（resources）**：`notes://courses`、`notes://course/<课程名>`、`notes://terms/<课程名>`、`notes://note/<slug>`。

## 三、推荐的调用流程

这里不是固定的 1→2→3 流水线，而是一棵**最短路径决策树**：

1. **范围未知**才用 `list_courses`；用户已经点名课程时，直接进入 `get_course`。
2. **课程内摸底**用 `get_course`。它会同时给课次摘要和当前专题：如果问题本身就是阶段/专题复习，先把 `topics[].fetchId` 交给 `fetch`，读现成专题框架；只有需要课次章节结构时才请求 outline。
3. **盘点概念、法条、案例**优先 `list_terms`，不要拿几十个关键词逐个 `search_notes`。
4. **找跨课次落点**用 `search_notes`。默认策略已经先查索引，索引答不上来时才下沉正文；只有明确需要穷尽正文时才打开 `includeBody=true`。
5. **读依据**才用 `get_note`，并优先把返回的小节 id / 标题作为 `section`；整篇读取是最后一档。
6. **已经知道具体课次**时，可以直接 `get_note(course+lesson)`，无需先走课程列表。
7. **复习而非查证**时：单节优先一页纸；阶段复习优先 `get_course → fetch(topic:<id>)`；整门课先看知识地图/索引。需要确定性依据时再回 `get_note(section=...)`。

典型返回（`list_courses` 节选）：

```text
课程 4 门 / 课次 8 个
- 商法概论｜2 课次｜最新 2026-09-25（2026-09-20第2-4节）
  theme：从交易成本到有限责任的边界
  keywords：交易成本、资产专用性、代理成本、有限责任、风险外部化、法人人格否认
```

## 四、给 AI 的提示词建议

接入之后可以直接这样交代：

> 你有一个 `course-notes` MCP，里面是我的北大法学课程笔记。单课笔记是事实源，一页纸、专题整合、知识地图和索引用于导航与复习。请按问题走最短路径：已知课程就直接 `get_course`；如果返回的专题与问题匹配，先 `fetch(topics[].fetchId)` 读专题，再按其中的原文落点核实；已知具体课次可直接 `get_note`。盘点概念/法条/案例先 `list_terms`，跨课次找落点用 `search_notes`，只有需要论证细节时再 `get_note(section=...)`。不要习惯性读取整篇或先开启全文扫描。

## 五、机器可读的其它入口

- `https://course.law-tech.dev/llms.txt`：站点摘要与全部入口清单（AI 的第一站）
- `https://course.law-tech.dev/api/notes`：笔记索引 JSON（标题、主题、关键词、摘要、目录；不含正文）
- `https://course.law-tech.dev/topics.json`：当前有效专题索引；每项带专题页面、Markdown、JSON 地址
- `https://course.law-tech.dev/md/<课程>/<课次>.md`：单篇笔记的 Markdown 原文（路径带课程，
  两门课同一天同名课次不会互相覆盖）
- `https://course.law-tech.dev/md/<课程>/<课次>-一页纸.md`：一页纸摘要

## 六、已知限制

- 检索是**子串 + 权重排序**，不是向量检索：适合"某个概念出现在哪几节"这类问题，不适合语义模糊的长句。
- 数据源远程模式默认 60 秒缓存（`--ttl`/`COURSE_MCP_TTL_SECONDS` 可调）；刚发布的笔记最多等 60 秒。
- 经 `course mcp` 启动时 stderr 会有一条 Node 的 `ExperimentalWarning: SQLite`，属正常现象，不影响协议（协议消息只走 stdout）。
- 只读：这个服务器不会修改任何笔记。

## 七、Remote MCP（长期在线，不需要本地任何程序）

上面三种挂载方式都需要本机跑一个 Node 进程（stdio）。长期在线入口仍然是：

    https://course.law-tech.dev/mcp

- 传输：Streamable HTTP（POST 一条 JSON-RPC，回一条 JSON；协议层无会话）
- 身份验证：**Bearer Token**。登录课程空间后，在「账户设置 → MCP」生成；令牌只绑定当前账号，30 天自动失效
- 数据源：当前账号自己的课程笔记与专题；所有读取都按 `owner_id` 过滤，不读取别人的内容
- 只读：所有工具都标了 `readOnlyHint: true`，MCP 没有课程内容写入能力
- 隐私：站点切到私有内容模式后，`/api/notes`、静态 Markdown、专题页与搜索不再作为公开旁路提供

### 接到 ChatGPT / Claude / 其它 Remote MCP 客户端

填 URL `https://course.law-tech.dev/mcp`，并把「账户设置 → MCP」生成的值作为 `Authorization: Bearer <token>` 提交。客户端如果不支持给 Remote MCP 配置 Bearer Header，就不要退回公开/无认证模式；应改用支持认证头的客户端或本地 stdio 方式。连接后应出现：

| 工具 | 用途 |
|---|---|
| `list_courses` | 有哪些课（课次数、最新时间、主题、关键词） |
| `get_course` | 某门课每节的主题/关键词/摘要/目录（不含正文） |
| `search_notes` | 跨课次/跨课程检索，返回片段与落点 |
| `get_note` | 读正文；支持 `section` 只取一节、`maxChars` 限长 |
| `list_terms` | 某门课的概念/法条/案例清单 |
| `search` | OpenAI 标准知识检索（`{ results: [{ id, title, url }] }`） |
| `fetch` | OpenAI 标准取文档（`{ id, title, text, url, metadata }`）；id 支持 `slug#小节` |

### 更新行为

发布一篇新笔记之后，私有空间会更新当前账号的 note 记录；专题绑定的课次发生 checksum 变化时会显示「待更新」。Remote MCP 每次读取都经当前账号的数据源，不需要重新部署服务或重新生成令牌。

## 八、历史验收记录（2026-09-27，公开模式）

下面这组记录只说明 MCP 工具与协议层当时已经跑通过。**它发生在内容改为账号私有之前**，其中「无认证」「公开 /api/notes」「公开笔记页」等结论不再适用于当前模式；新的私有认证与 owner 隔离应由部署验收重新确认。

当时使用官方 **MCP Inspector** 对公开 HTTPS 端点逐项跑过：

| 项 | 结果 |
|---|---|
| `initialize` | `course-notes`，协议 2025-11-25，返回 instructions 与 tools/resources 能力 |
| `tools/list` | 7 个工具，全部 `readOnlyHint: true` |
| `list_courses` | 课程 4 门 / 课次 9 个（含每门课 theme 与 keywords 汇总） |
| `get_course` | 商法概论 2 课次（每节 theme/keywords/摘要） |
| `search_notes` | 命中片段 + 落点 |
| `get_note` | 按 `section=课程概览` 只取该节 |
| `list_terms` | 概念/法条/案例清单 |
| `search` | 单个 text content + JSON 字符串 + structuredContent（二者一致） |
| `fetch` | 整篇 18848 字；`id=slug#课程概览` 时只 944 字，`metadata.section` 有值 |

HTTP 语义：GET → 405、DELETE → 204、通知 → 202、坏 JSON → -32700、超大请求体 → 413、未知工具 → -32602、参数不合法/找不到课程 → `isError: true` + 中文提示。

**动态更新**（不改配置、不重启、不重新部署）：发布一篇测试笔记后等 15 秒，`list_courses` 立刻从「4 门课 / 9 课次」变成「5 门课 / 10 课次」并列出新课程；`get_course` / `search` / `fetch` / `list_terms` 都能看到它；`/api/notes` 从 9 篇变 10 篇且含新笔记；`/llms.txt` 同步出现该课程；笔记页 HTTP 200。测试数据随后已清理（发布库与站点都恢复原状）。
