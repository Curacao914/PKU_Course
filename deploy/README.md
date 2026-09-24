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
```

## 待建（后续步骤）

- `course-site.service`：站点与私有管理台，端口 3100，由隧道 `course.law-tech.dev` 指向。
- `course-worker.timer`：定时执行发现 → 下载 → 转录 → 笔记 → 发布 → 推送。
- 磁盘下限检查：空闲低于设定值时拒绝开始下载（旧系统用 `COURSE_WORKER_MIN_FREE_BYTES`，默认 5GiB）。
