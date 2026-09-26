# 从链接合集重命名乱码文件

## 适用场景

从北大资源平台（或其他类似平台）下载录播文件后，SRT/PPT 文件名是 32 位 hex hash 串，无法直接识别课次。需要对照下载链接合集文件，将文件名重命名为上课日期。

## 触发条件

`raw/` 中的文件名不匹配标准格式 A/B，且呈现以下特征：

- 文件名包含 32 位十六进制字符串（如 `E7D01B48C10A2F7E4D5082F90C3201C8`）
- 文件名中包含 `.mp4_` 字样（如 `xxx.mp4_PPT.pptx`、`xxx.mp4_原文.docx`）

## 处理流程

### Step 1：确认链接合集文件存在

链接文件通常是无扩展名文件或 `.txt` 文件，放在课程目录中。文件名随意（如 `下载源`、`links.txt`）。

判断标准：读文件内容，包含 `http` 和 `.mp4` 的 URL 即是。

如找不到，提醒用户把链接合集文件放入课程目录。格式示例：

```
http://resourcese.pku.edu.cn/play/video/vod/httpDownload/Source/2025/02/20/E7D01B48C10A2F7E4D5082F90C3201C8.mp4
http://resourcese.pku.edu.cn/play/video/vod/httpDownload/Source/2025/02/27/761F666573DBFF32B51C4BA661064BAC.mp4
```

### Step 2：运行重命名脚本

```bash
# dry-run 预览
python $SKILL_DIR/scripts/rename_from_links.py --dir ./课程目录

# 确认无误后执行
python $SKILL_DIR/scripts/rename_from_links.py --dir ./课程目录 --apply
```

如链接文件不在 `--dir` 中，可用 `--link-file` 显式指定：

```bash
python $SKILL_DIR/scripts/rename_from_links.py --dir ./raw --link-file ./下载源 --apply
```

### Step 3：验证结果

重命名后文件变为：

```
2025-02-20_原文.docx
2025-02-20_PPT.pptx
2025-02-27_原文.docx
2025-02-27_PPT.pptx
```

### Step 4：补充课程名和老师名

`rename_from_links.py` 只能从链接中提取日期，无法知道课程名和老师名。重命名为日期格式后，仍需进一步处理为标准格式 A：

```
课程名 - YYYY-MM-DD第X-Y节 - 老师名_原文.srt
```

可手工批量重命名，或写一个简单脚本（在 `working/` 中临时使用）按用户提供的课程名/老师名补充前后缀。这一步不在工具链内自动化，因为节次（第 X-Y 节）信息只在用户脑子里。

## 脚本工作逻辑

1. 在 `--dir` 及其父目录中搜索链接合集文件（或使用 `--link-file` 显式指定）
2. 解析链接：匹配 `Source/YYYY/MM/DD/{32位hex}.mp4` 结构，建立 `{hash → YYYY-MM-DD}` 映射
3. 扫描目录中的文件，提取文件名中的 32 位 hex hash
4. 匹配映射表，生成新文件名 `{日期}_{类型}.{扩展名}`
5. 检查目标文件名冲突、已有文件覆盖，安全后执行

## 安全规则

- 默认 dry-run，必须加 `--apply` 才执行
- 重命名前检查目标文件名冲突
- 不用 bash 操作中文文件名，所有操作走 Python（按字符串处理，不会破坏 UTF-8 多字节序列）
