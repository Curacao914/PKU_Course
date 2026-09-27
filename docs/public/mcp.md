# 笔记 MCP：让 AI 直接读这个站点的笔记

本站是北大法学课程笔记（商法概论、刑事执行法、国际刑法学、法律实证分析等）。每节课有一篇结构化中文笔记，另有每节一张 A4 的「一页纸摘要」。

**这个 MCP 解决的问题**：AI 要回答"跨课次、跨课程"的问题（例如"老师几次讲到法人人格否认，讲法有什么变化"），把全部笔记塞进上下文既不现实也没必要。这个服务器把内容分成三层，让 AI 先看目录、再看摘要、最后才取正文——按需取用，像 Skill 的渐进式披露。

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
| `get_course` | 第二层：这门课讲了什么 | `course`（必填，支持部分匹配）、`outline` | 每节的标题、时间、阅读时长、主题、关键词、摘要（**不含正文**） |
| `search_notes` | 跨课次/跨课程检索 | `query`（必填）、`course`、`includeBody` | 命中片段 + 定位（哪门课、哪一节、正文哪个小节） |
| `get_note` | 第三层：读正文 | `slug` 或 `course`+`lesson`、`section`（只取某一节）、`maxChars`（默认 12000，上限 60000） | 笔记 Markdown；被截断时会说明还有哪些小节可取 |
| `list_terms` | 术语清单 | `course`、`kind`（concept/statute/case） | 这门课的概念/法条/案例，含出现次数与落点 |

**资源（resources）**：`notes://courses`、`notes://course/<课程名>`、`notes://terms/<课程名>`、`notes://note/<slug>`。

## 三、推荐的调用流程

1. **先 `list_courses`**：拿到课程清单与每门课的主题/关键词，判断该看哪几门课。绝大多数问题到这里就能缩小范围。
2. **再 `get_course`**：看某门课每一节的主题、关键词与摘要，决定要不要读正文。
3. **要读正文才 `get_note`**：优先用 `section` 只取相关小节；整篇默认也会限制在 12000 字以内。
4. **跨课次的问题用 `search_notes`**：例如"哪几节讲过人格否认"，它会给出每一处的落点；需要细节再对这些课次调 `get_note`。

典型返回（`list_courses` 节选）：

```text
课程 4 门 / 课次 8 个
- 商法概论｜2 课次｜最新 2026-09-25（2026-09-20第2-4节）
  theme：从交易成本到有限责任的边界
  keywords：交易成本、资产专用性、代理成本、有限责任、风险外部化、法人人格否认
```

## 四、给 AI 的提示词建议

接入之后可以直接这样交代：

> 你有一个 `course-notes` MCP，里面是我北大法学课程的笔记。回答我的问题时：
> 先用 `list_courses` 看有哪些课，再用 `get_course` 看相关课次的主题与关键词；
> 只有需要原文细节时才用 `get_note`，并尽量用 `section` 只取相关小节；
> 涉及"哪几节课讲过同一个概念"这类问题时用 `search_notes`，并在回答里给出课次出处。

## 五、机器可读的其它入口

- `https://course.law-tech.dev/llms.txt`：站点摘要与全部入口清单（AI 的第一站）
- `https://course.law-tech.dev/api/notes`：笔记索引 JSON（标题、主题、关键词、摘要、目录；不含正文）
- `https://course.law-tech.dev/md/<课程>/<课次>.md`：单篇笔记的 Markdown 原文（路径带课程，
  两门课同一天同名课次不会互相覆盖）
- `https://course.law-tech.dev/md/<课程>/<课次>-一页纸.md`：一页纸摘要

## 六、已知限制

- 检索是**子串 + 权重排序**，不是向量检索：适合"某个概念出现在哪几节"这类问题，不适合语义模糊的长句。
- 数据源远程模式默认 60 秒缓存（`--ttl`/`COURSE_MCP_TTL_SECONDS` 可调）；刚发布的笔记最多等 60 秒。
- 经 `course mcp` 启动时 stderr 会有一条 Node 的 `ExperimentalWarning: SQLite`，属正常现象，不影响协议（协议消息只走 stdout）。
- 只读：这个服务器不会修改任何笔记。

## 七、Remote MCP（长期在线，不需要本地任何程序）

上面三种挂载方式都需要本机跑一个 Node 进程（stdio）。**长期在线、脱离用户电脑**的是这个地址：

    https://course.law-tech.dev/mcp

- 传输：Streamable HTTP（POST 一条 JSON-RPC，回一条 JSON；不带会话，服务器无状态）
- 身份验证：**无**（全部是公开只读内容）
- 数据源：与站点同一份发布库（`library.json`），新笔记发布后按文件更新时间自动可见，不需要重启或重新部署
- 只读：所有工具都标了 `readOnlyHint: true`，服务器没有任何写入能力

### 接到 ChatGPT

「新建插件 / 连接器」→ 填 URL `https://course.law-tech.dev/mcp` → 身份验证选「无 / 不需要」→ 扫描后应出现：

| 工具 | 用途 |
|---|---|
| `list_courses` | 有哪些课（课次数、最新时间、主题、关键词） |
| `get_course` | 某门课每节的主题/关键词/摘要/目录（不含正文） |
| `search_notes` | 跨课次/跨课程检索，返回片段与落点 |
| `get_note` | 读正文；支持 `section` 只取一节、`maxChars` 限长 |
| `list_terms` | 某门课的概念/法条/案例清单 |
| `search` | OpenAI 标准知识检索（`{ results: [{ id, title, url }] }`） |
| `fetch` | OpenAI 标准取文档（`{ id, title, text, url, metadata }`）；id 支持 `slug#小节` |

### 接到 Claude / 其它客户端

支持 Remote MCP 的客户端直接填 URL 即可；只支持 stdio 的客户端用上面三种本地方式之一。

### 更新行为

发布一篇新笔记（`course publish`）之后：`list_courses` / `get_course` / `search_notes` / `get_note` / `list_terms` / `search` / `fetch` / `/api/notes` / `/llms.txt` / `/concepts` 等索引都会自动跟上，**不需要改 MCP 配置，也不需要重新部署服务**。远程站点数据源默认 60 秒缓存，本地发布库按文件修改时间判断，发布后最长等一个缓存周期。

## 八、验收记录（2026-09-27 实测）

用官方 **MCP Inspector**（`npx @modelcontextprotocol/inspector --cli https://course.law-tech.dev/mcp --transport http`）对公开 HTTPS 端点逐项跑过：

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
