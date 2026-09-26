---
name: haoke-notes
description: 处理课程录音转写稿（SRT）和课件（PPT/PPTX），生成结构化的单课 Markdown 笔记和跨课程整合材料（知识图谱、整合版笔记、法条精读表、辨析表、案例练习库等）。当用户提到"好课"、"课程笔记"、"整理录音"、"SRT + PPTX"、"生成讲座笔记"，或上传 SRT + PPTX 文件想做笔记时使用。手动触发，不自动调用。
---

# 好课笔记生成器

从课程 SRT 转写稿 + PPTX 课件到结构化笔记的端到端系统。

## 运行前提

本 skill 单课撰写阶段需要较大上下文。开始前请确认 Claude Code 已切换到大上下文模式：

```
/model deepseek-v4-pro[1m]
```

如有 max effort 等级设置，也建议开启。

笔记生成会读取整篇转录稿做大纲规划，串行执行（不调用并行子 agent，以最大化 prompt cache 命中）。

## 三阶段概览

1. **数据预处理**（`workflow.py` 自动）：扫描排序文件 → SRT 转纯文本 → PPT 文字提取或 OCR → 切分转录稿
2. **单课笔记生成**（按 `references/note-writing.md`）：大纲驱动逐节点撰写，每节笔记一次定稿
3. **全课程整合**（按 `references/course-integration.md`）：渐进披露生成七类学习材料

## 工作前问卷

启动笔记生成（阶段 2）前先读 `references/preflight.md`，按其中的问卷与用户确认：老师姓名、讲课风格、学习目标（闭卷 / 开卷 / 论文 / 自学）、PPT 类型等。这些回答会缓存到 `working/preferences.json`，影响后续所有撰写策略。

## 快速开始

```bash
# Skill 安装目录由 Claude Code 自动管理，脚本通过 workflow.py 统一调度
SKILL_DIR=$(dirname $(realpath ~/.claude/skills/haoke-notes/workflow.py))

# 阶段 0：手动准备
#   将每节课的 SRT 和 PPT/PPTX 文件放入 课程目录/raw/
#   推荐文件名格式（格式 A）：
#     课程名 - YYYY-MM-DD第X-Y节 - 老师名_原文.srt
#     课程名 - YYYY-MM-DD第X-Y节 - 老师名_PPT.pptx

#   .ppt 格式不支持自动转换。如遇 .ppt，请提示用户用 PowerPoint / WPS / Keynote
#   手动另存为 .pptx 后再继续，不要尝试 libreoffice 等命令行工具。

#   其他文件名情况：
#   - 格式 B（课程名-老师名-日期第X-Y节）：scan_files.py 自动识别，可选 rename_files.py 转 A
#   - 32位 hex 乱码（如来自北大资源平台）：读 references/rename-from-links.md

# 阶段 1：数据预处理（一次性完成，支持 --resume 断点续跑）
python $SKILL_DIR/workflow.py run --dir ./课程目录

# 阶段 2：单课笔记 → 读 references/note-writing.md
# 阶段 3：全课程整合 → 读 references/course-integration.md
```

OCR 步骤需要 `ZHIPUAI_API_KEY` 环境变量（智谱 GLM-OCR）。如未配置，预处理会停在 OCR 步骤并提示。

## 文件名格式

`scan_files.py` 自动识别两种：

| 格式 | 结构 | 示例 |
|------|------|------|
| A（推荐） | `课程名 - YYYY-MM-DD第X-Y节 - 老师名_原文/PPT.ext` | `知识产权法 - 2026-03-05第10-12节 - 刘银良_原文.srt` |
| B（识别） | `课程名-老师名-YYYY-MM-DD第X-Y节_原文/PPT.ext` | `超级个体-刘建波-2026-03-02第10-11节_原文.srt` |

## 中文文件名注意

涉及中文文件名的 mv / rename / 批量重命名，请走 `rename_files.py`。Bash 在变量截取中文时按字节切，会破坏 UTF-8 多字节序列导致文件名永久损坏；Python `os.rename` 按字符串处理，安全。

`rename_files.py` 默认 dry-run，确认无误后加 `--apply` 执行。

## 目录结构

三层目录职责不同：

| 目录 | 职责 | 生命周期 |
|------|------|---------|
| `raw/` | 用户放入的 SRT + PPT/PPTX 原始文件 | 预处理前准备，之后只读 |
| `data/` | 预处理产出（转录文本、PPT 文字 / OCR、切分段） | 笔记生成前完成，之后只读 |
| `working/` | 过程中间文件 + 工作流状态 + 用户偏好 | 临时 |
| `output/` | 最终交付成果 | 永久保留 |

```
课程目录/
├── raw/                          # 用户手动放入的原始文件
├── .haoke_changelog.md           # 进度日志
├── data/
│   ├── ppt_images/               # 纯图 PPT 提取的幻灯片图片（ppt_N/ 子目录）
│   ├── transcripts/              # 纯文本转录（第N课.txt）
│   ├── ppt_md/                   # PPT 文字内容（第N课_ppt.md，文字提取或 OCR 产出）
│   └── segments/                 # 预切分段 + 元数据
├── working/
│   ├── preferences.json          # 用户问卷答案
│   ├── lesson_map.json           # 课次映射
│   ├── 第N课_outline.json        # 大纲（含转录行号映射）
│   ├── notes_第N课_node_*.md     # 节点级笔记
│   ├── index.json                # 整合阶段预索引
│   ├── concept_map.json          # 概念定位图
│   └── module_*.md               # 模块整合中间稿
└── output/
    ├── notes/第N课.md            # 单课笔记定稿
    ├── 知识图谱.md                # XMind 导入版（含法条/案例附录清单）
    ├── 概念追踪表.md
    ├── 整合版笔记.md
    ├── 法条精读表.md
    ├── 辨析表.md
    └── 案例练习库.md
```

## 参考文档（按需读取，不要预加载）

| 文档 | 何时读 | 内容 |
|------|--------|------|
| `references/preflight.md` | 阶段 2 启动时，先读 | 用户问卷与决策树（学习目标 / 讲课风格 / PPT 类型） |
| `references/note-writing.md` | 阶段 2 撰写每课时 | 大纲驱动写作流程：通读 → 大纲 + 行号映射 → 节点级撰写 → 拼装 |
| `references/course-integration.md` | 阶段 3 整合时 | 渐进披露：预索引 → 知识图谱 → 概念追踪 → 模块整合 → 法条精读 → 辨析表 → 案例库 |
| `references/asr-error-patterns.md` | 笔记撰写时遇到可疑术语 | 法学专业术语常见 ASR 错误修正参考表 |
| `references/rename-from-links.md` | 文件名是 32 位 hex 乱码时 | 对照下载链接合集重命名 |

## 脚本（通过 workflow.py 调度，少数独立运行）

预处理：`scan_files.py`、`parse_srt.py`、`extract_ppt.py`（文字提取 / 纯图判断）、`extract_slides.py`（纯图 PPT 拆图）、`ocr_ppt.py`（GLM-OCR）、`split_transcript.py`

整合：`build_index.py`、`locate_concepts.py`、`extract_module.py`、`merge_outputs.py`

工具：`rename_files.py`、`rename_from_links.py`、`verify_notes.py`（笔记格式自检）

备用流程（输入是 URL 而非 SRT/PPTX）：`optional/tingwu/`，参考其 README

## Changelog

`.haoke_changelog.md` 记录进度。状态：`✅` 完成 `🔄` 进行中 `❌` 失败 `⏳` 待处理。中断时找最近的 `🔄` 即断点，从那里 `--resume`。
