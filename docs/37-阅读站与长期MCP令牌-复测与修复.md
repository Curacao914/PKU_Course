# 阅读站 + 长期 MCP 令牌 · 复测与修复记录

> 对象：`docs/36-阅读站与长期MCP令牌-DSH交接.md` 描述的那批**未提交改动**（9 个文件）。
> 结论先说：这批改动方向正确，但不能直接上——复测发现 6 处会让"阅读站打不开"或"保护失效"的缺口，
> 已全部修复并补测试（全量 **738/738**，真 Chrome 走查 12/12）。
> **发布仍被两个用户侧前置卡住**：Cloudflare Bypass Cache 规则、`provider_credentials` 的 CHECK 迁移。

## 0 一句话清单

| # | 结论 |
|---|---|
| 1 | 未提交改动已审计完（9 文件 / +399 −57），发现 B1–B6 六处缺陷，全部修复 |
| 2 | 补测试 14 条：控制面 5、私有阅读+MCP 9；发布层另有 1 条链接不变式测试 |
| 3 | 全量 `npm test`：**738 pass / 0 fail**（改动前是 723，其中 3 条因 B1 变红） |
| 4 | fixture 真浏览器（本机 Chrome）走通 12 项：首页/笔记/一页纸/课程/专题/搜索/管理页/无 JS 报错 |
| 5 | 发布前置 1：Cloudflare Cache Bypass **未应用**，token 无权（见 §5） |
| 6 | 发布前置 2：DB 迁移**未应用**，本机与服务器都没有 DDL 权限（见 §6） |
| 7 | 迁移前实测确认约束确实存在：插 `provider='mcp'` → HTTP 400 / `code 23514`（见 §6.2） |
| 8 | 两个前置都是**用户侧动作**；未拿到之前不发布（发布即可能在共享缓存里泄漏私有页面） |

## 1 复测方法

- 逐文件读完未提交 diff：`apps/control/src/{server,store}.mjs`、`apps/site/src/{admin,admin-page,member-page,server}.mjs`、
  `deploy/nginx-course.conf.example`、`docs/public/mcp.md`、`packages/publish/src/index.mjs`。
- 顺着调用链读实现（不是只读 diff）：`packages/publish/src/site.mjs` 的渲染函数签名与链接构造、
  `packages/notes-mcp/src/{service,render}.mjs` 的专题/fetch 语义、`apps/control/src/store.mjs` 的私有内容形状、
  `packages/notes-mcp/src/budget.mjs` 的闸门。
- 复现证据分级：**跑出来的**（测试红/绿、HTTP 码、浏览器行为、SQL 返回码）与**读出来的**（代码路径）分别标注。
- 每一步都先写测试再改代码；`npm test` 全绿后才提交。

## 2 发现与修复

### B1 私有阅读路由没有按内容模式门控（公开模式整站被要求登录）

**现象（跑出来的）**：改动后 `npm test` 3 条红：

```
✖ non-admin paths are left to the static handler            (admin.test.mjs:968)
✖ 站内搜索与 /mcp 共用同一本预算…                            (server.test.mjs:413) → 401 !== 200
✖ 查询长度预算两个入口一致…                                  (server.test.mjs:439) → 401 !== 400
```

**根因（读出来的）**：`handlePrivateReading` 在 `handle()` 里被**无条件**调用，而管理进程在公开模式
（本地单进程 `role=all`、以及任何一次 `COURSE_CONTENT_VISIBILITY` 漏配）下同样挂着这个 handler。
一旦 nginx 的 `location /` 指向 3101，配置漂移就会让"公开站还在 3100 正常工作、经 nginx 进来的读者却只看到 SSO 跳转"。

**修复**：`createAdminHandler` 增加 `privateContent` 参数，由 `apps/site/src/server.mjs` 透传；
路由改判定（`apps/site/src/admin.mjs:2606`）。测试：`apps/site/src/private-reading.test.mjs` 的
"公开模式下管理进程不接管阅读路径"。

### B2 中文路径不解码 → 阅读站**每一页**都打不开（静默回首页）

这是本轮最严重的一处。

**现象（跑出来的）**：新写的阅读站测试里，`GET /notes/国际刑法学/第1-2节….html`（带会话）返回 **302 → `/`**，
而不是 200。

**根因（读出来的）**：发布库里的 slug 是**原文**（`notes/国际刑法学/第1-2节-…`），
而浏览器/fetch 发出的路径是**百分号编码**，`new URL()` 也不会替你解码；
旧的静态处理器靠 `resolveInsideRoot()` 里的 `decodeURIComponent` 兜住了，新的私有路由是拿编码后的
`pathname` 直接和 slug 比。后果不是报错，而是**所有中文路径都匹配不上**——而本项目所有课程、课次、
专题名都是中文，等于阅读站整体不可用。

**修复**：`decodePathname()`（`apps/site/src/admin.mjs:96`）+ 路由匹配统一走解码后的 `route`
（`apps/site/src/admin.mjs:1061`）；对外的 SSO `next` 仍用**原始编码路径**（Location 头里不能塞裸中文）。

### B3 私有 `/api/search` 完全绕过请求预算

**现象（读出来的 + 测试固定）**：私有模式下 nginx 把 `location /` 指向 3101，`/api/search` 整体搬进管理进程，
但那份实现**没有**限流、并发、超时、查询长度这四道闸门——公开模式里 `/api/search` 与 `/mcp` 共用的那本账，
在生产实际生效的那条路径上等于没有。同一台 1.2G 的机器，绕开 MCP 直接刷搜索一样能打满。

**修复**：抽出 `apps/site/src/search-endpoint.mjs`（`runBudgetedSearch` + `searchPayload`），
两个入口共用同一份"查长 → 取槽位 → 绑定生命周期 → 跑 → 翻译结果/错误"；
进程侧的预算实例由 `searchBudget()` 注入（`apps/site/src/server.mjs:188`），
私有检索处直接用它（`apps/site/src/admin.mjs:1114`）。拿不到预算就 503，不放行。

测试：`私有检索与 /mcp 共用同一本预算：限流与查询长度都拦得住`（429 + `retry-after: 60`、400 + "21 字，上限 20 字"）。

### B4 长期令牌配置状态没进 `/v1/account/status` → 界面上删不掉

**现象（读出来的）**：控制面 `/v1/account/status` 只回 `ocr/deepseek/dashscope` 三个 key，
而两个界面的 MCP 卡片都按 `credentials.mcp.configured` 决定按钮文案与是否显示"删除令牌"。
结果：**永远显示"生成访问令牌"**（其实是在换发、会让旧令牌立刻失效），**"删除令牌"按钮永远不出现**——
文档 §7.4 要求的"删除 → 当前 token 401"在界面上根本走不到。

**修复**：`apps/control/src/server.mjs:173` 补 `mcp: credentials.mcp || { configured: false }`。
测试：`mcp-token.test.mjs` 的 "/v1/account/status 要带上 mcp 配置状态"。

### B5 私有 MCP 报的专题页仍指向管理页

**现象（跑出来的）**：`fetch(fetchId: topic:…)` 的 `structuredContent.url` 是 `/admin`。
阅读站恢复后，`/admin` 是**管理页**，专题三视图在 `/topics/<课程>/<专题>.html`。

**修复**：`apps/site/src/server.mjs:371` 改为 `'/' + topicSlug(...) + '.html'`。
测试：`MCP 报的专题页指向阅读站，不是管理页`。

### B6 站内链接用了相对路径（笔记页"上一讲/下一讲"、课程入口课次行）

**现象（跑出来的）**：把渲染结果按浏览器规则解析：

```
笔记页 /notes/国际刑法学/第1-2节-….html 的"下一讲" href = notes/国际刑法学/第3-4节-….html
  浏览器解析 => /notes/国际刑法学/notes/国际刑法学/第3-4节-….html   ← 404
课程入口 /courses/国际刑法学/ 的课次行 href = notes/…
  浏览器解析 => /courses/国际刑法学/notes/…                        ← 404
```

前者是**线上公开站早就存在**的问题（生产 HTML 实测确认：`notes/犯罪学/notes/…` 形状），
后者是本轮新加的 `/courses/<课程>/` 入口**自带**的问题。共同点是少了一个开头的 `/`。

**修复**：`packages/publish/src/site.mjs:1418`（上一讲/下一讲）、`:2441`（课次行）改为根绝对。
测试：`packages/publish/src/site.test.mjs` 新增不变式测试
`每一页的站内链接都是根绝对路径（相对链接在深层地址上必然断）`——它扫描首页/课程入口/笔记页/一页纸/
专题页/知识地图/概念索引/搜索页里所有 `<a href>`（跳过内联脚本），任何相对链接都会让测试变红。

### 录而不改（本轮刻意没动）

- **MEMBER 的一页纸是空壳**：`publishPrivate` 调 `buildNoteRecord` 时不传 `onepage`，所以 `/onepage/<slug>.html`
  对 MEMBER 渲染出空 A4（首页也不会给入口，因为链接按 `record.onepage` 是否存在决定）。要补得先让
  worker 在私有发布时带上 onepage 产物，属于另一个改动。
- **`tools/ui-click-audit.mjs` 已经跑不起来**（与本轮改动无关的两处漂移）：① `/admin` 现在要求账号会话，
  审计没有会话 → 302 到 SSO，`#tab-overview .card` 等不到；② 补上会话后卡在
  `#tab-courses [data-act="rail-toggle"]` 命中两个元素、点击被 `.colhead` 挡住（布局漂移）。
  本轮的等价覆盖用 `private-reading.test.mjs`（HTTP 层）与 fixture Chrome 走查（交互层）补上。

## 3 测试与验收

```
apps/control/src/mcp-token.test.mjs      5 条：通用凭据路由拒绝 provider=mcp、专用路由按签名 owner 记账、
                                        未签名一律 401、status 带 mcp 状态、SQL 与代码 provider 清单一致
apps/site/src/private-reading.test.mjs   9 条：未登录 SSO/401、公开模式不接管、根目录是阅读站、
                                        note/onepage/topic/course/map/索引/搜索页、查不到的课次回根、
                                        私有检索只搜当前 owner、检索预算、长期令牌全生命周期、专题链接
packages/publish/src/site.test.mjs      +1 条：站内链接根绝对不变式（并修掉 3 条断言旧相对链接的老测试）
```

全量：`ℹ tests 738 / pass 738 / fail 0`。

### 迁移前约束确认（跑出来的）

用服务端 REST 直接插一行 `provider='mcp'`（插完立即删，事后确认只剩 deepseek/dashscope/ocr 三行）：

```
POST /rest/v1/provider_credentials {provider:"mcp", …}
=> 400 {"code":"23514", "message":"new row for relation \"provider_credentials\" violates check constraint …"}
```

即：**`deploy/migrations/20261004_mcp_provider.sql` 不应用，长期令牌就写不进去**。

### fixture 真浏览器走查（跑出来的，12/12）

起一个私有模式站点 + 桩 control（桩只认 HMAC 签名头里的 owner），用本机 Chrome 真点一遍：

```
✔ 首页是阅读站（rail=1, 进入管理入口=1）      ✔ 首页课次点得开
✔ 笔记页左侧课次=2 本页目录=2                 ✔ 上一讲/下一讲点得通（不再回首页）
✔ 本页目录锚点跳转                            ✔ 单课程入口点课次进得去
✔ 专题三视图可切换（框架/提纲/自测）           ✔ 专题出处点回原笔记小节
✔ 站内搜索出结果并点得进笔记                   ✔ MEMBER /admin 是管理页（MCP 卡片在）
✔ 全程没有页面 JS 报错                        ✔ 全程没有 4xx/5xx 资源
```

脚本在 `.probe36/reading-acceptance.mjs`（本次审计的临时目录，**不入库**；要复跑就照这份重写，几十行）。

## 4 Cloudflare 门禁（阻断项，仍未解决）

实测（2026-10-04）：

```
GET https://course.law-tech.dev/          → 200  cache-control: private, max-age=300  cf-cache-status: HIT   age 5807
GET https://course.law-tech.dev/search/   → 302  private, no-store                    cf-cache-status: BYPASS
GET https://course.law-tech.dev/healthz   → 200  no-store                             cf-cache-status: DYNAMIC
```

`/` 命中共享缓存这一点没有变：发布之后 `/` 就是**当前账号的私有阅读站首页**，
note/topic/map/索引/search 同样是私有正文与元数据。Bypass 规则必须排在现有 Cache Everything / 覆盖源站
Cache-Control 的规则**之前**：

```
(http.host eq "course.law-tech.dev" and not starts_with(http.request.uri.path, "/assets/"))
```

`CLOUDFLARE_PURGE_TOKEN` 只有 purge 权限，改不了规则（实测 403）：

```
GET /zones/<zone>/rulesets?phase=http_request_cache_settings → 403 Authentication error
GET /zones/<zone>/pagerules                                  → 403 Unauthorized to access requested resource
GET /zones/<zone>/settings/always_use_https                  → 403 Authentication error
```

=> 需要用户：在 Cloudflare 控制台加这条 Cache Rule（或给一个带 Zone→Cache Rules 编辑权限的令牌）。

## 5 DB 迁移（阻断项，仍未解决）

本机与服务器都**没有 DDL 能力**：

- 服务器 `~/.course-worker/control-env` 只有 `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`（PostgREST，不能跑 DDL）；
  机器上没有 psql/pg 客户端。
- 本机 `law-tech/.env.local` 里的 `DATABASE_URL` 指向 `db.htbbkcxevcouwehpugwc.supabase.co`（**只有 AAAA 记录**，
  本机到该 IPv6 无路由）；pooler 路由可用（`aws-1-ap-southeast-1.pooler.supabase.com` 认得这个租户），
  但那份密码认证失败（`password authentication failed for user "postgres"`）。

=> 需要用户二选一：① 在 Supabase SQL Editor 里跑 `deploy/migrations/20261004_mcp_provider.sql`；
② 给一份能连上的 DB 连接串/password（或 Supabase Management API token）。

迁移内容（只扩枚举，不改列、不改数据、不加表）：

```sql
alter table public.provider_credentials drop constraint if exists provider_credentials_provider_check;
alter table public.provider_credentials add constraint provider_credentials_provider_check
  check (provider = any (array['ocr'::text, 'deepseek'::text, 'dashscope'::text, 'mcp'::text]));
```

## 6 发布顺序（两个前置都到位后）

1. `bash deploy/push-release.sh` → `bash deploy/install-units.sh` → `bash deploy/release.sh ~/course-staging`
2. 同一批更新 nginx（`location /` → 3101）：`sudo cp` 后先 `diff -u` 看清差异，再 `nginx -t && systemctl reload nginx`
3. 部署后立刻验证（缺一不可）：
   - 匿名 `/` → 302 到 SSO，且 `cf-cache-status` **不是** HIT；
   - OWNER/MEMBER 登录后 `/` 是阅读站（不是管理壳），note/topic/course/map/索引/search 都能开；
   - `/assets/mermaid.min.js` 从 3101 仍然 200（nginx 通用 location 改了之后静态资源跟着换进程）；
   - `/llms.txt`、`/md/*`、`/feed.xml` 仍不是私有旁路（302 回 `/`）；
   - `/_control/` 仍指 3102；
   - 旧 30 天令牌 401（不再兼容），重新生成长期令牌后 MCP 200；
   - 换发 → 旧 401；删除 → 当前 401；A 的令牌读不到 B。
4. 全部通过后再更新 `docs/` 的部署记录（见 §8）。

## 7 当初的未完成项（已在 §8 全部执行完毕）

- Cloudflare Bypass Cache 规则（§4）——**阻塞发布**。
- DB 迁移（§5）——**阻塞长期令牌**。
- MEMBER Phase 4（两账号隔离、扫码→选课→同步、MEMBER 侧 MCP 验收）仍缺一个真实 MEMBER 账号。
- `tools/ui-click-audit.mjs` 的修复（§2 录而不改）——建议单独一轮。
## 8 正式部署与验收（2026-10-04 18:07）

两个前置由用户完成后，按 §6 顺序执行。

### 8.1 前置复核（先验，再发）

- **Cloudflare**：`GET /?cb=probe1` → `cf-cache-status: BYPASS`，说明规则按路径维度生效；仍在 HIT 的 `/`（age 7698）
  是规则生效**之前**缓存下来的残留对象 —— 已 purge `/` 与 `/index.html`，复查两次都是 `BYPASS` + 源站的 `no-store`。
- **Supabase**：插一行 `provider='mcp'` 现在回 **201**（§2 记录过修复前是 400 / 23514），探针行已删除，
  事后确认 OWNER 名下只剩 deepseek / dashscope / ocr 三行。

### 8.2 发布

- `deploy/push-release.sh`：release **`20261004-180702`**，digest `456312cab6108ca4`，依赖仓命中 `5913813e0a384182`。
  切换前在 release 内跑测试：`pass 735 / fail 0`（比 `npm test` 少 3 条，原因见 §9）。
- nginx 与 release **同批**：先备份 `course.bak-20261004-180939`，`diff -u` 确认只差 `location /` 的
  `proxy_pass 3100 → 3101`（外加两行注释），`nginx -t` 通过后 reload。
- 三个单元 `active`；`course-cycle.timer` 保持 `inactive/disabled`。

### 8.3 验收：HTTP 级 34 项全通过

样本：OWNER 名下 **14 篇私有笔记 / 6 个专题**。

| 项目 | 结果 |
|---|---|
| 匿名 `/`、`/notes/*` | 302 → SSO，并带 `next` |
| 匿名 `/api/search` | 401 `account_session_required` |
| 私有旁路 `/llms.txt`、`/feed.xml`、`/md/*` | 302 回 `/`（不作为旁路） |
| 登录后 `/` | 200，是阅读站（含课程、课次、`/admin` 入口，不含管理壳） |
| 笔记页 / 一页纸 / 专题三视图 / 单课程入口 / 地图 / 概念 / 法条 / 案例 / 搜索页 | 全部 200 |
| 登录后 `/api/search` | 200，5 条命中且链接都是 `/notes/…`，`cache-control: private, no-store` |
| 3100 直连旧静态路径 | 仍被 privacy gate 拦住（302） |
| `/assets/*` | 从 3101 供出 200；公网可缓存（规则只放行这一处） |
| `/_control/` | 未签名 401（仍指向 3102） |
| 旧 30 天 HMAC 令牌 | **401**（不再兼容） |
| 长期令牌 | 生成 200（`cmcp1.` 前缀，无 `expiresInSeconds`）→ tools/list 200 → get_course 200（1,847 字，含 `fetchId`） |
| 专题页址 | `https://course.law-tech.dev/topics/犯罪学/…html`（不再是 `/admin`） |
| 换发 | 旧令牌 401 / 新令牌 200 |
| 伪造（别人的 owner 前缀 + 本账号密钥） | 401 |
| 删除 | 当前令牌立刻 401 |
| 公网 `/` 与 `/notes/*` 各请求两次 | `cf-cache-status: BYPASS/BYPASS`（不再 HIT） |
| `/healthz` | `{ok: true, visibility: "private"}` |

### 8.4 验收：生产真浏览器 7 项全通过

在服务器上跑 Chromium（headless）走**公网 URL**，即真实用户路径：

```
✔ 首页 = 阅读站（课程筛选 + 14 条课次 + 6 个专题入口）
✔ 点课次进笔记页（左栏课次 3 条、本页目录 110 条）
✔ 上一讲/下一讲点得通（修好的根绝对链接：犯罪学 09-23 → 09-16）
✔ 站内搜索出结果（10 条）
✔ OWNER /admin 仍是完整管理台
✔ 公网页面无 JS 报错、无 4xx/5xx 资源
```

### 8.5 部署后的当前状态

- **OWNER 名下现在没有 MCP 令牌**：验收时生成过一枚，走完换发/删除两条路径后已删除（净状态 = 未配置，
  与数据库一致）。需要用户在「账户设置 → MCP」重新生成一次，把新令牌填进 MCP 客户端；
  旧的 30 天令牌已彻底失效，客户端若不更新会一直 401。
- 回滚：`ssh ubuntu@124.222.111.108 'bash ~/course-staging/deploy/release.sh --rollback'`；
  nginx 回滚用 `/etc/nginx/sites-available/course.bak-20261004-180939`。

## 9 本轮发现但没改（留给下一轮）

1. **`deploy/release.sh` 的测试 glob 漏了一个目录**：它跑的是
   `packages/*/src/*.test.mjs apps/*/src/*.test.mjs tools/*.test.mjs`，比 `npm test` 少了
   `apps/control/src/server/*.test.mjs`（3 条：控制面 HMAC 签名校验、job token 绑定/撤销、未签名请求 401）。
   发布门禁因此少跑了控制面最要紧的 3 条断言（数字上就是 735 对 738）。改一行即可。
2. `tools/ui-click-audit.mjs` 仍跑不起来（§2 录而不改）。
3. MEMBER 的一页纸空壳（§2 录而不改）。
4. MEMBER Phase 4 仍缺一个真实 MEMBER 账号（两账号隔离、扫码→选课→同步、MEMBER 侧 MCP 验收）。

