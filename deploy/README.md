# 部署

## 目标形态

```
腾讯云 124.222.111.108（2 vCPU / 1.9G / 39G，Ubuntu 24.04）
├── /home/ubuntu/course-runtime      → 符号链接，指向 ~/releases/course/<时间戳>（原子切换）
├── /home/ubuntu/releases/course/    每次发布一个完整目录；.history 记成功发布、.history-failed 记失败
├── /home/ubuntu/deps/course/        依赖仓：按 package-lock.json 的哈希缓存（只增不改）
├── /home/ubuntu/.course-worker/     worker 状态：env(0600)、env.public、browser-profile、replays/
├── course-site.service              公开站点（role=public，127.0.0.1:3100，无任何机密）
├── course-admin.service             管理台 + worker 触发口（role=admin，127.0.0.1:3101，完整环境）
├── course-cycle.timer               定时闭环（扫描 → 推进 → 通知）
├── openclaw-gateway.service         已存在，不动
├── law-tech-cloudflared.service     已存在，不动（复用其隧道接入 course.law-tech.dev）
└── law-tech-wechat-relay.service    已存在，不动
```

## 首次部署

```bash
./deploy/deploy.sh                      # 同步代码 + 装依赖 + 跑 doctor
ssh ubuntu@124.222.111.108
cp /home/ubuntu/course-runtime/deploy/course.env.example ~/.course-worker/env
chmod 600 ~/.course-worker/env
vim ~/.course-worker/env                # 填 PKU_*、DASHSCOPE_API_KEY、R2_*、COURSE_CHROME_PATH
node /home/ubuntu/course-runtime/apps/worker/bin/course.mjs doctor
```

`doctor` 只报告每个凭据是 `set` 还是 `missing`，永远不会回显取值。

## 两个服务与它们的单元（仓库是唯一来源）

生产上跑**两个进程、两份环境**：

| 服务 | 角色 | 监听 | 环境文件 | 里面有什么 |
|---|---|---|---|---|
| `course-site.service` | `public` | `127.0.0.1:3100` | `~/.course-worker/env.public` | 只有站点目录这类公开配置，**没有任何机密** |
| `course-admin.service` | `admin` | `127.0.0.1:3101` | `~/.course-worker/env`（0600） | PKU / 百炼 / R2 / 管理令牌 / 账本 / 能触发 worker |

这样"公开接口被攻破"与"管理凭据泄露"不再是同一件事。三条硬约束：

- 单元里**显式**写死 `COURSE_SITE_ROLE`。systemd 启动时若没有这个变量，`serve.mjs` 直接拒绝
  启动（按 `INVOCATION_ID` 判断），因为退回 `all` 会把管理台挂到公开端口上并加载全部机密。
  本地手工 `node apps/site/bin/serve.mjs` 仍然允许省略——那只是本机开发。
- 公开进程的环境文件里不许出现机密。自查：
  `grep -Ei 'password|token|secret|key' ~/.course-worker/env.public`（应当没有输出）。
- 站点搜索与 MCP 的请求预算（限流/并发/超时/查询长度）由 `env.public` 配置，
  见 `deploy/env.public.example` 与 `docs/12` §7.3.1。

安装/更新单元（幂等，改完单元跑一次）：

```bash
ssh ubuntu@124.222.111.108
cd ~/course-runtime
deploy/install-units.sh                 # 装/更新两个单元 + daemon-reload（不重启服务）
deploy/install-units.sh --restart       # 顺带 enable --now 并做健康检查
deploy/install-units.sh --dry-run       # 只看它打算做什么
```

脚本做四件事：把单元里的 `__NODE__` 换成服务器上真实的 node 路径；旧单元先留一份
`.bak-<时间戳>`；缺失时从 `deploy/env.public.example` 生成一份 `env.public`（**绝不覆盖**
已有配置）；最后 `daemon-reload`。单元里没有显式角色时它会直接拒绝安装。

nginx 反代见 `deploy/nginx-course.conf.example`（两个 server 块：`course.` → 3100，
`admin.` → 3101）。仓库不直接写 `/etc`：先 `cp`，再 `diff`，确认后
`nginx -t && systemctl reload nginx`。

## 发布（deploy/release.sh）

```bash
deploy/push-release.sh                  # 本机：rsync 到 ~/course-staging，并在服务器上发布
ssh ubuntu@124.222.111.108 'bash ~/course-staging/deploy/release.sh --rollback'   # 回滚
```

形状：

```
~/releases/course/<时间戳>/        每次发布一个完整目录（未改动的文件用 --link-dest 硬链接）
~/course-runtime -> 上面某个       符号链接；systemd 单元的 WorkingDirectory 不用改
~/deps/course/<锁哈希>/            node_modules 依赖仓：键是 package-lock.json 的哈希
~/releases/course/.history         成功发布历史（回滚只认它）
~/releases/course/.history-failed  失败记录（stage=deps|test|roles|health|rollback，只给人看）
```

七步，每一步都对应一种"发不出去就别发"的情形：

1. **先检查两个单元的角色**（site=public、admin=admin）：角色不对就在拷贝之前停手，
   不必等切换之后才发现服务起不来。
2. 拷贝到新 release；依赖按锁文件哈希从依赖仓**硬链接**进来——命中就不装，装一次多个
   release 共享（workspace 的相对符号链接只有在 release 目录里才解析得对，所以是硬链接
   而不是把依赖仓软链过来）。
3. 在 release 目录里跑全部测试（含 `tools/*.test.mjs`）；不通过就删掉这个目录、什么都不切换。
4. 切换符号链接：先建 `course-runtime.new`，再 `mv -T` rename——原子，不存在"链接指向空"的瞬间。
5. 重启**两个**服务并各做一次 `/healthz`；任一失败就自动 `--rollback` 回上一个成功版本。
6. 全部通过才写 `.history` 与 `.release-meta`（stamp / 目录指纹 digest / lockHash /
   每个服务的 role 与 health 结果）。
7. 清理：保留最近 `KEEP` 个 release（默认 3），并删掉没有任何 release 引用的依赖仓。

**回滚取的是"历史里最后一个不等于当前的版本"**，所以两种情形都对：手动回滚（当前是最后
一次成功发布 → 取它前面那条）与自动回滚（当前这次健康检查没过、压根没进历史 → 取历史最后
一条）。回滚成功后会把被回滚掉的那条从 `.history` 划掉，避免"回滚→失败→回滚"的乒乓。

发布脚本自己也有仿真测试：`node --test tools/deploy-sim.test.mjs`（已并入 `npm test`）。
它用 PATH 上的 shim 假装 systemctl/curl/npm/node，在临时 HOME 里真跑一遍：首次发布、
复用依赖仓、换锁文件、测试失败、健康检查失败自动回滚、手动回滚、单元角色写错。
**它上线就抓到三个真 bug**：`$VAR：` 紧跟中文让 bash 报 unbound variable、同一秒内二次
发布撞目录名（会 rsync 进正在跑的版本）、以及 `mv -T` 在 BSD/macOS 上会把新链接挪进旧目录
（表现为"发布成功但 course-runtime 还指着旧版本"）。

## 内容站点的一次性原子化迁移

代码 release（`~/course-runtime`）与内容 release（`~/.course-worker/site`）是两层不同的版本：
前者保证“程序更新失败不影响旧程序”，后者保证“**一轮内容构建失败不影响旧内容**”。

新代码合并后，生产上的 `~/.course-worker/site` 如果还是实体目录，普通 publish 会继续走兼容路径；
**不会因为部署新代码就自动迁移**。只在维护窗口做一次：

```bash
ssh ubuntu@124.222.111.108

# 1. 先停两个会读取 site/ 的进程。worker/timer 不必因此长期停掉，
#    但迁移这几秒内不要并发跑 publish。
systemctl --user stop course-site.service course-admin.service

# 2. 把旧实体目录原样搬成第一份 legacy release，并让 site 变成 symlink。
#    不跑模型、不重建页面、不发通知。
node ~/course-runtime/apps/worker/bin/course.mjs publish --migrate-site-root --yes

# 3. 恢复服务并验健康。
systemctl --user start course-site.service course-admin.service
curl -fsS http://127.0.0.1:3100/healthz
curl -fsS http://127.0.0.1:3101/healthz
```

迁移后的形状：

```
~/.course-worker/site -> site.releases/legacy-...
~/.course-worker/site.releases/
├── legacy-...       # 迁移前的原内容，完整保留
└── release-...      # 此后每次 publish 的完整快照
```

之后普通 `course publish` 与 `course publish --rebuild` 都会：

1. 在 `.staging-*` 生成完整站点；
2. 写入同一版本的 `library.json`；
3. 校验首页、公开索引、每篇 HTML/Markdown 与一页纸；
4. 再验一次发布库 revision，防并发覆盖；
5. seal 成 `release-*`；
6. 单次 rename 替换 `site` symlink。

因此内容层也具备“旧版或新版二选一”的提交语义。旧 release 暂不由 publish 自动删除：
先让维护与回滚策略积累一段真实运行数据，再决定保留数量，避免刚上线就把回滚余量清掉。

内容回滚也走同一事务入口，不要手工 rsync 半套文件：

```bash
node ~/course-runtime/apps/worker/bin/course.mjs publish --rollback-site --yes
```

它会选择当前版本之外最新的一份 release，先做完整性校验，再原子切换，并定向清理新旧两版涉及的
CDN URL。连续再执行一次会切回刚才那一版，因此每次都会在 JSON 输出里明确给出 `from / to`。

详细契约见 `docs/17-内容生命周期.md`。

## 服务器上已具备

| 组件 | 状态 |
|---|---|
| Node | v24.18.0 |
| Python | 3.12.3，仓库内 `.venv` 已装 boto3 |
| ffmpeg / ffprobe | 6.1.1（apt 安装） |
| sqlite3 | 3.45.1 |
| Chromium | 153.0.8010.12，位于 `~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`（658M），路径写入 `COURSE_CHROME_PATH` |

> **Chromium 必须从镜像装。** 官方 `npx playwright install` 会跳转到被墙的 Google CDN，
> 实测卡在 0% 不动；同时跑 npx 版与本地版还会互抢 `__dirlock`。
> 用 `./deploy/install-browser.sh`，它走 npmmirror（实测 22 MB/s）并先清残留。
> 已实测在这台 1.9G 内存的机器上以持久化上下文方式成功启动（`SMOKE OK`，启动后仍余 1.2G）。
| Cloudflare Tunnel | 已存在，本地托管；`course.law-tech.dev` 复用同一条隧道 |

## 服务器基线（2026-09-24 实测）

| 项 | 值 |
|---|---|
| 磁盘 | 50G 总，**8.3G 已用 / 39G 可用**（项目代码 62M、Chromium 658M、OpenClaw 原有占用在内） |
| 内存 | 1.9G 总，可用约 1.2G（openclaw 常驻约 277M） |
| journal | 已设上限：`/etc/systemd/journald.conf.d/99-course-limits.conf` → `SystemMaxUse=200M`、`SystemKeepFree=2G` |

**为什么设 journal 上限**：journald 默认上限是文件系统的 10%（这台机器约 5G），而内存只有 1.9G——日志攒到 5G 没有任何意义，但真出问题时会先把盘吃掉，而 swap 也在同一块盘上。收敛一次释放了 934M。

一次性清理（本次已执行，可随时重跑）：

```bash
sudo journalctl --vacuum-size=200M   # 释放约 934M
sudo apt-get clean                    # 释放约 152M
npm cache clean --force               # 释放约 380M
```

## 图片文字识别（OCR）

有些课件整页就是一张图（或干脆是扫描件）：XML 里没有文字、pdftotext 也抽不出来，
笔记会凭空少一块。这类页用 PaddleOCR-VL 识别后并回课件文本。

| 项 | 值 |
|---|---|
| 令牌 | `PADDLEOCR_ACCESS_TOKEN`（写在 `~/.course-worker/env`，与其它凭据同一个文件） |
| 接口 | `https://paddleocr.aistudio-app.com/api/v2/ocr/jobs`（异步：提交 → 轮询 → 下载 JSONL），可用 `PADDLEOCR_DOC_PARSING_API_URL` 覆盖 |
| 模型 | `PaddleOCR-VL-1.6`（**名字必须与官方当前版本一致**：写错时提交会成功、任务却一直 pending，不报错，最难查；可用 `PADDLEOCR_MODEL` 覆盖） |
| 实测 | 一页幻灯片约 4 秒；免费额度 10000 页/天 |
| 依赖 | 只用 Python 标准库（multipart 自己拼）；PDF 渲染图片另需 `poppler-utils`（已装） |

流程上刻意分成两步：**归档入库只解析文字、顺手数出"哪些图要识别"**（秒回，上传请求等不起），
识别单独走 `course materials --ocr`——一张图几秒，一份 80 页课件要几分钟。
写笔记时若发现某份课件几乎抽不出文字（图片版），会自动先补识别再动笔。

## 手动运行各环节

```bash
COURSE=/home/ubuntu/course-runtime/apps/worker/bin/course.mjs
node $COURSE doctor                                      # 体检
node $COURSE discover --course 刑法分论                   # 列出本学期回放
node $COURSE discover --out ~/.course-worker/catalog.json # 落盘完整目录
node $COURSE download --course-key <键> --replay-key <键>  # 下载一节课
node $COURSE transcribe --media <media.mp4> --course 刑法分论 --lesson 第10-12节
node $COURSE status                                       # 各阶段任务数与明细
node $COURSE materials --file 第3讲.pptx --course 商法概论 --lesson 第1-2节 --ocr   # 归档课件并识别图片文字
node $COURSE materials --ocr --course 商法概论 --lesson 第1-2节                     # 只补还没识别的图
```

**账本语义**：`discover` 把发现的回放幂等登记进账本（重复扫描只更新展示字段，不动进度）。
`download` / `transcribe` 若带上 `--replay-key` 且账本里已有该回放，会先**领取任务**再执行：

- 成功 → 推进到 `downloaded` / `transcript_ready`，并记录阶段事件与产物路径；
- 失败 → **阶段不推进**，写入失败原因并退避 5 分钟（退避期内不会被重复消费）；
- 任务已被别的进程领取 → 直接拒绝执行，提示 `leased`；
- 账本里没有该回放 → 按独立运行处理，并在 stderr 明确说明"不记录阶段"。

手动跑单节课的标准顺序：`discover` → `status` 拿到 `replayKey` → `download --replay-key` → `transcribe --replay-key`。

## 站点（已上线）

```
https://course.law-tech.dev  →  Cloudflare Tunnel  →  localhost:3100  →  course-site.service
```

| 项 | 值 |
|---|---|
| 服务 | `course-site.service`（user systemd，已 enable） |
| 监听 | `127.0.0.1:3100`，**不对外开端口**，只经隧道暴露 |
| 站点目录 | `~/.course-worker/site`（`index.html`、`notes.json`、`notes/<课程>/<课次>.html`） |
| 发布库 | `~/.course-worker/site/library.json`——发布记录，重新生成站点不需要重跑模型 |
| 隧道配置 | `~/.cloudflared/config.yml`（改动前备份为 `config.yml.bak-<时间戳>`） |
| DNS | CNAME `course.law-tech.dev` → `<隧道ID>.cfargotunnel.com`（由 `cloudflared tunnel route dns` 建立） |

**验证过的行为**（2026-09-24）：

```
GET  /healthz          → {"ok": true, "notes": 0}
GET  /                 → 200 text/html
GET  /api/notes        → 200 application/json
GET  /api/admin/ping   → 503  （未配置令牌时 fail closed，而非放行）
GET  /does-not-exist   → 404
路径穿越尝试            → 400（Cloudflare 层即拦截）
```

**改隧道时的注意**：重启 `law-tech-cloudflared` 会短暂中断**所有**隧道域名，
包括 `cli.law-tech.dev`。改完务必复查 openclaw-gateway / relay / readyz 三项。
本次改动后三项均正常。

## 微信推送（已打通）

```
course-notify.service  →  每 30 秒读一次本机账本  →  openclaw message send --channel openclaw-weixin
```

| 项 | 值 |
|---|---|
| 服务 | `course-notify.service`（user systemd，已 enable，`notify --loop`） |
| 队列 | 本机账本 `deliveries` 表——**不经过任何远端接口** |
| 目标 | `COURSE_WECHAT_TARGET`（取自 OpenClaw 的配对状态，写入 `~/.course-worker/env`） |
| 探测 | `course notify --probe` 用 openclaw 的 dry-run 验证通道，不发真消息 |

**必须同时设置 `OPENCLAW_HOME` 与 `OPENCLAW_STATE_DIR`。** 实测对照：

```
只设 OPENCLAW_HOME            → Error: Unknown channel: openclaw-weixin
HOME 与 STATE_DIR 都设        → 正常返回 {"action":"send", ...}
```

插件与账号状态分别从这两个目录解析，只设一个时通道不会被注册。relay 的 systemd 单元
也是两个都设，这正是它能工作的原因。

**首条真实投递已验证**（2026-09-24）：`status=sent`，
`externalId=openclaw-weixin:1790262057530-b0b1fafc`。

### ⚠️ 这条通道发不出"主动推送"（2026-09-26 查清）

**症状**：账本里 21 条投递全是 `sent`（还有 externalId），用户手机一条没收到。

**原因**：这个微信机器人通道的规矩是——**用户每给机器人发一次消息，平台发一个
`context_token`，出站消息必须原样带上**。插件的"回复"路径会去取它，但 CLI / 定时任务
这种**主动推送**路径不会：

```
sendWeixinOutbound: contextToken missing for to=o9cq…@im.wechat, sending without context
```

没有 context 时接口照样返回 messageId，所以"发送成功"是假的。用户上次给机器人发消息是
9-24 23:14，之后的每一条都没送达。

**两手处理**：

1. `deploy/patch-weixin-context.sh`：让主动推送回退使用已存的 context_token（幂等，插件升级后重跑）。
   实测：补丁后网关日志不再出现 missing，但**平台侧仍可能因为会话过久而丢弃**——
   所以不能只靠它。
2. **备用通道**（推荐）：配一条不依赖会话的通道，主通道会话过期时自动改走它。
   在管理台「设置 → 运行参数」里选通道即可：`wecom` / `dingtalk` / `feishu`（群机器人 webhook，
   填"备用通道地址"）、`serverchan` / `pushplus`（填"备用通道密钥"）、`bark`、`generic`（自建接口）。
   配置写在 `~/.course-worker/config.json`（0600）；也可以在 `~/.course-worker/env` 里写
   `COURSE_NOTIFY_FALLBACK` / `COURSE_NOTIFY_FALLBACK_URL` / `SERVERCHAN_SENDKEY` / `PUSHPLUS_TOKEN`。

判定逻辑在 `packages/notify/src/session.mjs`：会话超过 **12 小时**没有互动就判为过期，
**直接改走备用通道**——而不是先往微信试一次（那会继续产生"账本说成功、手机没有消息"的假记录）。
管理台「概览 → 推送通道」把两个通道的状态都显示出来。

### 会话过期：先显示清楚，再谈自动（结论：**自动激活做不到**，2026-09-28）

管理台「概览 → 推送通道」不再只写"最近互动 23 小时前"让人自己算，而是把结论写出来：

| 状态 | 显示 |
|---|---|
| 12 小时内有互动 | `微信机器人 可用` ＋ `最近互动 2 小时前` |
| 超过 12 小时 | `微信机器人 已过期`（warn 色）＋ `已过期（超过 12 小时）：最近互动 23 小时前` ＋ 一句恢复办法 |

**能不能自动重新激活？不能。** 依据（本机核实过 CLI 与官方文档）：

1. `openclaw channels login --channel openclaw-weixin` 是**扫码登录**——OpenClaw 官方文档
   （`docs/channels/wechat.md`）写明要用手机扫码并确认；放在定时任务里跑它只会一直挂着等。
2. 出站要带的那份 `context_token` 由微信随**用户的入站消息**下发、存在网关进程里；
   CLI 没有刷新/重建它的子命令（`message send|read`、`sessions`、`devices`、`pairing` 都不行）。
3. 本机 CLI 因**设备授权未批准**而回退到本地处理（见上面的诊断），本地实例根本没有这份凭证。

所以代码里做的是**判定 + 记录**，不假装尝试：`apps/worker/src/wechat.mjs` 给出结论、依据与提示，
`cycle` 与 `notify` 每轮都会把结果写进 stderr 与运行摘要（运行历史里能看到 `wechat.attempted = false`
与 `wechat.evidence`）。恢复会话的动作仍然由人完成：

- 最省事：**给微信机器人发一条消息**，窗口立刻打开；
- 通道整体不可用（设备授权被撤销）：在服务器上重新扫码登录
  `openclaw channels login --channel openclaw-weixin`，或按 `docs/03` 用 SSH 隧道打开 Control UI
  批准待处理设备；
- 长期方案仍是配一条不依赖会话的备用通道（见上面「两手处理」第 2 条）。

### 顺带发现：既有 relay 一直在失败

`law-tech-wechat-relay.service` 的日志里密集出现 `[wechat-outbound] fetch failed`——
它每轮轮询 `law-tech.dev` 的 outbound 接口都连不上，也就是说**旧的推送路径目前实际是断的**，
只是错误被记成一行 "fetch failed" 不容易察觉。新链路不依赖远端接口，因此不受影响。
旧 relay 是否停用，等新链路连续运行一段时间后再决定。

## 定时闭环（已启用）

```
course-cycle.timer  →  course-cycle.service  →  course cycle --max-tasks 5
                      （每天 07:30 / 19:30，错过的轮次恢复后补跑）
```

一轮 `cycle` 做的事：扫描教学网并幂等登记 → 按账本阶段逐条推进（下载 → 转录 → 笔记 → 发布）
→ 投递已排队的微信通知。它不自己实现任何一步，只是按阶段调用既有命令，因此**中断、
部分失败、重复运行都是安全的**。

| 设计点 | 说明 |
|---|---|
| 阶段驱动 | 每步成功才推进阶段；失败写入原因与退避时间，下一轮从最近成功的阶段继续 |
| 已发布任务不再领取 | `published` / `notifying` 不在可领取阶段里——否则 worker 会反复领到已完成的任务空转 |
| 跳过即失败 | 前置产物缺失时不静默跳过，而是记为 `ok: false`，让整轮以非零退出码结束 |
| 单 worker 自我续租 | 编排循环先领取、内部阶段命令再领取一次，同一 worker 重复领取视为续租而非冲突 |
| **没有课件就不自动跑** | 自动选任务时跳过"该课次没有任何课件"的课次（默认 `--require-materials 1`） |

**当前状态**：定时器已启用，但每轮都会在第一步停下并报告：

```json
{ "step": "discover", "message": "教学网会话失效，且未配置 PKU_USERNAME / PKU_PASSWORD" }
```

这是预期行为——填入凭据前，闭环无法真正跑通。

### 磁盘下限保护

开始下载前检查可用空间，低于 `COURSE_WORKER_MIN_FREE_BYTES`（默认 5 GiB）就停止，
并报出差额：

```
磁盘可用空间不足，已停止下载：当前 3.2 GB，低于下限 5.0 GB（差 1.8 GB）
```

为什么放在下载**之前**：一节课媒体有 1—2G 峰值，且 swap 与数据在同一块盘上——
写满不只是"下不了课"，而是整机开始出问题；中途失败还会留下半截分片要清理。

磁盘不足时 `cycle` 会跳过扫描与媒体处理，**但仍然把已排队的通知发出去**——
投递不占磁盘，没有理由一起停。`doctor` 会报告当前可用空间与下限。

### 没有课件就不自动跑（2026-09-28）

用户的要求是「没有上传课件就默认不跑，除非我在管理页点『立即跑这一节』」。实现如下：

| 情形 | 行为 |
|---|---|
| 定时 `cycle`（自动选任务） | 该课次没有任何课件 → **本轮不处理**：stderr 留一行说明，账本阶段一点都不推进（不领取、不消耗重试次数、不占租约），下一轮仍会重新判定 |
| 补传课件之后 | 下一轮 `cycle` 自动开始，不需要点任何东西 |
| 管理台课次行的「立即跑这一节」 | 带 `--require-materials 0`，**无课件也照跑**；结果里写明「无课件也照跑（显式指定这一节）」 |
| 管理台「跑一轮完整链路」 | 与定时任务一致，缺课件照样跳过（这个按钮做的事与定时器完全相同） |

判据是 `packages/materials` 的 `listMaterials`：本课次目录、`course/` 下的**全课程通用**
课件、以及别的课次用 `--applies-to` 声明**跨课次共用**的课件，**都算有课件**。

> 归档是按**课次标题**找的，而 `discover` 每轮都会用教学网上的标题刷新账本——
> 老师改了课次名之后，之前传的课件会对不上，系统就会当成"没有课件"（补传一次即可）。

显式开关：`course cycle --require-materials 0|1`（默认 `1`；`0` = 无课件也照跑）。
跳过与"跳过即失败"不是一回事：缺课件是策略，整轮退出码仍然是 0。

### 缺课件提醒（每晚 20:00）

```
course-ppt-reminder.timer  →  course-ppt-reminder.service  →  course ppt-reminder
```

列出**所有还没有课件的课次**（课程 · 课次 · 状态 · 管理台链接），正文只有一张表；
**一节都不缺就不发**（与 07:00 日报同一条原则：没变化就不打扰）。20:00 发出，
离 07:30 那一轮 cycle 还有一整晚，来得及上传。

安装（在服务器上，仓库已同步到 `~/course-runtime`）：

```bash
cp ~/course-runtime/deploy/course-ppt-reminder.service ~/course-runtime/deploy/course-ppt-reminder.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now course-ppt-reminder.timer
systemctl --user list-timers course-ppt-reminder.timer         # 看下次触发时间
systemctl --user start course-ppt-reminder.service             # 立刻跑一次（有缺的才发）
journalctl --user -u course-ppt-reminder.service -n 30         # 看结果
```

手动跑（测试时先干跑，不会发信）：

```bash
node apps/worker/bin/course.mjs ppt-reminder --dry-run
node apps/worker/bin/course.mjs ppt-reminder --to you@example.com
```

发信走与 07:00 日报**同一套** Resend 配置与邮件样式：
`RESEND_API_KEY` / `COURSE_DIGEST_FROM` / `COURSE_DIGEST_TO`（都在 `~/.course-worker/env`）。

### 配置传递的两个坑（已修）

1. **env 文件的值必须进 `process.env`**。采集运行时与部分子模块直接读 `process.env`，
   只把值留在配置对象里会导致它们看不到配置——表现为 `没有找到 Chrome/Chromium`，
   与真实原因毫无关系。入口处只填空缺地写回进程环境。
2. **采集运行时改为显式注入**（`executablePath` / `scratchRoot` / `profileDir` / 凭据），
   不再依赖进程环境。

## 管理台（已启用）

```
https://course.law-tech.dev/admin
```

浏览器打开后填**管理台密码**或服务器上的主令牌（凭据只存在本机浏览器，页面里不内嵌）。
两种凭据都能进：自己设的密码（存 scrypt 哈希，明文不落盘），以及环境变量里的主令牌——
**忘记密码时的找回路径**就是它，详见 `docs/10-管理台登录与找回.md`。

```bash
grep COURSE_ADMIN_TOKEN ~/.course-worker/env      # 读主令牌
node apps/worker/bin/course.mjs admin-passwd --status   # 看密码是否已设
```

| 区 | 能做什么 |
|---|---|
| 概览 | 待办（等你补课件的课次 / 卡住的课次 / 发送失败的通知）、账本阶段分布、余额与充值入口、最近运行 |
| 课程 | 课次表；每行可**重跑**（按已有产物推断回到哪一步）、**重新发布**、**跑一轮**；行内直接**上传课件并解析** |
| 笔记 | 逐模块状态（字数/状态/重写次数）+ **只重写这个模块**（可写要求） + 通知队列与失败重发 |
| 设置 | 扫描 / 跑一轮完整链路 / 投递通知 / 体检 / 备份 / 清理预演 / 清理并删除；运行参数表单；登录密码设置与清除 |

课次行里的「立即跑这一节」是**显式**跑这一节：它等价于
`course cycle --replay-key <键> --require-materials 0`，因此**不受**"缺课件就不自动跑"的限制；
「跑一轮完整链路」则与定时任务完全一致（缺课件跳过）。

**点下去必须当场有反应**：按钮置灰改字、顶部状态灯切到"正在运行"、右下角弹提示，
跑完再弹一条明确结果。清单里说"点了没反应"的是这一类问题，见 `docs/09` §9。

**每个按钮都有两层护栏**：`apps/site/src/admin.test.mjs` 逐条比对页面上的 `data-act`
与脚本里的处理分支；`npm run test:ui`（`tools/ui-click-audit.mjs`）用真 Chrome
把每个按钮点一遍并要求"必须当场有可见反馈"，同时核对发出去的 argv。
审计用的是假的 runCommand，**不会真的下载、调模型或删文件**。

改了页面模板之后不必重跑模型，一条命令重建全部页面：

```bash
node apps/worker/bin/course.mjs publish --rebuild     # 只读发布库重建站点，不发通知
```

**安全约定**（都有测试覆盖）：

- 未配置令牌时 `/api/admin/*` **一律 503**，不做「没配就等于开放」；
- 响应只出现 `set` / `missing`，且**只对字符串值脱敏**——布尔与数字是状态信息，
  例如 `pkuCredentials: false` 表示"未配置"，被改写成 `set` 会把「没配」显示成「配好了」；
- 登录失败按来源 IP 计数，5 次后窗口期内拒绝；
- **同一时刻只允许一次运行**：手动触发与定时任务撞车会互相抢租约，
  与其让它们竞争，不如直接返回 409 告诉调用方「正在运行中」；
- 控制台页面本身不含令牌（否则任何能访问页面的人都拿到令牌）。

手动运行走的是与定时任务**完全相同**的 CLI 入口，不存在两套行为。

## 网络架构（2026-09-27 定型）：读走边缘缓存，写走直连

实测把这条链路的瓶颈量清楚了：

| 路径 | 速度 |
|---|---|
| 服务器 → 国内镜像（同区域） | 151 MB/s |
| Mac → 服务器（SSH 上传方向） | 10 MB/s |
| 服务器 → Mac（下载方向） | 0.16–0.5 MB/s |
| 经 Cloudflare 隧道（两个方向都被它压） | 0.12–0.25 MB/s |

结论：这台上海的机器**入带宽很快、出带宽被压到 ~4 Mbps**；隧道最近的边缘在洛杉矶，
所以**读者下载**这一侧最慢。于是把两条路分开：

```
course.law-tech.dev  → Cloudflare（橙云）+ 隧道 + 缓存规则   ← 读者：命中边缘，不回源
admin.law-tech.dev   → A 记录直连 124.222.111.108:443        ← 管理台与上传：国内直连
cf.law-tech.dev      → Cloudflare（橙云）+ 隧道               ← 兜底入口
```

> **2026-09-28 更新（以线上为准）**：`course.law-tech.dev` 已经改成**直连**，不再走隧道——
> 隧道最近的边缘在洛杉矶，读者流量绕一圈被压到 100—250KB/s，直连是国内速度。Cloudflare
> 仍然负责 DNS 与证书续期的 DNS 验证，隧道留给 `cf.law-tech.dev` 兜底。两个直接后果：
> 上面那条"缓存规则"不再作用于 `course.*`（边缘不参与，回源开销由这台机器直接承担，
> 并发/限流闸门见 docs/12 §7.3.1）；`$remote_addr` 就是真实客户端，所以 nginx 的
> `$proxy_add_x_forwarded_for` 追加出来的最右一跳可信（服务端据此做每 IP 限流）。
> 线上 nginx 配置已抄回仓库：`deploy/nginx-course.conf.example`（改 nginx 前先 diff 它）。

| 组件 | 位置 | 说明 |
|---|---|---|
| nginx（系统服务，enabled） | `/etc/nginx/sites-available/course` | 443 TLS → 反代 `127.0.0.1:3100`；`client_max_body_size 256m`；`proxy_read_timeout 1800s`（管理台「跑一轮」要跑十几分钟） |
| 证书 | `/etc/letsencrypt/live/course.law-tech.dev/` | Let's Encrypt，DNS-01（Cloudflare 插件），certbot.timer 自动续期；覆盖 `course.` 与 `admin.` 两个域名 |
| Cloudflare API Token | `/root/.secrets/cloudflare.ini`（0600） | 权限：Zone DNS Edit + Zone Cache Rules Edit |
| 缓存规则 | Cloudflare → Caching → Cache Rules | `course.law-tech.dev` 下的 `/notes/ /concepts/ /statutes/ /cases/ /courses/ /search/ /assets/` 与 `/`、`/feed.xml`、`/notes.json` 设为可缓存，Edge TTL 1 天 |

**控制台必须走 `https://admin.law-tech.dev/admin`**：它触发的动作最长十几分钟，走 Cloudflare 会被
100 秒上限掐断；上传几十兆课件也只有直连跑得动。站点服务器会把 `course.law-tech.dev/admin`
**302 跳转**到直连域名，所以从任何入口点进来都会落到快的路上。

**实测**（2026-09-27）：20MB 课件分片上传 **16 秒（~1.25 MB/s）**，同一份文件走隧道时是 90 KB/s——快 14 倍；
服务器自身测试同一份文件 2 秒（~10 MB/s）。

出带宽的 4 Mbps 是**实例规格**决定的：要读者侧更快，只能在腾讯云控制台升公网带宽（要花钱）；
免费的办法就是上面那条缓存规则——静态站命中边缘后不再回源。

## 待建（后续步骤）

- **同机同用户的两个服务之间仍有文件权限上的边界**：公开进程以同一个 `ubuntu` 用户运行，
  理论上能读 `~/.course-worker/env`。彻底隔离需要独立的系统用户（`ProtectHome`/`ReadOnlyPaths`
  只能挡住文件系统布局的一部分，挡不住"同一个用户"这件事本身），且要配好 `COURSE_*` 环境
  与目录属主；在没做之前，公开进程里"没有机密"靠的是它**不加载**那份环境，而不是读不到。
- 微信出站消除会话窗口依赖（等 Control UI 批准设备）。
- `COURSE_ADMIN_TOKEN`：管理接口目前未配令牌，因此一律拒绝访问。接入管理台时一并配置。
- 磁盘下限检查：空闲低于设定值时拒绝开始下载（旧系统用 `COURSE_WORKER_MIN_FREE_BYTES`，默认 5GiB）。
