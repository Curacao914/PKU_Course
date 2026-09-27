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
- `https://course.law-tech.dev/md/<课次>.md`：单篇笔记的 Markdown 原文
- `https://course.law-tech.dev/md/<课次>-一页纸.md`：一页纸摘要

## 六、已知限制

- 检索是**子串 + 权重排序**，不是向量检索：适合"某个概念出现在哪几节"这类问题，不适合语义模糊的长句。
- 数据源远程模式默认 60 秒缓存（`--ttl`/`COURSE_MCP_TTL_SECONDS` 可调）；刚发布的笔记最多等 60 秒。
- 经 `course mcp` 启动时 stderr 会有一条 Node 的 `ExperimentalWarning: SQLite`，属正常现象，不影响协议（协议消息只走 stdout）。
- 只读：这个服务器不会修改任何笔记。
