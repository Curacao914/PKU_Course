# 听悟 URL 转录备用流程

当输入是录播 URL（而不是已下载的 SRT/PPT 文件）时使用。调用阿里云听悟 API 提交转录任务、轮询结果、下载 TextPolish 输出，再转为 transcripts 文本。

**默认不使用**：API 调用费用较高，主流程优先用已下载的 SRT。仅在 raw/ 目录中没有 SRT 文件、只有视频 URL 时考虑此流程。

---

## 触发条件

- 用户明确要求使用听悟 URL 转录
- 或：raw/ 中只有 mp4 / URL 文件，没有 SRT 文件

主流程（workflow.py）不会自动调用本目录的脚本。需要用户在对话中明确指示，或手动运行。

---

## 环境准备

```bash
# 安装依赖
pip install -r optional/tingwu/requirements.txt

# 配置环境变量
export ALIBABA_CLOUD_ACCESS_KEY_ID=...
export ALIBABA_CLOUD_ACCESS_KEY_SECRET=...
export TINGWU_APP_KEY=...
```

---

## 脚本

| 脚本 | 用途 |
|------|------|
| `submit_tasks.py` | 提交转录任务，返回 task_id |
| `poll_results.py` | 轮询任务状态，下载 TextPolish JSON |
| `process_transcript.py` | TextPolish JSON → 纯文本 transcripts |

---

## 典型用法

```bash
# 1. 提交任务
python optional/tingwu/submit_tasks.py --dir ./课程目录

# 2. 轮询并下载
python optional/tingwu/poll_results.py --dir ./课程目录

# 3. JSON → 文本
python optional/tingwu/process_transcript.py \
    --dir ./课程目录/working/tingwu_raw \
    --output ./课程目录/data/transcripts

# 之后接回主流程：跑 split
python workflow.py split --dir ./课程目录
```

---

## 与主流程的衔接

听悟流程产出 `data/transcripts/第N课.txt`（与 SRT 路径产出格式相同），后续 `split_transcript.py` / `build_index.py` 等脚本无需修改。

PPT 由听悟提取的关键帧另行下载，放入 `data/ppt_images/ppt_N/`，然后跑：

```bash
python workflow.py ppt --dir ./课程目录
```

`ppt` 子命令会直接走 OCR 路径（图片输入）。

---

## 维护说明

本目录与主流程**完全独立**：

- 主 `requirements.txt` 不引用本目录依赖
- 主 `workflow.py` 不 import 本目录脚本
- 主 SKILL.md 仅在末尾"备用流程"段引用本目录

更新主流程时不需要同步更新此处。如废弃此备用流程，整个目录可直接删除而不影响主流程。
