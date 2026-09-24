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
| Chromium | Playwright 自带版本，路径写入 `COURSE_CHROME_PATH` |
| Cloudflare Tunnel | 已存在，本地托管；`course.law-tech.dev` 复用同一条隧道 |

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
