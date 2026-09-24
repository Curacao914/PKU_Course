# course.law-tech.dev

北大教学网课程闭环，独立模块化实现：

```
教学网下载 → Paraformer 转录 → AI 撰写笔记 → 发布链接 → 微信推送
```

从 `my-blog-main` 中摘出，运行在腾讯云单机（2 vCPU / 1.9G / 39G），由 `course.law-tech.dev` 对外提供笔记阅读与私有管理台。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/00-现状核查.md](docs/00-现状核查.md) | 旧系统现状：远程/本地一致性、五段链路水平、逐段复用清单、基线验证 |
| [docs/01-模块化方案.md](docs/01-模块化方案.md) | 目标架构、模块契约、运行形态、六步迁移顺序与验收条件 |
| [docs/decisions/](docs/decisions/) | 架构决策记录 |

## 结构

```
packages/
  core/         领域契约：TextPack v1、适配器契约、阶段枚举
  acquisition/  教学网采集：登录、发现回放、HLS 下载与合并
  asr/          转录：Paraformer-v2 + R2 中转 + 预算保护
  notes/        AI 撰写：大纲 → 分节 → 审查 → 修订 → 拼装 → 终审
  store/        账本：任务、租约、版本、投递（SQLite）
  publish/      站点内容生成
  notify/       微信推送
apps/
  worker/       CLI 与定时循环
  site/         course.law-tech.dev
deploy/         systemd units、env 样例
.reference/     旧仓库只读浅克隆（不入库）
```

## 开发

```bash
npm test                     # 全部单测
npm run test:acquisition     # 只跑采集侧
```

单测不依赖网络、浏览器、ffmpeg 与任何环境变量——可以在任何机器上直接验证。
