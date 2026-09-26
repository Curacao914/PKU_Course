# 阶段 2 启动前的用户问卷

阶段 2（单课笔记生成）启动前，先完成本问卷与用户确认。答案缓存到 `working/preferences.json`，影响所有后续撰写策略。

如 preferences.json 已存在，先读取并向用户复述当前设置，询问是否需要调整；用户确认无需调整后跳过本问卷直接进入阶段 2。

---

## 问卷流程

### 1. 老师姓名

如果 lesson_map.json 中已自动从文件名解析出老师姓名，向用户复述确认即可。

如未解析出（罕见情况），询问老师姓名。

### 2. 讲课风格

询问用户：

- **是否严格按 PPT 顺序讲解**（影响大纲生成时是否需要跨 PPT 重组）
- **是否容易发散**（涉及大量个人轶事、时事评论、跨学科类比）
- **是否有课前提问 / 复习环节**（这部分需归入附录或单独处理）
- **法条引用是否密集**（影响 META 标签的 PROVISION 数量预期）

四题独立回答，每题简短。

### 3. 学习目标

四选一：

- **闭卷应试**：考试需要默写法条、识记定义、应用知识点
- **开卷应试**：考试可带笔记，重点是快速翻查
- **论文 / 研究**：写期末论文或学术研究，需要学说争议和文献线索
- **自学 / 入门**：未跟课，新接触这个领域，需要循序渐进

如用户回答介于多个之间（如"主要是闭卷，但也想学好"），按主要场景选择并在 `preferences.json` 中标注次要目标。

### 4. PPT 类型

每节课的 PPT 文件可能是：

- **带文字 PPT**（python-pptx 可直接提取文字）
- **纯图 PPT**（需要 GLM-OCR 识别）
- **混合**（部分页带文字、部分页纯图）

`extract_ppt.py` 会自动判断并选择路径，但用户的预先告知可以加快预处理。如用户不确定，按"自动判断"处理即可。

### 5. 课程基本信息

询问：

- **课程名称**（如 lesson_map.json 已解析则复述确认）
- **总课次数**（用户自己知道的话告诉我们；不知道也可，用 lesson_map.json 的实际数）
- **课程领域**（法学 / 计算机 / 人文 / ...）：影响 ASR 错误纠正的术语库选择

### 6. 其他偏好（可选）

- 是否需要英文术语对照（适合外文文献多的学科）
- 是否需要图表化表达（如时间线、对比矩阵）
- 是否有特殊的术语偏好（如某些译名的固定写法）

---

## preferences.json 结构

```json
{
  "course_name": "知识产权法",
  "teacher": "刘银良",
  "total_lessons": 15,
  "domain": "法学",
  "teaching_style": {
    "follows_ppt_strictly": false,
    "tends_to_digress": true,
    "has_warmup_questions": true,
    "dense_legal_references": true
  },
  "learning_goal": "闭卷应试",
  "secondary_goal": "自学",
  "ppt_type": "auto",
  "preferences": {
    "include_english_terms": true,
    "prefer_visual_tables": true,
    "term_overrides": {
      "Trennungsprinzip": "区分原则"
    }
  }
}
```

字段说明：

- `learning_goal`：必填，四选一字符串
- `secondary_goal`：可选，仅当用户跨场景时填写
- `ppt_type`：`auto` / `text` / `image` / `mixed`
- `teaching_style.*`：四个布尔字段，决定大纲生成策略
- `term_overrides`：用户指定的术语固定写法

---

## 应用到撰写

阶段 2 的步骤 A 第一步即读取 `preferences.json`。具体应用：

| 字段 | 影响 |
|------|------|
| `learning_goal` | 决定每节笔记的详略侧重，详见 `note-writing.md` 学习目标定向章节 |
| `teaching_style.follows_ppt_strictly` | true 时大纲严格按 PPT 顺序；false 时允许跨 PPT 重组 |
| `teaching_style.tends_to_digress` | true 时附录段更详细，发散内容预期更多 |
| `teaching_style.has_warmup_questions` | true 时提醒模型识别开头的复习/提问段并归入附录 |
| `teaching_style.dense_legal_references` | true 时 PROVISION META 标签数量预期较高，提醒模型不要遗漏 |
| `domain` | 影响 ASR 错误纠正策略（asr-error-patterns.md 中的法律术语表只在 `domain == "法学"` 时启用） |
| `term_overrides` | 撰写时遇到这些术语时统一用用户指定的写法 |

阶段 3 整合时同样读取 `preferences.json`，详见 `course-integration.md` 学习目标定向章节。

---

## 何时重新询问

下列情况触发重新询问：

- 用户主动要求（"我想换成开卷应试"）
- 课程进行到一半时用户改变学习目标
- 切换到新课程（每个课程目录有自己的 preferences.json）

不要在每节课撰写前都重复问一遍——一次设定，后续静默使用。
