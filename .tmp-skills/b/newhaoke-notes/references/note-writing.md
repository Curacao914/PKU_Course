# 单课笔记撰写流程

将工作流产出的转录稿 + PPT 文字内容转化为结构化 Markdown 笔记。

> **本流程由脚本状态机强制驱动。** 每个阶段末尾都有一个 gate 脚本，未通过（exit 1）**不得**进入下一步。这不是建议，是硬约束 —— 脚本会拒绝跳步。设计目的就是防止"一次性把整课写完导致内容缩水"。历史教训：曾经全靠模型自觉分块，结果笔记从 14000 字缩到 7000 字。现在用脚本卡死每一步。

---

## 最重要的三条原则（先读这个）

1. **逐节点、逐回合撰写。** B 步骤每个 level-2 节点是**一次独立的撰写 + 校验回合**，写一个、校验一个、标记一个，再写下一个。**绝不**在一次输出里连续写完多个节点 —— 单次输出长度有限，连写必然压缩。

2. **C 步骤不重写正文。** 节点写完即定稿。最终笔记由 `assemble.py` **机械拼接**节点文件，模型在 C 步骤只产出"接缝段"的结构化 JSON（概览、章节总结、自测题、知识连接），**碰不到节点正文**。

3. **每步必跑 gate 脚本。** outline 后跑 `validate_outline.py`；每节点后跑 `verify_node.py` + `mark_node_done.py`；拼装跑 `assemble.py`；定稿跑 `splice.py` + `verify_notes.py`。任一脚本 fail 先解决再继续。

---

## 状态机总览

```
A. 通读全部 segments + PPT → 产出 outline.json
   gate: python validate_outline.py --dir <课程目录> --lesson <N>
         （校验节点粒度 <=180行、字段完整。fail 则拆细节点重来）
   then: python init_checklist.py --dir <课程目录> --lesson <N>
         （建节点 checklist 状态机）
   then: 向用户复述大纲，确认后进入 B

B. 主循环：按 checklist 的 nodes[] 顺序，对每个 pending 节点：
   1. 读该节点 transcript_lines 区间的转录 + ppt_pages 对应 PPT
      + 上一节点最后一段（衔接用）
   2. 撰写 -> working/notes_第N课_node_{id}.md
   3. gate: python verify_node.py --dir <课程目录> --lesson <N> --node-id {id}
            （校验字数比率、META、案例论证意义、星级。fail 则补全重来）
   4. python mark_node_done.py --dir <课程目录> --lesson <N> --node-id {id}
            （会再次强制 verify，通过才标 done。无法绕过）
   循环直到所有节点 done

   B+. 若节点 needs_subdivision（>=144行）：先在 outline 里按 level-3 拆，
       重跑 validate_outline + init_checklist，再逐子节点写。

C. gate: python assemble.py --dir <课程目录> --lesson <N>
         （准入检查：所有节点必须 done，否则 exit 1。
          然后机械拼接正文 + 抽取合并 META 折叠框，
          产出 working/第N课_assembled.md，含待填占位符）
   then: 模型产出接缝段 -> working/第N课_splice_inputs.json（结构化 JSON，非正文）
   then: python splice.py --dir <课程目录> --lesson <N>
         （把接缝 JSON 填进占位符 -> output/notes/第N课.md）
   gate: python verify_notes.py --note output/notes/第N课.md --dir <课程目录> --lesson <N>
         （定稿自检：格式 + 全文字数比率 + 概念覆盖率）
```

脚本路径：`SKILL_DIR=$(dirname $(realpath ~/.claude/skills/haoke-notes/workflow.py))`，脚本都在 `$SKILL_DIR/scripts/`。撰写在主进程串行完成，不调用并行子 agent（最大化 prompt cache 命中）。

---

## 步骤 A：通读 + 大纲

### A1. 读取输入

依次读取：

1. `working/preferences.json` — 用户问卷答案。不存在则先按 `references/preflight.md` 完成问卷
2. `data/segments/第N课_segments.json` — 段元数据，确认转录总行数
3. 全部 `data/segments/第N课_segment_M.txt` — 通读完整转录
4. `data/ppt_md/第N课_ppt.md` — PPT 文字内容

### A2. 识别讲授主线

读完后心里要有一条主线。常见展开逻辑：概念→原则→规则→适用→案例（抽象到具体）；历史沿革→现行规定→学说争议→实践问题（过去到现在）；理论框架→比较法→中国法→实务（一般到特殊）。主线决定整体结构。

### A3. PPT 与讲授顺序协调

**以 PPT 为基础框架**。老师讲课节奏不一，可能跳跃、不用 PPT 或一节用多份 PPT，纯按意识流顺序笔记会很乱。做法：

- 大纲骨架 = PPT 主题和逻辑顺序
- 每节点内容填充 = 老师在该话题上**实际讲授的逻辑**
- PPT 有但转录未涉及 → 标注"PPT 提及但未展开"
- 转录讲了但 PPT 未显示 → 仍纳入，归入语义最近的 PPT 节点
- 跨 PPT 反复呼应同一概念 → 归入首次系统讲解的节点，其他处仅交叉引用

用户问卷说明老师严格按 PPT 讲解则直接对齐；说明发散讲解则按上述以 PPT 为锚重组。

### A4. 切节点的核心约束

**每个 level-2 节点对应的转录不得超过 180 行**（`validate_outline.py` 会卡死）。一个 level-2 节点应该是**一个完整的小话题单元**（一个概念 + 其法条 + 其案例），通常 80–150 行转录。如果某主题转录很长，就拆成多个 level-2 节点，或用 B+ 的 level-3 细分。

切节点时同时识别重点信号并标星级：

| 等级 | 标记 | 判断标准 |
|------|------|---------|
| ★★★ | 核心必掌握 | 老师明确说"很重要/会考/必须记住"，或贯穿全课反复出现 |
| ★★ | 重要需理解 | 老师花较多时间讲解，或支撑核心概念的关键铺垫 |
| ★ | 了解即可 | 背景知识、扩展说明、举例性内容 |

重点信号词：「大家注意」「这个很重要」「考试可能会考」「所以我们可以总结出」「也就是说」「与此类似/不同」「换句话来说」。

### A5. 产出 outline.json

输出到 `working/第N课_outline.json`。**模型负责填 transcript_lines**（每节点对应的转录起止行号），脚本负责卡死 <=180 行：

```json
{
  "course_name": "知识产权法",
  "lesson_num": 3,
  "main_thread": "本课围绕著作权客体展开，从构成要件到作品类型再到不受保护的对象",
  "outline": [
    {"id": "1", "level": 1, "title": "一、著作权的客体",
     "section_summary": "讲什么是作品，含构成要件、类型、排除对象三层"},
    {"id": "1.1", "level": 2, "parent_id": "1",
     "title": "（一）作品的构成要件 ★★★",
     "transcript_lines": [15, 135],
     "ppt_pages": [4, 5, 6],
     "concepts": ["独创性", "可复制性", "思想表达二分法"],
     "provisions": ["著作权法第3条"],
     "cases": ["凤凰网诉天盈九州案"],
     "writer_brief": "三要件，重点讲独创性，引用凤凰网案展开独立完成+一定创造性"}
  ],
  "appendix_topics": [
    {"topic": "课堂管理：调课通知", "transcript_lines": [1820, 1845]}
  ]
}
```

字段说明：

- `transcript_lines`：该节点对应转录行号区间（含两端）。**B 步骤按此切片读取，必须 <=180 行**
- `title`：level-2 标题须含星级标记（★/★★/★★★），写在标题末尾
- `concepts/provisions/cases`：A 步骤识别，B 步骤撰写时确认并落实（`verify_node` 会检查 concepts 出现率、cases 论证意义）
- `writer_brief`：给 B 步骤的一句话写作提示
- `appendix_topics`：发散内容（课堂管理、闲聊、时事评论），C 步骤归入附录

### A6. 跑 gate + 用户确认

```bash
python $SKILL_DIR/scripts/validate_outline.py --dir <课程目录> --lesson N
```

通过后跑 `init_checklist.py` 建状态机。然后向用户输出：本课概述（2-3 句）、可读的大纲层级列表（不输出 JSON）、识别到的发散内容、当前课程的具体疑问。等用户确认或调整。如改大纲，更新 outline.json 后**重跑 validate_outline + init_checklist**，再进入 B。

---

## 步骤 B：节点级撰写（主循环）

读 `working/第N课_node_checklist.json`，按 `nodes[]` 顺序处理每个 `status == pending` 的节点。**一个节点一个回合。**

### B1. 单节点撰写

对每个节点：

1. **只读**该节点 `transcript_lines` 区间的转录文本（不读全文）
2. 读该节点 `ppt_pages` 涉及的 PPT 文字
3. 读上一个节点笔记的最后一段（衔接用，让本节开头自然承接）
4. 参照 `writer_brief`、学习目标，撰写完整笔记
5. 输出到 `working/notes_第N课_node_{id}.md`

如该节点 `needs_subdivision == true`（>=144 行），先做 B+ 细分。

### B2. 节点笔记内部结构

```markdown
（一）[节点标题] ★★★

[内容主体：概念解释、法条引用、案例分析、学说讨论]

> 老师强调：[强调内容，如有]

> ⚠️ **易混提醒**：[易混对比，如有]

> 💡 **理解难点**：[难点说明，如有]

META_FOR_NODE:
- CONCEPT: 独创性
- CONCEPT: 可复制性
- PROVISION: 著作权法第3条
- CASE: 凤凰网诉天盈九州案
- PITFALL: 思想 vs 表达
```

末尾 `META_FOR_NODE:` 块是临时收纳，`assemble.py` 会抽取去重合并到全文末尾折叠框。正文中**不嵌入** HTML 注释形式的 META。

### B3. 内容提取与重组

- **概念**：提取老师的定义/解释，有对比用表格或对比列表，标注其在知识体系中的位置
- **法条**：标注法律名称和条号、核心规定、适用范围条件、与其他法条关系
- **案例（六要素，缺一不可，`verify_node` 检查"论证意义"）**：① 案件名称/背景 ② 案情简介 ③ 争议焦点 ④ 裁判结果/法律适用 ⑤ 老师评论 ⑥ **论证意义**（老师为什么讲这个案例、对主线的论证作用）
- **学说争议**：列各方观点、论据、通说倾向

### B4. 标记策略

重点不要过度标记。只有老师确实明确强调、反复提及的内容才用 `> 老师强调` 块。不要在正文用加粗标"老师强调"。易混点用 `> ⚠️ **易混提醒**`，理解难点用 `> 💡 **理解难点**`，三种引用块并列、互不替代。

### B5. 跑 gate

```bash
python $SKILL_DIR/scripts/verify_node.py --dir <课程目录> --lesson N --node-id {id}
python $SKILL_DIR/scripts/mark_node_done.py --dir <课程目录> --lesson N --node-id {id}
```

`verify_node` fail 的常见原因：字数比率过低（缩水，去补全老师讲的细节）、缺论证意义、缺 META、缺星级。修好重跑。`mark_node_done` 会再次强制 verify，通过才标 done。

> **不要**在所有节点都没写完时就想着拼装。`assemble.py` 会拒绝。

---

## 步骤 B+：节点过大时的细分

节点 >=144 行（`needs_subdivision`）或 A 步骤切不下 180 行时：

1. 读该节点对应 PPT，识别 level-3 子节点（如「1. 独立完成」「2. 一定创造性」），对应 PPT 子标题或转录中的明显小节切换（"接下来看…"、"第二个要件…"）
2. 在 outline.json 里把该 level-2 节点拆成多个更小的 level-2 节点（每个 <=180 行）
3. 拆完**重跑 validate_outline + init_checklist**
4. 子节点撰写完检查衔接、合并 META 块、保留 level-3 标题（`1. XXX`）

---

## 步骤 C：拼装 + 接缝段

### C1. 机械拼装（脚本，模型不写正文）

```bash
python $SKILL_DIR/scripts/assemble.py --dir <课程目录> --lesson N
```

产出 `working/第N课_assembled.md`：节点正文已按 outline 顺序就位，META 折叠框已合并，留下占位符 `{{COURSE_OVERVIEW}}`、`{{H1_SUMMARY:id}}`、`{{H1_QUIZ:id}}`、`{{KNOWLEDGE_LINK}}`、`{{APPENDIX}}` 待填。

### C2. 产出接缝段 JSON

模型**只读 outline.json + assembled.md 的占位符上下文**（不重读节点正文，避免被诱导重写），产出 `working/第N课_splice_inputs.json`：

```json
{
  "course_overview": {
    "core_questions": ["理解类问题（Why/How/区别），3-5个"],
    "should_be_able_to": ["可验证学习目标，动词开头，3-5个"],
    "lecture_thread": "一段话概括核心主题和讲授脉络（>=60字）"
  },
  "h1_summaries": {
    "1": "一级标题1的总结段，2-3句（>=45字）",
    "2": "..."
  },
  "h1_quizzes": {
    "1": ["理解类问题", "对比类问题", "可选：应用类问题"],
    "2": ["..."]
  },
  "knowledge_link": {
    "inherits_from": "本课建立在哪些前置知识上（可空）",
    "lays_groundwork_for": [
      {"concept": "独创性", "use": "后续课程中的用途"}
    ],
    "next_lesson_preview": "如转录有提及（可空）"
  },
  "appendix": {
    "terms": [{"term": "...", "original": "...", "definition": "..."}],
    "topics": [{"title": "发散话题名", "content": "简略概括"}]
  }
}
```

要求：核心问题是理解类（Why/How/区别）非记忆类（What）；应当能够 3-5 个可验证不空泛；自测题每节 2-3 题，理解/对比类优先，无显著难点时 1-2 题即可；`lays_groundwork_for` 必填（即使第一课也要按课程体系推断）；`appendix` 无发散内容时 terms/topics 留空数组。

### C3. 填充 + 定稿

```bash
python $SKILL_DIR/scripts/splice.py --dir <课程目录> --lesson N
python $SKILL_DIR/scripts/verify_notes.py --note <课程目录>/output/notes/第N课.md --dir <课程目录> --lesson N
```

`splice.py` 把 JSON 填进占位符 → `output/notes/第N课.md`（接缝段过短会 fail，补全重跑）。`verify_notes.py` 做定稿自检（格式 + 全文字数比率 + 概念覆盖率）。通过即定稿。

定稿后可删节点中间文件 `working/notes_第N课_node_*.md`（保留 outline.json 和 checklist 用于复盘）。

---

## PPT 辅助 ASR 纠正

撰写遇到可疑的法律术语、专名、人名时，**先在该节点对应 PPT 文字中搜索** —— PPT 是老师准备的文字材料，没有 ASR 错误。转录与 PPT 字面不同时以 PPT 为准。只在 PPT 没提及该术语时，才回退到 `references/asr-error-patterns.md` 参考表 + 上下文推断。

---

## 学习目标定向

`preferences.json` 的 `learning_goal` 决定撰写策略（无此字段默认"闭卷应试"）：

**闭卷应试**：突出重点、考点用 `> 老师强调` 块；脉络精炼便于回忆框架；核心概念配 1-2 句记忆口诀（如有合适 mnemonic）；自测偏应用和对比；易混点 ⚠️ 块尽量穷尽。

**开卷应试**：详尽不删节；强索引（一级标题加锚点，术语/法条/案例反复出现时插"参见第X节"）；法条引用含完整条号分款；术语和老师措辞精确；"应当能够"可扩到 5-7 个。

**论文/研究**：学说争议加重，列每位学者具体观点和理由；老师学术倾向单独标注；比较法内容（外国法、罗马法、德日学说）保留细节；概念辨析倾向学理边界精细对比；文献线索列入附录。

**自学/入门**：按学习顺序、初学者视角；每个新概念前补"为什么需要它"；减少术语隐式假设、首次出现用通俗语言解释；案例论证意义写得更展开；脉络段说明本课在全课程中的位置。

---

## 撰写语言要求

**风格**：学术书面语不口语化；用"老师指出/强调/认为"引导语；细致记录老师观点（论证逻辑链、对学说的评价倾向、对法条适用边界的判断）。

**详略**：与主线相关详细展开，关系远的可简略，但都不遗漏必要信息点。

**连贯**：段落间加过渡句；每个子主题完整自成一体；核心 insight 深入讲解（还原老师论证过程，不只罗列结论）；内容完整性优先，不因重构大纲遗漏知识点。

**不确定内容**：据上下文最佳推断；无法确定标 `（转写不清，待确认）`；不编造。

**Markdown**：加粗标核心概念/术语/人名/法条名（不整段加粗）；引用块 `>` 用于老师强调/原话/结论；表格用于对比类；有序列表用于有顺序层级的内容；无序列表用于并列罗列；行内代码标文件名/术语原文/英文；分隔线用 `***`（非 `---`）。格式服务于阅读，判断标准是扫读时能否快速抓住重点和结构。

---

## 排错指南

| 脚本 fail | 原因 | 处理 |
|-----------|------|------|
| `validate_outline` 报节点超 180 行 | 节点切太大 | 拆成更细的 level-2 节点，重跑 |
| `validate_outline` 报缺字段 | outline 字段不全 | 补全 transcript_lines/title/writer_brief |
| `verify_node` 报比率过低 | 节点缩水 | 补全老师讲的概念/法条/案例/论证，重写该节点 |
| `verify_node` 报缺论证意义 | 案例没写为什么讲 | 给案例补"论证意义"段 |
| `mark_node_done` 拒绝 | verify 没过 | 先过 verify_node |
| `assemble` 报节点未完成 | 有节点没 done | 完成剩余节点的 verify + mark |
| `splice` 报接缝过短 | 概览/总结敷衍 | 扩写 splice_inputs.json 对应字段 |
| `verify_notes` 报全文比率低 | 整体缩水 | 检查是否有节点被压缩，回 B 步骤补 |

---

## changelog

`.haoke_changelog.md` 记录进度。节点级进度由 `node_checklist.json` 状态机维护（不靠模型自觉打勾）。中断时看 checklist 里哪些节点还是 `pending`，从那里继续。状态：`✅` 完成 `🔄` 进行中 `❌` 失败 `⏳` 待处理。
