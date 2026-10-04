/**
 * 课程笔记的模型适配层：角色提示词、请求组装、响应解析、调用追踪。
 *
 * 从 my-blog-main 的 lib/course/aiAdapter.js 摘出，保留了原有的十段中文角色
 * 提示词与容错解析（去 think、代码围栏、平衡括号、裸控制符、尾逗号），
 * 两处改动：
 *   1. 环境与 fetch 改为可注入，测试无需网络与环境变量；
 *   2. 超时上限不再受 Vercel 函数 300s 生命周期约束，默认仍是 240s，
 *      但上限放宽到可配置（旧实现在 240s 处硬截断）。
 */
export const ROLE_MODEL_ENV = {
  grouping: 'COURSE_GROUPING_MODEL',
  brief: 'COURSE_BRIEF_MODEL',
  onepage: 'COURSE_ONEPAGE_MODEL',
  topicPlan: 'COURSE_OUTLINE_MODEL',
  topic: 'COURSE_ONEPAGE_MODEL',
  outline: 'COURSE_OUTLINE_MODEL',
  outlineRepair: 'COURSE_OUTLINE_MODEL',
  writer: 'COURSE_WRITER_MODEL',
  reviewer: 'COURSE_REVIEWER_MODEL',
  revision: 'COURSE_REVISION_MODEL',
  finalRevision: 'COURSE_REVISION_MODEL',
  splicer: 'COURSE_SPLICE_MODEL',
  finalReview: 'COURSE_FINAL_REVIEW_MODEL'
}

export const COMMON_RULES = `
你正在参与一个法律课程笔记工作流。只能完成本次指定阶段，不得越过大纲确认、节点写作、独立审查或最终检查。
所有结论必须以提供的课堂转录、课件和补充材料为依据。材料没有说明的内容不得补写为课堂事实、法条原文、案例事实或教师观点；存在不确定性时应明确标注。
输出必须是符合 RequiredOutputSchema 的单个 JSON 对象，不得添加 Markdown 代码围栏、解释性前言或额外字段。

写作纪律（成品笔记必须满足，逐条都有来由）：
1. 只写课程内容。不要写任何关于写作过程的话：不出现「节点」「本节点」「写作目标」「对应缺口」「待补写」「尚未完成」「占位」这类字样，也不要写「本节点小结」「与相邻节点的关系」这类元信息小节。
   每个模块开头的那一两句导语是**写给读者看的**，用「这一节从……展开」「本节先说明……再……」这样的说法，不要出现「节点」「段落任务」「写作要求」这些流水线词汇。
2. 标题层级：章节标题（一、二、三）由程序拼装，你不要写 # / ##。正文里的小节标题用**三级标题**，形如「### （一）小节名 ★★」（星级见第 11 条）；不要写四级及以下标题，更细的层次用「1.」这类编号或加粗短语。成品目录是两级：章节（一、）与缩进的小节（（一）），层级越浅越看得出这节课讲了几件事。
2b. 呈现方式（决定笔记读不读得下去，请严格遵守）：
   - **单段不超过 300 字**。一段只讲一件事，超过就拆段；连着三段以上长段落会让读者放弃。
   - 三条及以上并列的内容（要件、类型、步骤、条件、判断标准）**必须用列表**，不要写成流水句。
   - 对比、分类、辨析类内容（A 与 B 的区别、几种情形的对照）**必须用表格**。
   - 每个知识模块至少有一处列表或表格。
   - 案例按「事实 → 争点 → 结论与规则适用 → 教师评价 → 论证意义」分条写，不要糊成一段；其中**论证意义必须单独写清**（老师为什么讲这个案例、它在本课论证里承担什么角色），只复述案情不算。
   - 不要把转录稿的口语流水账照搬成段落；先想清楚这一小节要说几件事，再一件事一段。
   - 三类提示用**引用块**就地写，不要攒到文末列表里（读者读到哪儿就提醒到哪儿）：
     「> 老师强调：…」（老师明确强调、反复提及、说会考的内容）
     「> ⚠️ **易混提醒**：…」（成对易混概念的对比）
     「> 💡 **理解难点**：…」（难在哪里、正确的理解角度）
     三者并列、互不替代；每个模块各自按需使用，不要为了凑齐而硬写。
3. 不要把转录稿的时间戳写进正文（旧流程的明确要求：时间戳只用于定位，不属于笔记内容）。
4. 语言用学术书面语；教师观点用「老师指出 / 老师强调 / 老师认为」引导；这类强调标记每个模块最多 3 处——标得满地都是等于没有重点。
5. 不要用 emoji 当层级（📌✨🔥 之类）：结构由标题层级承担，emoji 在不同渲染器下表现不一致。
6. 因果连接词（因此/因为/这说明）必须有转录依据：不要为了读起来顺而编出讲授里不存在的因果关系。
7. 材料确实没有涉及的内容：不要编造，也不要用「待补写」占位，直接不写这一段。
8. 条号、案名这类可核对的事实必须与转录/课件一致；拿不准就写「（条号待核）」，不要推断一个看起来对的。
9. 严格遵守 WriterBrief.lengthBudget 的篇幅预算（有的话）：它给出**整节课的总字数**与**每个模块的字数**。这是给复习用的提纲挈领的笔记，不是逐字实录；宁可精炼，不要注水，也不要因为字数不够而重复或铺陈。写完一个模块就核对一次字数，不要靠后面的模块补前面欠的账。
11. 小节标题末尾标星级，判断依据是老师给的重点信号（"大家注意""这个很重要""考试可能会考""也就是说"等）与讲授篇幅：★★★ 核心必掌握、★★ 重要需理解、★ 了解即可。整节课的 ★★★ 不宜超过三处——到处都是重点等于没有重点。
10. 材料里有课件时（PptAndSupplementSource 非空），课件就是术语与结构的依据：模块开头用一句话说明本节大致对应课件的哪几页，正文中凡是用课件校正过术语或结构的地方，就近标注「（课件第 N 页）」。没有课件材料时不要编造页码。
`.trim()

export const ROLE_SYSTEM = {
  brief: `你是课程简报撰写者 [brief]。根据已经完成并通过审查的课程笔记写一份简报，读者读完要在 30 秒内建立基本印象，并能判断这节课值不值得细读。
briefing：一段 150—300 字的中文说明，讲清这节课在讲什么、主线怎么走、老师最强调什么。必须落到具体内容（讲到哪些概念、得出什么结论、用什么例子），不要写「本课内容十分丰富」「围绕若干问题展开」这类空话。
keyPoints：3 条，每条不超过 40 字，写这节课最该记住的结论或方法。
theme：给这节课起一个**能统摄全课内容**的标题（不超过 20 字），读者只看这一句就知道这节课的中心是什么。
  ①概括的是这节课的**中心论点或核心问题**，不要写成"从 A 到 B"的路线描述——那种写法信息量低，只是把两个关键词串起来；
  ②要罩得住全篇：课末的延伸讨论也要落在它的射程内；
  ③落到具体内容，不要"本节内容""课程介绍"这类空话。
  反例（不要这样）：「从交易成本到有限责任的边界」「刑罚结构的严与厉」（前者只是把两个词串起来，后者只提了一个侧面）。
  正例：「有限责任的边界由什么划定：交易成本、资产专用性与人格否认」「以刑制罪：罪刑均衡如何约束法定刑配置」。
keywords：5—6 个，每个 2—10 个字，**按这节课的讲授顺序排列**——把这一串连起来读，要能看出这节课的思路怎么走（首页课次表里就是这一列）。
  每个词都要是这节课真正在讲的核心概念：写"交易成本""资产专用性""代理成本""法人人格否认"，不要写"商法""法律制度""重点内容"这类泛词，也不要写教室安排、考核方式、助教、参考书目这类事务性内容；不要与课程名重复；不要写句子或带标点的长串。
detail：站内简报页的 Markdown，含本课主线、3—5 个核心问题、老师明确赞成或反对或反复强调的内容、重要案例与法条材料、与前后课程或既有知识的关系。
简报不是截取笔记开头，也不是罗列标题；不得新增笔记里没有的事实。`,
  sourcemap: `你是课程笔记的来源标注员 [sourcemap]。给一份"一页纸摘要"里的每个要点，标出它在笔记正文里**依据在哪一节**。
硬约束：
1. 一页纸里的每个要点（列表项、表格行组、案例块、段落）都要有一条 entries；同一块可以对应 1—3 个小节。
2. sections[].id **只能从"可用小节清单"里逐字照抄**，不许自己编、不许改写、不许用标题代替 id。
3. sections[].quote 必须是那一节正文里**逐字出现**的一段话（15—60 字），原样复制，不许改写、不许拼接两处、不许加标点。程序会逐字比对，抄错的那条会被丢掉。
4. block 给出该要点在一页纸里的**开头 10—20 个字**（程序据此定位到具体块）。
5. 一页纸里没有明确依据的要点（例如跨全课的概括、老师的整体判断）**不要硬指**某一节——直接不写这条。
6. 只标注，不改写一页纸，也不要新增笔记里没有的内容。`,
  topicPlan: `你是课程专题规划者 [topicPlan]。你只负责把一门课已经发布的若干课次按**知识体系**划成阶段性专题，不写专题正文。
专题不是按日期机械分组，也不是把每一节课各立一个专题；它要回答“若干课次合起来形成了什么制度/问题结构”。优先识别教师连续讲授的制度板块、反复推进的问题线、相互比较或具有前后条件关系的知识组。
硬约束：
1. 只使用输入中列出的课次 slug，逐字照抄；不得编造课次。
2. 所有课次至少属于一个专题；同一课次确实跨两个知识板块时可以重复出现。
3. 一门课通常形成 1—8 个专题；宁可少而完整，不要切成一堆只有一个泛词的小块。
4. title 要能直接成为复习目录标题，按知识内容命名，不用“第一阶段”“第 3—5 讲”。
5. summary 只说明这个专题统摄的核心问题，不展开正文。只输出 RequiredOutputSchema 指定 JSON。`,
  topic: `你是课程专题框架生成者 [topic]。你要把已经确定范围的若干课次重组为**复习用知识框架**，而不是重新写一篇长笔记。
读者首先要一眼看出体系：分类、条件、例外、并列制度、判断顺序、相互对照分别是什么。节点应尽量短，必要解释放 note；默认最多三层。
relation 只使用 hierarchy / parallel / condition / sequence / exception / contrast。
每个承载具体知识结论的叶节点都必须给 sourceRefs，且 slug 与 sectionId 只能逐字照抄输入中的可用课次与小节清单；上级纯分组节点可以不挂来源。
不得按课次顺序复述，也不得把原笔记压缩成另一篇长文。框架、提纲、自测会由程序从同一棵 nodes 树渲染，所以只生成一份结构数据。只输出 RequiredOutputSchema 指定 JSON。`,
  onepage: `你是课程一页纸摘要撰写者 [onepage]。把一节完整的课程笔记压进**一张 A4**，读者复习时只看这一页。
硬约束（排版是内容的一部分，不是事后裁剪）：
1. 总字数 ${1800} 字左右，**绝不能超过 ${2600} 字**（含表格单元格里的字）。超了宁可删要点。
2. 不许出现长段落。全部用短句、列表、表格：概念/要件用无序列表，对比与辨析用表格，时间线或步骤用有序列表。
3. 保留的是**体系与最核心的知识点**：本课主线一句、核心概念及其要件、老师反复强调的立场、必须记住的法条与案例、易混辨析。细节、例子细节、重复解释一律删掉。
4. 标题层级只用 ## 与 ###，不要 #；不要写"本页内容""复习提示"这类空话，也不要写元信息（课次名、日期、课程名）。
5. 表格最多三列，窄栏里放得下；单元格里的字要短。
6. 不得新增笔记里没有的内容；不确定的条号照原样带"（条号待核）"。
输出结构：title（一页的标题）+ markdown（正文）+ outline（分了哪几块）。`,
  grouping: `你是课程资料归档助手 [grouping]。根据材料索引提出课次候选和材料分配建议。课次与材料是多对多关系：一节课可包含多份材料，一份课件或长文档也可按页码、行号或段落范围分配给多节课。课堂转录、明确日期和内容主线是主要依据；文件名只作辅助。无法可靠判断时必须保留为未归档，不能强行创建课次。已有课次和 locked 分配不得覆盖。只输出建议，不撰写课程笔记。`,
  outline: `你是课程大纲规划者 [outline]。阅读全文后提炼本课主线，并把材料划分为连续、无遗漏、尽量不重叠的知识模块：两小时的课通常 5—8 个模块，一小时的课 3—5 个。模块是笔记里的小节，标题要能直接当小节标题用（写成主题，不要写成"第一部分"）。每个节点还要标 kind：正课内容用 content；课间事务、助教安排、作业与考试通知、教室与设备之类的行政信息用 logistics；时事评论、个人经历、闲聊等与课程主线无关的内容用 digression。kind 不影响行区间的连续性——事务与发散同样要落在某个节点里，只是它们会被程序排到附录。CourseSoFar 是同一门课此前成品笔记的摘要（主题、关键词、概念、小节）：用它判断本节课承接什么、哪些已经讲过，不要重复划分已讲透的模块，也不要照抄它的措辞；它没有的内容不得当成"上节讲过"。
TranscriptSource 中的 [Lx] 是唯一有效的转录行号；lineRange 必须引用这些绝对行号，不得自行估算或使用原始 SRT 序号。第一节点必须从 L1 开始，最后节点必须覆盖 LessonBlueprint.transcriptLineCount，相邻节点之间不得留下缺口。每个节点还应给出对应课件页码，并识别概念、法条、案例、教师强调信号与节点写作目标。不要撰写正文。`,
  outlineRepair: `你是课程大纲覆盖修复者 [outlineRepair]。只处理 LessonBlueprint.coverageGaps 指定的缺口，并使用 TranscriptSource 中的绝对 [Lx] 行号生成补充节点。每个缺口必须从其起始行连续覆盖到结束行，不得改写已有大纲，不得扩展到缺口之外，不得撰写正文。`,
  writer: `你是课程节点撰写者 [writer]。只撰写当前 WriterBrief 指定的一个节点（WriterBrief.lessonStructure 给出本课全部小节与分工，标 isCurrent 的是你要写的这一节）。开头用一两句说明本节与上一节的关系，写关系而不是写顺序（"因此/与之相对/在此基础上"，不要写"接下来我们讲"）。内容应充分展开课堂论证，不得压缩成提纲式摘要，也不得重复其他节点。
CourseSoFar 是此前课次的成品笔记摘要：写"本节与上一节的关系"时以它为依据（说清承接的是哪个概念或哪条线），但不得照搬它的句子，也不得把它的内容当成本节课讲过的。
每个知识模块内部按这个顺序写：①导语——用一两句写它与上一节的关系（"因此/与之相对/在此基础上"，不要写"接下来我们看"）；②规则与要件拆解——概念、构成要件、判断标准分条写清；③案例——六项齐全（背景或案名、事实、争点、结论与规则适用、教师评价、论证意义），其中「论证意义」要说明这个案例在本课论证里承担什么角色，不能退化成案情复述；④老师的立场与强调；⑤易混辨析（本模块内容易搞混的成对概念）。
案例至少交代背景或案名、事实、争点、结论与规则适用、教师评价、论证意义六项；材料缺少其中某项时应如实标注，但「论证意义」不能省。
法条要写明法律名称与条号、核心规定、适用条件；与其他法条或制度的关系如有讲解也要写。
学说争议要列出各方观点与理由，并说明老师倾向或通说。
重点内容只作客观陈述，不要通篇标注「重点」「必考」，也不要靠加粗来标记老师强调。
输出 Markdown 正文，但必须放在 JSON 的 markdown 字段中。`,
  reviewer: `你是独立课程审查者 [reviewer]。你只做一件事：检查当前节点正文是否达到课程笔记的要求，给出 approve 或 revise。
只拦这几类实质问题：编造或来源中不存在的内容、教师立场或法律结论被实质曲解、本节点核心论证或重要材料缺失、案例与法条的关键事实错误、明显异常的压缩、与其他节点的严重重复。
措辞、人名出现顺序、例子顺序、无损含义的背景省略、可以更顺滑的表达都不算问题，不要据此要求重写，也不要写进 issues。
issues 每条要具体、可执行，message 用中文；severity 只用 blocking（必须改）或 important（值得改）；能定位时补 nodeId 与 sourceRange。
decision 只有 approve 与 revise 两个取值：至少存在一条 blocking 问题时用 revise，否则用 approve。
不要输出任何评分字段，不要要求人工介入。`,
  revision: `你是课程节点修订者 [revision]。只修订当前节点，逐项回应 blocking Reviewer issues 和用户补充要求；suggestion 仅在自然且不增加无来源内容时酌情吸收。保留已经正确且有来源的内容，不得重写整课，不得跨节点补写。输出完整的新版本 Markdown，放在 JSON 的 markdown 字段中。`,
  finalRevision: `你是课程最终笔记修订者 [finalRevision]。用户已经通读机械拼装后的完整笔记，并给出明确修改要求。只根据该要求对现有 Markdown 做必要且尽量局部的修改；未被要求调整的内容、标题层级、节点正文、来源标记和元数据应保持不变。不得凭空新增课堂事实、法条、案例或教师观点。输出完整的新版本 Markdown，放在 JSON 的 markdown 字段中。`,
  splicer: `你是单课笔记的接缝与体系层生成器 [splicer]。节点正文已经逐一审查通过，绝对不得改写、压缩或重述节点正文。你根据已批准大纲、节点索引、各节的**依据摘录**（在 PptAndSupplementSource 里，取自已批准正文的要点句）与占位符上下文，生成两类内容：
一是**体系层**——本课在课程中的位置（承接什么、为后面什么铺垫）、知识地图（Mermaid flowchart，节点是核心概念或环节，边表示"先理解 A 才能理解 B"）、体系线索（把散在各节的同一条论证线串起来，3—5 条）、易错点与辨析；
二是**接缝层**——课程概览（核心问题、学习目标、课程脉络）、各大纲章节的总结段和自测题、概念/法条/案例索引表、术语与 ASR 更正表、知识连接、可选附录。
CourseSoFar 给出同一门课此前的成品笔记摘要：知识连接的"承接什么"要以它为依据并落到具体概念或论证线；它没有的内容不许编成承接关系。

接缝层的几条硬要求：
- 知识地图 ≤ 12 个节点：节点多了图就退化成又一份目录，比文字还难读。图承担结构，正文承担内容，不要用图复述正文。
- 自测题放在**节末**（不是节首），每个一级节 3—5 题。题型优先「写出规则/要件」「Why / How / 区别」「给情境判断是否构成」，不要在开头放"带着这些问题去读"。
- 每道自测题都要给参考答案，答案里必须含**判断标准或必须出现的关键词**（读者要能自我评分），只给结论不合格。
- 案例索引里的要旨只能来自老师明确表述；拿不准就留空，不要补一个看起来合理的裁判要旨。
- 方法论/实证类课程额外给方法卡（methods）：解决什么问题、核心识别假设、数据要求、估计量、常见误用、课堂实例。
- 术语与 ASR 更正表（asrCorrections）：转写里明显听错的专业词，写清「转写原文 → 应为 → 依据」；没有就不给。
- 索引表只收本课确实出现过的条目，说明写不出来就留空，不要编。
- 依据摘录是"这一节真的讲过什么"的唯一凭据：章节总结、索引说明、案例要旨、方法卡与自测题答案都要落在摘录或课件里出现过的话上；摘录里没有依据的，留空比编一个看起来合理的说法好。摘录本身是节选，不得整句照搬充作接缝层内容（接缝是索引与导航，不是第二份正文）。
篇幅纪律：体系层与接缝段是"索引与导航"，不是第二份正文。表格每格一句话以内（不超过 40 字）、每张表不超过 12 行；章节总结 2—3 句；自测题答案 2 句以内。整块（不含节点正文）控制在 2500 字左右。核心问题应是 Why / How / 区别类问题，共 3—5 个；学习目标必须以可验证动词开头，共 3—5 个；课程脉络不少于 60 字。每个章节总结写 2—3 句且不少于 45 字，说明该章节在全课论证中的功能；每章自测 2—4 题，以理解、辨析和应用为主。知识连接必须说明对后续学习的铺垫。附录只收纳课堂发散、术语或补充话题，不得凭空创造。只输出 RequiredOutputSchema 指定的 JSON。`,
  finalReview: `你是单课最终审查者 [finalReview]。程序已经机械确认全部已批准节点正文都完整进入了最终稿，因此不要重新逐句核验原始转录，也不要因措辞、例子顺序或次要背景省略退回。
只检查四件事：跨节点的实质矛盾、严重重复、核心术语或教师观点前后不一致、最终稿整体结构是否完整可读。
issues 每条 message 用中文，能定位到节点时给出该节点的 nodeId；severity 只用 blocking 或 important。
decision 只有 approve 与 revise 两个取值：至少存在一条 blocking 问题时用 revise，否则用 approve。不要输出评分字段，不要要求人工介入。`
}

function jsonBlock(label, value) {
  return [`## ${label}`, '```json', JSON.stringify(value || {}, null, 2), '```'].join('\n')
}

function textBlock(label, value) {
  return [`## ${label}`, String(value || '').trim() || '(empty)'].join('\n')
}

function overrideModelForRole(role, models = {}) {
  if (role === 'brief') return models.brief || models.writer || models.default
  if (role === 'topicPlan') return models.outline || models.default
  if (role === 'topic') return models.onepage || models.writer || models.default
  if (role === 'grouping' || role === 'outline' || role === 'outlineRepair') return models.outline || models.default
  if (role === 'writer' || role === 'splicer') return models.writer || models.default
  if (role === 'reviewer') return models.reviewer || models.default
  if (role === 'revision' || role === 'finalRevision') return models.revision || models.writer || models.default
  if (role === 'finalReview') return models.finalReview || models.reviewer || models.default
  return models.default
}

export function requireCourseModelConfig(role, overrideConfig = null, env = process.env) {
  if (overrideConfig?.apiKey) {
    const model = overrideModelForRole(role, overrideConfig.models || {})
    if (!model) throw new Error(`当前账号尚未配置 ${role} 使用的模型`)
    return {
      provider: overrideConfig.provider || 'openai-compatible',
      source: overrideConfig.source || 'override',
      baseUrl: String(overrideConfig.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, ''),
      apiKey: overrideConfig.apiKey,
      model
    }
  }

  const apiKey = env.COURSE_AI_API_KEY || env.SCHEDULE_AI_API_KEY || env.OPENAI_API_KEY
  if (!apiKey) throw new Error('COURSE_AI_API_KEY is required for course worker model calls')

  const baseUrl = env.COURSE_AI_BASE_URL || env.SCHEDULE_AI_BASE_URL || 'https://api.openai.com/v1'
  const model = env[ROLE_MODEL_ENV[role]] ||
    (role === 'grouping' ? env.COURSE_OUTLINE_MODEL : '') ||
    (role === 'splicer' ? (env.COURSE_FINAL_REVIEW_MODEL || env.COURSE_WRITER_MODEL) : '') ||
    env.COURSE_AI_MODEL || env.SCHEDULE_AI_MODEL
  if (!model) throw new Error(`${ROLE_MODEL_ENV[role] || 'COURSE_AI_MODEL'} is required`)

  return { provider: env.COURSE_AI_PROVIDER || 'openai-compatible', source: 'environment', baseUrl: baseUrl.replace(/\/$/, ''), apiKey, model }
}

export function buildPrompt({
  role,
  promptVersion = 'course-workflow-v3',
  courseSpec,
  lessonBlueprint,
  writerBrief,
  // 同一门课此前讲到哪（course-context.mjs 从已发布笔记提炼的受控摘要）。
  // 放在转录之前：先知道"承接什么"，再读本节课的材料。
  courseContext,
  sourceText,
  pptText,
  previousNodeSummary,
  nextNodeTarget,
  schema
}) {
  const system = `${ROLE_SYSTEM[role] || ROLE_SYSTEM.writer}\n\n${COMMON_RULES}\n\nPrompt version: ${promptVersion}`
  const user = [
    textBlock('PromptVersion', promptVersion),
    jsonBlock('CourseSpec', courseSpec),
    jsonBlock('LessonBlueprint', lessonBlueprint),
    // 第一讲（或发布库里还没有这门课）没有"此前讲到哪"：整块不出现。
    // 给一个 ## CourseSoFar (empty) 只会让模型去猜"这里本来该有什么"。
    ...(String(courseContext || '').trim() ? [textBlock('CourseSoFar', courseContext)] : []),
    jsonBlock('WriterBrief', writerBrief),
    textBlock('PreviousNodeSummary', previousNodeSummary),
    textBlock('NextNodeTarget', nextNodeTarget),
    textBlock('TranscriptSource', sourceText),
    textBlock('PptAndSupplementSource', pptText),
    jsonBlock('RequiredOutputSchema', schema),
    '请只返回一个有效 JSON 对象。不得编造来源中不存在的内容。'
  ].join('\n\n')

  return { system, user, version: promptVersion, role }
}

function contentPartText(part) {
  if (typeof part === 'string') return part
  if (!part || typeof part !== 'object') return ''
  if (typeof part.text === 'string') return part.text
  if (typeof part.text?.value === 'string') return part.text.value
  if (typeof part.content === 'string') return part.content
  return ''
}

export function extractCourseModelContent(data) {
  const message = data?.choices?.[0]?.message
  const content = message?.content
  if (content && typeof content === 'object' && !Array.isArray(content)) return content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const joined = content.map(contentPartText).filter(Boolean).join('')
    if (joined) return joined
  }
  const toolArguments = message?.tool_calls?.[0]?.function?.arguments
  if (typeof toolArguments === 'string') return toolArguments
  if (typeof data?.output_text === 'string') return data.output_text
  if (typeof data?.choices?.[0]?.text === 'string') return data.choices[0].text
  if (typeof message?.reasoning_content === 'string') return message.reasoning_content
  return ''
}

function providerErrorDetail(body) {
  try {
    const parsed = body ? JSON.parse(body) : null
    const providerError = parsed?.error
    if (!providerError || typeof providerError !== 'object') return ''
    const type = String(
      providerError.type || providerError.code || ''
    ).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120)
    const message = String(providerError.message || '')
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, 500)
    return [type, message].filter(Boolean).join(': ')
  } catch {
    return ''
  }
}

function modelTarget(config = {}) {
  let host = ''
  try {
    host = new URL(String(config.baseUrl || '')).host
  } catch {}
  const target = [host, String(config.model || '').trim()]
    .filter(Boolean)
    .join('/')
  return [String(config.source || '').trim(), target]
    .filter(Boolean)
    .join('@')
    .slice(0, 240)
}

function stripReasoning(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim()
}

function fencedCandidates(text) {
  const values = []
  const pattern = /```(?:json|javascript|js)?\s*([\s\S]*?)```/gi
  let match
  while ((match = pattern.exec(text))) values.push(match[1].trim())
  return values.reverse()
}

function balancedObjectCandidates(text) {
  const values = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      if (depth === 0) start = index
      depth += 1
    } else if (char === '}' && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) {
        values.push(text.slice(start, index + 1))
        start = -1
      }
    }
  }
  return values.reverse()
}

function escapeRawControlsInsideStrings(text) {
  let result = ''
  let inString = false
  let escaped = false
  for (const char of text) {
    if (inString) {
      if (escaped) {
        result += char
        escaped = false
        continue
      }
      if (char === '\\') {
        result += char
        escaped = true
        continue
      }
      if (char === '"') {
        result += char
        inString = false
        continue
      }
      if (char === '\n') { result += '\\n'; continue }
      if (char === '\r') { result += '\\r'; continue }
      if (char === '\t') { result += '\\t'; continue }
      result += char
      continue
    }
    result += char
    if (char === '"') inString = true
  }
  return result
}

function removeTrailingCommas(text) {
  let result = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      result += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      result += char
      continue
    }
    if (char === ',') {
      let cursor = index + 1
      while (/\s/.test(text[cursor] || '')) cursor += 1
      if (text[cursor] === '}' || text[cursor] === ']') continue
    }
    result += char
  }
  return result
}

function parseCandidate(candidate) {
  const variants = []
  const raw = String(candidate || '').trim()
  if (!raw) return null
  variants.push(raw)
  const escaped = escapeRawControlsInsideStrings(raw)
  if (escaped !== raw) variants.push(escaped)
  const noTrailingCommas = removeTrailingCommas(escaped)
  if (noTrailingCommas !== escaped) variants.push(noTrailingCommas)

  for (const value of variants) {
    try {
      let parsed = JSON.parse(value)
      if (typeof parsed === 'string') parsed = JSON.parse(parsed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {}
  }
  return null
}

export function parseJsonResponse(text) {
  if (text && typeof text === 'object' && !Array.isArray(text)) return text
  const raw = stripReasoning(text)
  if (!raw) throw new Error('Model response is empty')

  const candidates = [...fencedCandidates(raw), raw, ...balancedObjectCandidates(raw)]
  const seen = new Set()
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)
    const parsed = parseCandidate(candidate)
    if (parsed) return parsed
  }
  throw new Error('Model response must be valid JSON')
}

/** 值得重试的状态码：限流与服务端临时故障。4xx 里其余的都别试——重试只是再浪费一次额度。 */
export function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599)
}

/** 服务端说"等 N 秒"时听它的；Retry-After 也接受 HTTP 日期格式。 */
export function retryAfterMs(response) {
  const header = response?.headers?.get?.('retry-after')
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, Math.round(seconds * 1000))
  const at = Date.parse(header)
  return Number.isFinite(at) ? Math.min(60_000, Math.max(0, at - Date.now())) : null
}

/**
 * 下一次尝试前等多久：指数退避 + 抖动，并听 Retry-After。
 * 返回 null 表示"剩下的时间已经不够再试一次了"——那就别试，把失败如实报上去。
 */
export function retryDelayFor({ attempt = 0, response = null, error = null, now = Date.now(), deadlineAt = Infinity, baseMs = 500, capMs = 8000 } = {}) {
  const suggested = retryAfterMs(response)
  const exponential = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt))
  // 抖动：多个 worker 同时被限流时，不要让它们同时回来（±25%）。
  // 上限要**在抖动之后**再夹一次，否则"最多 8 秒"会被抖动顶到 10 秒——上限就不是上限了。
  const jitter = 1 + (Math.random() * 0.5 - 0.25)
  let delay = suggested ?? Math.round(Math.min(capMs, exponential * jitter))
  // 网络错误往往瞬间返回，稍等一下就有意义；但绝不能等到超过总预算
  const remaining = deadlineAt - now
  if (remaining <= 0) return null
  if (delay > remaining - 1000) delay = Math.max(0, remaining - 1000)
  if (delay <= 0 && remaining < 2000) return null
  void error
  return Math.max(0, delay)
}

export async function callCourseModel({
  role,
  prompt,
  signal,
  config: overrideConfig,
  env = process.env,
  fetchImpl = fetch,
  // 重试相关的两个注入点：sleepImpl 让测试不必真等，onRetry 让运维看得见"又试了一次"
  sleepImpl = ms => new Promise(resolve => setTimeout(resolve, ms)),
  onRetry = () => {},
  // 自建服务器上没有 Vercel 那样的函数生命周期上限，240s 只是一个保守默认值，
  // 而不是硬天花板；需要时可以调高。
  maxTimeoutMs = 900_000
}) {
  const config = requireCourseModelConfig(role, overrideConfig, env)
  const startedAt = new Date().toISOString()
  const configuredTimeout = Number(env.COURSE_AI_TIMEOUT_MS || 240_000)
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.min(maxTimeoutMs, Math.max(10_000, Math.floor(configuredTimeout)))
    : 240_000
  const configuredRetries = Number(env.COURSE_AI_JSON_RETRIES ?? 1)
  const jsonRetries = Number.isFinite(configuredRetries)
    ? Math.min(2, Math.max(0, Math.floor(configuredRetries)))
    : 1
  // 传输层重试次数（429/5xx/网络抖动）：默认 2，即最多尝试 3 次。
  // 与 JSON 重试分开计数——后者是"模型答得不对"，前者是"这次请求没成功"。
  const configuredHttpRetries = Number(env.COURSE_AI_HTTP_RETRIES ?? 2)
  const httpRetries = Number.isFinite(configuredHttpRetries)
    ? Math.min(5, Math.max(0, Math.floor(configuredHttpRetries)))
    : 2
  // JSON retries and any outline-repair call share the enclosing batch deadline.
  const batchDeadline = Number(overrideConfig?.deadlineAt)
  const deadlineAt = Math.min(
    Date.now() + timeoutMs,
    Number.isFinite(batchDeadline) && batchDeadline > 0 ? batchDeadline : Infinity
  )
  let lastParseError = null

  function transportError(error, phase, attempt, elapsedBudget, timedOut, cancelled) {
    const message = timedOut
      ? `Course model call timed out after ${elapsedBudget}ms (${phase})`
      : cancelled ? 'Course model call cancelled' : 'Course model network request failed'
    const wrapped = new Error(message, { cause: error })
    wrapped.code = timedOut ? 'course_model_timeout'
      : cancelled ? 'course_model_cancelled' : 'course_model_request_failed'
    wrapped.retryable = !cancelled
    wrapped.meta = {
      provider: config.provider, model: config.model, role, phase, timeoutMs: elapsedBudget,
      startedAt, endedAt: new Date().toISOString(), attempt: attempt + 1
    }
    return wrapped
  }

  for (let attempt = 0; attempt <= jsonRetries; attempt += 1) {
    if (signal?.aborted) {
      throw transportError(signal.reason, 'before-request', attempt, 0, false, true)
    }
    const remainingMs = Math.ceil(deadlineAt - Date.now())
    if (remainingMs <= 0) {
      throw transportError(null, 'before-request', attempt, timeoutMs, true, false)
    }
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(
      new DOMException('Course model time budget expired', 'TimeoutError')
    ), remainingMs)
    timer.unref?.()
    // 同一个 JSON 尝试内部的传输层重试：429/5xx/网络抖动都值得再试一次，
    // 而 400/401 这类重试多少次都一样，只会浪费时间与额度。
    let response = null
    let body = ''
    let transportAttempts = 0
    for (let transport = 0; ; transport += 1) {
      transportAttempts = transport + 1
      const budgetLeft = Math.ceil(deadlineAt - Date.now())
      if (budgetLeft <= 0) {
        throw transportError(null, 'before-request', attempt, timeoutMs, true, false)
      }
      const timeout = new AbortController()
      const timer = setTimeout(() => timeout.abort(
        new DOMException('Course model time budget expired', 'TimeoutError')
      ), budgetLeft)
      timer.unref?.()
      const requestSignal = signal
        ? AbortSignal.any([signal, timeout.signal])
        : timeout.signal
      const messages = [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user }
      ]
      if (attempt > 0) messages.push({
        role: 'user',
        content: '上一次响应未能解析为合法 JSON。请重新完成同一任务，只返回一个严格合法、可由 JSON.parse 直接解析的 JSON 对象；字符串中的换行必须正确转义，不要输出思考过程、代码围栏、注释或前后说明。'
      })

      let phase = 'request'
      let failure = null
      try {
        response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
          method: 'POST',
          signal: requestSignal,
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            model: config.model,
            messages,
            temperature: attempt > 0 ? 0 : Number(env.COURSE_AI_TEMPERATURE || 0.2),
            response_format: { type: 'json_object' }
          })
        })
        phase = 'response-body'
        body = await response.text()
      } catch (error) {
        const timedOut = timeout.signal.aborted || error?.name === 'TimeoutError'
        const cancelled = !timedOut && Boolean(signal?.aborted)
        if (cancelled) throw transportError(error, phase, attempt, budgetLeft, false, true)
        failure = { error, phase, timedOut }
      } finally {
        clearTimeout(timer)
      }

      if (!failure && response && !response.ok) {
        if (!isRetryableStatus(response.status)) {
          const detail = providerErrorDetail(body)
          const error = new Error([
            `Course model call failed: ${response.status}`,
            modelTarget(config),
            detail
          ].filter(Boolean).join(' · '))
          error.meta = { provider: config.provider, model: config.model, role, startedAt, endedAt: new Date().toISOString(), status: response.status, attempt: attempt + 1 }
          throw error
        }
        failure = { error: new Error(`HTTP ${response.status}`), phase: 'response-status', timedOut: false, status: response.status }
      }

      if (!failure) break
      const exhausted = transport >= httpRetries
      const delay = exhausted ? 0 : retryDelayFor({ attempt: transport, response, error: failure.error, now: Date.now(), deadlineAt })
      if (exhausted || delay === null) {
        if (failure.status) {
          const detail = providerErrorDetail(body)
          const error = new Error([
            `Course model call failed: ${failure.status}`,
            modelTarget(config),
            detail
          ].filter(Boolean).join(' · '))
          error.meta = { provider: config.provider, model: config.model, role, startedAt, endedAt: new Date().toISOString(), status: failure.status, attempt: attempt + 1, transportAttempts }
          throw error
        }
        throw transportError(failure.error, failure.phase, attempt, Math.ceil(deadlineAt - Date.now()), failure.timedOut, false)
      }
      onRetry({ role, model: config.model, attempt: transport + 1, of: httpRetries + 1, delayMs: delay, reason: failure.status ? `HTTP ${failure.status}` : (failure.timedOut ? 'timeout' : 'network') })
      await sleepImpl(delay)
    }

    const endedAt = new Date().toISOString()

    let data
    try {
      data = body ? JSON.parse(body) : {}
    } catch {
      throw new Error('Course model endpoint returned invalid JSON')
    }
    const content = extractCourseModelContent(data)
    try {
      const parsed = parseJsonResponse(content)
      return {
        parsed,
        trace: {
          provider: config.provider,
          model: config.model,
          role,
          promptVersion: prompt.version || 'course-workflow-v3',
          startedAt,
          endedAt,
          promptChars: prompt.user.length + prompt.system.length,
          completionChars: typeof content === 'string' ? content.length : JSON.stringify(content || {}).length,
          attempts: attempt + 1,
          usage: data.usage || null
        }
      }
    } catch (error) {
      lastParseError = error
    }
  }

  const error = new Error('模型返回格式异常，自动修复后仍无法读取')
  error.cause = lastParseError
  error.meta = { provider: config.provider, model: config.model, role, startedAt, endedAt: new Date().toISOString(), attempts: jsonRetries + 1 }
  throw error
}
