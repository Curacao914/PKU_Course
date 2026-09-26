# 部署

## 目标形态

```
腾讯云 124.222.111.108（2 vCPU / 1.9G / 39G，Ubuntu 24.04）
├── /home/ubuntu/course-runtime      代码（rsync 同步，含 .venv）
├── /home/ubuntu/.course-worker/     worker 状态：env(0600)、browser-profile、replays/
├── course-site.service              ← 待建：course.law-tech.dev 站点
├── course-worker.timer              ← 待建：定时发现与处理
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

## 手动运行各环节

```bash
COURSE=/home/ubuntu/course-runtime/apps/worker/bin/course.mjs
node $COURSE doctor                                      # 体检
node $COURSE discover --course 刑法分论                   # 列出本学期回放
node $COURSE discover --out ~/.course-worker/catalog.json # 落盘完整目录
node $COURSE download --course-key <键> --replay-key <键>  # 下载一节课
node $COURSE transcribe --media <media.mp4> --course 刑法分论 --lesson 第10-12节
node $COURSE status                                       # 各阶段任务数与明细
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

### 顺带发现：既有 relay 一直在失败

`law-tech-wechat-relay.service` 的日志里密集出现 `[wechat-outbound] fetch failed`——
它每轮轮询 `law-tech.dev` 的 outbound 接口都连不上，也就是说**旧的推送路径目前实际是断的**，
只是错误被记成一行 "fetch failed" 不容易察觉。新链路不依赖远端接口，因此不受影响。
旧 relay 是否停用，等新链路连续运行一段时间后再决定。

## 定时闭环（已启用）

```
course-cycle.timer  →  course-cycle.service  →  course cycle --max-tasks 5
                      （每天 08:20 / 14:20 / 20:20，错过的轮次恢复后补跑）
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

## 待建（后续步骤）

- 微信出站消除会话窗口依赖（等 Control UI 批准设备）。
- `COURSE_ADMIN_TOKEN`：管理接口目前未配令牌，因此一律拒绝访问。接入管理台时一并配置。
- 磁盘下限检查：空闲低于设定值时拒绝开始下载（旧系统用 `COURSE_WORKER_MIN_FREE_BYTES`，默认 5GiB）。
