# 私有课程空间 + 专题整合 · DSH 交接

> 本轮只改本地仓库，**未部署、未写生产、未运行测试/浏览器验收**。测试与上线由 DSH 接手。

## 1. 最终产品语义

- 所有账号（OWNER / MEMBER）都按 `owner_id` 拥有自己的课程笔记、专题、API、通知邮箱与教学网连接。
- 课程名 / 课次名只用于展示；私有笔记的身份以账号隔离 + 发布 slug 为主，不再把 replayKey 当全局唯一键。
- `course.law-tech.dev` 切到 private mode 后，公开静态笔记、Markdown、专题、`/api/notes`、公开搜索都不能成为旁路。
- Remote MCP 必须带账号签发的 Bearer Token，服务端先解出 owner，再由 control 按 owner 过滤。
- 普通 MEMBER 的 `/admin` 只显示：概览 / 课程 / 专题 / 账户设置；OWNER 继续保留完整管理能力，并新增自己的账户设置。

## 2. 已接主线

### control

- 私有 note 增补 `slug / checksum / lessonDate / index`；按 slug 优先 upsert，replayKey 只在唯一时兜底，避免历史共享 replayKey 互相覆盖。
- 私有 topic 存入 notes（`note_type=course-topic`），保留结构化 artifact；按绑定课次 checksum 判 `fresh / stale / missing`。
- 新增当前账号的 private content / note / topic 读写接口。
- 新增专题 job；运行前**从 DB 重建 MEMBER 的 private-library.json**，本地账户目录不再是事实源。
- 新增通知邮箱更新；PKU 状态返回 scannedCourseKeys。
- MEMBER 临时 job token scope 统一为 `private-content:write`。
- 专题与笔记写回均 owner-scoped。

### worker

- MEMBER publish 写私有 note，并保存完整索引元数据。
- MEMBER topics 读取私有 library、生成结构化专题、写回 control。
- OWNER 在 `COURSE_CONTENT_VISIBILITY=private` 时，每次 publish / topic rebuild 同步写回自己的账号空间；旧 site/library 保留作迁移与回滚底座。
- OWNER 写回与历史导入使用 `silent:true`，避免重复触发课程完成邮件。

### site/admin

- MEMBER `/admin` 有独立个人空间 UI：
  - 概览：已发布 / 进行中 / 待处理 / 排队中，可展开；
  - 课程：本人课程与课次；
  - 专题：生成 / 更新 / 删除，专题详情有「框架 / 提纲 / 自测」；
  - 账户设置：登录/通知邮箱、DeepSeek / 阿里云 / OCR、教学网密码或扫码、扫描课程、课程选择、自动同步、MCP Token。
- OWNER 顶层「设置」改为「账户设置」，加入通知邮箱、个人 API、MCP Token、旧库导入按钮。
- SSO 登录成功后 owner/member 都保留 next，不再把 member 强制踢回根目录。
- OWNER 旧库导入幂等写入个人空间，专题 Markdown 同步生成。

### 私有读取 / MCP

- `COURSE_CONTENT_VISIBILITY=private`：
  - public 进程只留 health/assets；内容 URL 导向登录后的管理空间；
  - `/api/notes` / search 等公开 API 不再暴露课程内容；
  - nginx 把 `/api/account/*` 与 `/mcp[/]` 送到 3101。
- MCP token 为 HMAC 签名、owner-bound、30 天过期。
- private MCP 的数据源通过 control 实时读取 owner 私有内容；不回退公共 library。
- 私有 MCP record 会走 normalizeRecord；正文与专题 Markdown 按 owner 单独读取。

## 3. 上线前必须配置

OWNER `~/.course-worker/env`：

```env
COURSE_CONTENT_VISIBILITY=private
COURSE_ACCOUNT_OWNER_ID=<OWNER 的 profiles.id>
COURSE_CONTROL_LOCAL_URL=http://127.0.0.1:3102
COURSE_CONTROL_SIGNING_KEY=<与 control-env / law-tech 完全相同，>=32 bytes>
```

control-env 仍按既有多用户设计配置 Supabase / encryption / MEMBER R2 / signing key。

注意：MEMBER 子进程必须继续看不到 `COURSE_CONTROL_SIGNING_KEY`；sanitizeMemberEnv 是 allowlist。

## 4. OWNER 迁移顺序

1. 部署 control + admin/site + nginx。
2. 确认 OWNER SSO 能进 `/admin`。
3. 「账户设置 → 同步现有笔记到个人空间」执行一次；应把旧 library 与 topics 写进 OWNER 私有 notes。
4. 再跑一次应保持幂等，不应多出重复课次/专题，也不应批量发送“笔记完成”邮件。
5. 确认 OWNER 后续新 publish / topic rebuild 会自动更新私有副本。
6. **清 Cloudflare 旧静态内容缓存**；否则旧 HTML/Markdown 可能在边缘继续命中，服务端 privacy gate 还没机会执行。

## 5. DSH 测试重点

1. **静态旁路关闭**：未登录访问根目录、旧 note HTML、`/md/*`、topic、`/api/notes`、search；不能拿到正文。
2. **两账号隔离**：A/B 同名课程、同名课次、同 slug-like 标题互不覆盖；A 的 note/topic/API/MCP 都看不到 B。
3. **历史 replayKey 冲突**：用两个共享 replayKey、不同 slug 的课次验证不会互相 update/delete。
4. **OWNER 迁移**：导入一次、导入两次、导入后发布更新，记录数量与内容正确；无重复提醒。
5. **专题**：首次自动划分、单专题更新、整门课重新划分；改一节课 checksum 后相关专题变 stale，更新后 fresh；框架/提纲/自测均能打开，sourceRefs 能回原笔记。
6. **MEMBER 恢复性**：删除 `accounts/<id>/private-library.json` 后再生成专题，应从 DB 自动重建。
7. **教学网**：扫码/长期登录 → 扫描课程 → 选择课程 → 同步；未选择课程时同步应给清楚的 preflight。
8. **账户设置**：通知邮箱修改、三类 API 保存/删除；A 的凭据不可被 B 读取/使用。
9. **MCP**：无 token / 错 token / 过期 token = 401；A token 只能列 A 的课程；`list_courses/get_course/search_notes/get_note/list_terms/search/fetch` 都走私有源。
10. **部署路由**：`/api/account/*`、`/mcp`、`/mcp/` → 3101；`/_control/` → 3102；公开内容请求不能绕回 3100 静态库。
11. **缓存**：切 private 后检查 Cloudflare 缓存已 purge，旧公开 URL 不再 HIT 出正文。
12. **资源隔离**：继续复核 MEMBER 子进程环境没有 OWNER PKU / AI / R2 / admin / signing / Supabase secret。

## 6. 这轮刻意没做

- 没部署。
- 没改线上 Supabase / R2 / nginx / systemd。
- 没跑单测、全量测试、浏览器测试、MCP Inspector、真实 PKU 登录。
- 没替 DSH 做任何长耗时验收。
