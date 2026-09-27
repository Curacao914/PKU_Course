# course.law-tech.dev

北大教学网课程闭环，独立模块化实现：

```
教学网下载 → Paraformer 转录 → AI 撰写笔记 → 发布链接 → 微信推送
```

从 `my-blog-main` 中摘出，运行在腾讯云单机（2 vCPU / 1.9G / 39G），由 `course.law-tech.dev` 对外提供笔记阅读与私有管理台。

## 快速开始

```bash
npm install
npm run test:all          # Node 60 项 + Python 15 项
node apps/worker/bin/course.mjs doctor
```

`doctor` 会报告依赖与凭据是否齐备，**密钥只显示 set / missing，从不回显取值**。

## 命令

| 命令 | 作用 |
|---|---|
| `course doctor` | 体检：依赖二进制、凭据、配置来源 |
| `course discover [--course 名称] [--out 文件]` | 登录教学网，列出本学期课程与课堂实录 |
| `course download --course-key K --replay-key K` | 下载一条回放的媒体（HLS 分片 → MP4） |
| `course transcribe --media F --course C --lesson L` | Paraformer 转录（分片 + R2 中转 + 断点续跑） |

配置从 `~/.course-worker/env`（0600）读取，也可用 `COURSE_ENV_FILE` 指定。优先级：**已存在的环境变量 > env 文件 > 内置默认值**。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/00-现状核查.md](docs/00-现状核查.md) | 旧系统现状：远程/本地一致性、五段链路水平、复用清单、基线验证 |
| [docs/01-模块化方案.md](docs/01-模块化方案.md) | 目标架构、模块契约、运行形态、六步迁移顺序与验收条件 |
| [docs/12-笔记MCP.md](docs/12-笔记MCP.md) | 课程笔记 MCP 服务器：分层设计、数据源、工具清单与挂载配置 |
| [deploy/README.md](deploy/README.md) | 服务器部署、手动运行各环节 |
| [docs/decisions/](docs/decisions/) | 架构决策记录 |

## 结构

```
packages/
  core/         领域契约：TextPack v1、适配器契约
  acquisition/  教学网采集：登录、发现回放、HLS 下载与合并
  asr/          转录：Paraformer-v2 + R2 中转 + 预算保护（Python 侧无第三方框架依赖）
  notes/        AI 撰写：大纲 → 分节 → 审查 → 修订 → 拼装 → 终审
  store/        账本：任务、租约、版本、投递（SQLite）
  publish/      站点内容生成
  notify/       微信推送
  notes-mcp/    课程笔记 MCP 服务器（stdio：课程 → 课次 → 检索 → 正文分层披露）
apps/
  worker/       CLI 与定时循环
  site/         course.law-tech.dev
deploy/         env 模板、部署脚本、systemd units
.reference/     旧仓库只读浅克隆（不入库）
```

## 开发约定

- **纯逻辑与 IO 分离**：解析、状态机、键计算不碰网络与文件系统，可零依赖测试。
- **限额在调用时解析**，不在模块顶层固化——避免 import 顺序依赖与 `NaN` 静默传播。
- **密钥只从环境读取**，不接受命令行传入；面向人的输出一律只报 set / missing。
- **单测不依赖网络、浏览器、ffmpeg 与任何环境变量**，任何机器都能直接跑。
