# course.law-tech.dev

北大课程知识闭环：从教学网课堂实录与用户上传的课件出发，自动完成转录、法学课程笔记、复习派生物、发布、通知与后续检索。

```
教学网实录 ─→ 下载 ─→ Paraformer 转录 ─┐
                                        ├─→ AI 单课笔记 ─→ 简报 / 一页纸 / 来源映射
用户课件 ─→ 管理台 / materials ─→ 解析 ─┘       │
                                                ├─→ 概念 / 法条 / 案例索引
                                                ├─→ 章级整合
                                                ├─→ MCP / 搜索
                                                └─→ course.law-tech.dev → 通知
```

运行在腾讯云单机（2 vCPU / 1.9G / 39G）。公开阅读站与私有管理台分成两个进程；worker 用 SQLite 账本维护任务阶段、重试、租约与投递队列。

## 快速开始

```bash
npm install
npm run test:all
node apps/worker/bin/course.mjs doctor
node apps/worker/bin/course.mjs help
```

`doctor` 只报告依赖与凭据的 `set / missing`，**永远不回显密钥取值**。

配置默认从 `~/.course-worker/env`（0600）读取，也可用 `COURSE_ENV_FILE` 指定。优先级：
**已有环境变量 > env 文件 > 内置默认值**。

## 日常链路

| 阶段 | 入口 | 作用 |
|---|---|---|
| 发现 | `course discover` | 登录教学网，幂等登记本学期回放 |
| 下载 | `course download` | HLS 分片下载、合并与校验 |
| 转录 | `course transcribe` | Paraformer-v2，分片 + R2 临时中转 + 预算保护 |
| 课件 | `course materials` | 上传/归档 PPT、PDF，抽文字与可选 OCR |
| 笔记 | `course notes` | 大纲 → 写作 → 审查 → 局部修订 → 拼装 → 终审 |
| 派生 | `course brief / onepage / sourcemap` | 简报、一页纸及“一页纸 → 原文小节”可追溯映射 |
| 发布 | `course publish` | 生成公开站点；release 模式下完整快照校验后原子切换 |
| 通知 | `course notify / digest / ppt-reminder` | 微信投递、日报、缺课件提醒 |
| 维护 | `course status / retry / reconcile / artifacts / prune / backup` | 恢复、对账、依赖失效、清理与备份 |
| 复习 | `course integrate` | 跨课次章级整合；可保存稳定课次范围并随正文自动刷新 |
| 检索 | `course embed / mcp` | 增量语义索引；课程 → 课次 → 搜索 → 正文分层披露 |

`course cycle` 把主链路串成定时任务；当前 systemd timer 每天北京时间 **07:30 / 19:30** 检测新课。
写笔记是否立即调用模型由成本窗口决定，下载与转录不受该窗口限制。

## 内容版本与事实边界

**单课笔记是唯一事实来源。** 简报、一页纸、来源映射、章级整合、知识索引与语义向量都是派生视图。

- 简报 / 一页纸用 `sourceChecksum` 绑定正文；不同源默认阻止发布。
- source map 同时绑定正文与一页纸，两边任一变化都会失效。
- 章级整合把每个参与课次的 checksum / content fingerprint 写进产物。
- embedding 逐小节绑定 fingerprint；正文变化时旧索引不会继承到新的内容 release。
- `course artifacts` / `course reconcile` 会把 stale / orphan 等异常显式报出来。

内容站支持 versioned release：`site.releases/.staging-*` 完整生成并校验成功后，再一次切换
`site` symlink。旧部署不会被普通 publish 自动迁移；一次性步骤见
[docs/17-内容生命周期.md](docs/17-内容生命周期.md)。

## 章级整合

第一次明确“哪些课属于这一章”：

```bash
course integrate \
  --course 刑事执行法 \
  --lessons 2026-09-07第5-6节,2026-09-14第5-6节,2026-09-21第5-6节 \
  --topic 罪刑均衡与以刑制罪 \
  --save
```

这会把**实际解析到的明确课次**写入 `~/.course-worker/integration-manifest.json`。
后来同课程新增课次不会自动混进旧章节。手工重建全部已配置整合：

```bash
course integrate --configured
```

普通 publish 如果修改了其中某一节正文，会免费重建受影响的确定性整合；失败则保留 stale 状态并交给对账报告，不会伪装成最新版本。

## 结构

```
packages/
  core/         通用领域与计费契约
  acquisition/  教学网采集、回放发现、HLS 下载
  asr/          Paraformer-v2 转录、R2 中转、预算保护
  materials/    PPT/PDF 归档、文字抽取与 OCR 状态
  notes/        单课笔记、简报、一页纸、章级整合
  notes-mcp/    分层检索、HTTP/MCP、语义回退
  store/        SQLite 账本：任务、租约、事件、投递
  publish/      Markdown/站点/索引/来源映射生成
  notify/       微信与备用通知通道
apps/
  worker/       CLI、定时闭环、管理任务
  site/         公开阅读站 + 私有管理台服务
deploy/         systemd、nginx、代码 release、部署与维护脚本
tools/          审计、质量、检索评测、浏览器回归
```

## 文档入口

| 文档 | 内容 |
|---|---|
| [docs/17-内容生命周期.md](docs/17-内容生命周期.md) | **当前**内容版本、派生产物、章级整合与原子发布契约 |
| [docs/16-来源映射与体验修复.md](docs/16-来源映射与体验修复.md) | 一页纸来源映射、视觉精修与真实课次验证 |
| [docs/15-读者体验与本轮交付.md](docs/15-读者体验与本轮交付.md) | 阅读模式、搜索、标记与管理台体验 |
| [docs/14-产物角色与边界.md](docs/14-产物角色与边界.md) | 六类内容产物的事实边界与依赖方向 |
| [docs/12-笔记MCP.md](docs/12-笔记MCP.md) | MCP 分层披露、检索与 HTTP 接口 |
| [docs/08-后端闭环核查.md](docs/08-后端闭环核查.md) | 六阶段链路、失败恢复、备份与清理 |
| [deploy/README.md](deploy/README.md) | 服务器部署、systemd、发布与一次性内容迁移 |
| [docs/decisions/](docs/decisions/) | 架构决策记录 |

`docs/00`—`docs/16` 中有一部分是当时的阶段性记录；历史“尚未实现”项可能已被后续提交完成。
判断当前状态时以 README、`docs/17` 与源码为准。

## 开发约定

- **纯逻辑与 IO 分离**：解析、状态机、键计算尽量不碰网络与磁盘，便于确定性测试。
- **失败要有去向**：自动任务失败必须可重试、可进入 `needs_attention`、可人工恢复。
- **派生物必须可追溯**：正文改了，旧派生物不能静默继续充当最新结果。
- **预算先于调用**：付费能力必须先给上限；能增量复用的绝不全量重算。
- **密钥只从环境读取**：不接受命令行传入；公开进程保持最小权限。
- **发布要么整版成功，要么保持旧版**：release 模式不允许半套内容进入正式站点。
- **测试默认离线**：单测不依赖网络、真实浏览器、ffmpeg 或生产凭据；浏览器审计单独运行。
