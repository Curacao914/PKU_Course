# 阅读站恢复 + 长期 MCP Token · DSH 交接

> 本轮仅改本地仓库；未跑测试、未部署。原因是产品边界纠正：`/` 应是阅读站，`/admin` 才是管理页。

## 1. 产品边界

- `course.law-tech.dev/`：当前登录账号自己的**笔记阅读站**，复用原有阅读组件。
- `/admin`：管理页。
  - OWNER：完整 `ADMIN_HTML`，原上传/识别/任务/课程/专题/维护功能全部保留。
  - MEMBER：`MEMBER_ADMIN_HTML`，只管理自己的课程、专题、账户。
- 阅读数据全部来自 control 的 private notes / topics，按 session.sub → owner_id 过滤；不回退公开 library。

## 2. 私有阅读路径

3101 现在处理：

- `/`：原 `renderIndexPage`，含课程筛选、课次、专题、一页纸入口；
- `/notes/<...>.html`：原 `renderNotePage`，含左侧本课课次、正文、目录、阅读工具；
- `/onepage/<...>.html`：原一页纸；
- `/topics/<...>.html`：原专题三视图；
- `/courses/<...>/`：单课程阅读入口；
- `/map/`：知识地图；
- `/concepts/`、`/statutes/`、`/cases/`：私有索引；
- `/search/` + `/api/search`：搜索页与当前 owner 的私有检索。

未登录上述阅读路径 → SSO，并以原路径作为 next；登录回来仍回原阅读路径。

旧 `/md/*`、`/llms.txt`、`/feed.xml` 等仍不作为私有读取旁路。

## 3. nginx

私有模式下 nginx 的通用 `location /` 改为 3101。3100 保留：

- 旧静态 release / 回滚底座；
- 直连时的 privacy gate；
- 不再作为正常用户的阅读宿主。

因此部署时 nginx 与 release 同批更新，避免“新路由代码已上线但 /notes 仍进 3100”的中间态。

## 4. MCP Token 新语义

旧实现：HMAC 自包含票据，30 天 exp。

新实现：

- 格式：`cmcp1.<owner_uuid>.<32-byte-random-secret>`；
- secret 复用 `provider_credentials`，按 owner_id 加密保存；
- **无固定过期时间**；
- 删除令牌 → DB 的 mcp credential 删除 → 现有 token 立即 401；
- 重新生成 → upsert 新 secret → 旧 token 立即 401；
- token 只在生成响应中显示一次。

MCP 请求：

1. 从 token 解析 owner UUID；
2. site 用 HMAC 请求 control 读取该 owner 当前 mcp secret；
3. control 先确认 profile 仍 active；
4. 常量时间比较 token secret 与存储 secret；
5. 成功后才创建该 owner 的 private MCP source。

旧 30 天 HMAC token 在本次发布后**不再兼容**，部署后 OWNER 需重新生成一次长期 token，并更新客户端连接。

## 5. Cloudflare 前置门禁（必须先于应用发布）

**这次是阻断项。** 旧版 `/` 只是无账号数据的统一静态壳，所以 Cloudflare 错误 HIT 尚未泄漏数据；恢复阅读站后，`/`、note、topic、map、索引、search HTML 都含当前账号的私有元数据/正文，绝不能被共享缓存。

在 Cloudflare Cache Rules 增加一条高优先级 **Bypass cache**：

```
(http.host eq "course.law-tech.dev" and
 not starts_with(http.request.uri.path, "/assets/"))
```

也就是：整个 course 域的动态/私有页面全部 bypass；只有 `/assets/*` 继续允许缓存。不要只 bypass 根目录，因为 note/topic/search 同样是私有响应。

规则必须排在现有 Cache Everything/覆盖源站 Cache-Control 的规则之前。先确认登录态 `/` 与一篇真实 note 都不再 `cf-cache-status: HIT`，再进入后续部署。

## 6. 数据库前置迁移（必须先于应用发布）

生产只读确认：`provider_credentials_provider_check` 当前只允许 `ocr/deepseek/dashscope`。

仓库新增：

`deploy/migrations/20261004_mcp_provider.sql`

只把 CHECK 扩成：

`ocr / deepseek / dashscope / mcp`

不改列、不改已有数据、不新增表。

**顺序：先 apply migration → 再 release/nginx → 再生成长期 token。**

## 7. DSH 复测重点

1. 阅读站
   - OWNER/MEMBER 登录后 `/` 都看到旧阅读站视觉，不是“个人空间”管理壳；
   - 首页课程数/课次数与该 owner 私有数据一致；
   - note / onepage / topic / course / map / concepts / statutes / search 都能打开；
   - note 页左侧课次切换、目录、原有阅读工具可用；
   - 专题 sourceRefs 能回当前 owner 原笔记；
   - A/B 相同 slug 不串数据。

2. 管理页
   - OWNER `/admin` 仍是完整后台，之前课程页的上传/识别/进度/重建等功能没有消失；
   - MEMBER `/admin` 是精简管理页；
   - 阅读页右上“进入管理”指向 `/admin`。

3. 搜索
   - `/api/search` 未登录 401；
   - 登录后只检索当前 owner；
   - 搜索结果链接回私有 note 页面。

4. 长期 MCP token
   - migration 前代码写 mcp 应失败（用于确认约束确实存在），migration 后可生成；
   - 生成后跨“30 天”逻辑不再有 exp 字段/TTL；
   - 生成 token → MCP 200；
   - 重新生成 → 新 token 200、旧 token 401；
   - 删除 → 当前 token 401；
   - A token 不能看 B；
   - inactive profile token 不能用。

5. nginx
   - 通用 `location /` → 3101；
   - `/_control/` 仍 3102；
   - 3100 直连旧页面仍被 privacy gate 拦住。

## 8. 本轮刻意未做

- 未跑测试；
- 未应用生产 SQL；
- 未提交/推送；
- 未部署；
- 未改 Cloudflare Cache Rule。
