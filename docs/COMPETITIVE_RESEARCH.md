# 个人事务平台 · 竞品与最佳实践研究

核查日期：2026-10-12（Asia/Shanghai）。范围：任务详情、富文本/Markdown、图片与语音、快速记录、个人等待跟进、项目拆解和整体交互。研究用于本项目PRD v0.6，非购买推荐。

## 1. 方法与证据边界

三条并行研究分别覆盖捕获与内容、项目拆解、整体模型；以产品官方帮助中心和官方方法论为证据，浏览器能力以MDN为证据。没有使用社区愿望帖证明产品已经支持某功能，没有试用全部套餐/平台，也不推断没有查到的能力必然不存在。

文中“已确认”指官网资料明确描述；“设计选择”是本项目推导，不等于行业统一标准。核查日与页面发布日期分开，不根据抓取时间推定更新日；动态套餐和平台限制以相应链接为准。

## 2. 样本与取舍

| 样本 | 为什么看它 | 已确认的机制 | 对本项目的取舍 |
| --- | --- | --- | --- |
| Things | 个人任务的信息架构与渐进复杂度 | 收件箱、项目/领域、项目分组、Markdown notes；官方说明不支持附件 | 借鉴组织与注意力分离，不照搬原生平台能力，也不照搬无附件限制 [R01][R02][R03] |
| Todoist | 上下文、快速新增与多平台 | 描述与时间顺序评论分开，评论可含文件/录音；独立计划与deadline | 借鉴稳定说明/进展分离及日期语义，不引入协作通知 [R04][R05][R06] |
| TickTick | 输入与编辑一体化 | 工具栏与Markdown快捷语法、图片文件、语音添加，部分能力依平台 | 借鉴低摩擦捕获与有限富文本，不假设所有平台语音一致 [R07][R08][R09] |
| Microsoft To Do | 简单任务详情的小步骤 | steps独立于notes，有限网页富文本、任务文件 | 借鉴小步骤清单，不把它直接变成独立任务 [R10][R11] |
| Asana | 子任务规则和父子边界 | 子任务完整字段，父完成不自动结束子项，嵌套和归属有独立规则 | 借鉴独立行动模型，限制为一层，避免多级与归属脱节 [R12] |
| ClickUp | 清单提升和视图差异 | 清单可提升子任务，子项可折叠/展开/平铺 | 借鉴升级路径，不照搬自定义流程、资源负载和团队权限 [R13][R14] |
| Linear | 事项→项目升级与结果管理 | 子issue、可配置父子关闭、project/milestone概览 | 借鉴结构升级和概览；父子自动化不能当作通用默认 [R15][R16][R17] |
| GTD | 使用闭环 | 捕获、澄清、组织、回顾、行动 | 作为产品流程参考，不强制所有用户逐步走审批式流程 [R18] |

## 3. 能力比较：不能只写“支持”

| 能力 | 官方可确认差异 | 本项目对应设计 |
| --- | --- | --- |
| 说明与评论 | Todoist区分可编辑描述与按时间排列评论；本项目只由本人记录 | 正文、进展、系统事件分开；正文版本可回查，进展只追加 |
| Markdown | Things语法标记持续可见；TickTick是工具栏与快捷语法；Todoist富文本能力有字段/平台边界 | 有限可视编辑＋源编辑，但只要求共同支持子集无损往返，不声称竞品都这么做 |
| 图片/文件 | Things明确无附件；其他样本可挂任务/评论/正文，不是所有产品都内联 | 一套Attachment，正文引用与附件文件生命周期分开 |
| 录音/转写 | Todoist音频评论不同于Ramble；TickTick的录音/实时转写有平台边界 | 录音保存、转文字、任务提取三层，首版录音，转写后续 |
| 快速输入 | Todoist逐步显示属性；Things有原生全局Quick Entry及来源辅助 | 应用内持续可达的捕获面板，不假装PWA具备原生系统全局捕获 |
| 小步骤/子任务 | To Do steps轻量；Asana/ClickUp子项可独立安排 | 小步骤不进入行动列表，需要自己的日期/处理方时提升子事项 |
| 父子完成 | Asana不级联，Linear允许分别配置 | 本系统未结束子项阻止父结束，全结束仅提示；这是设计选择 |
| 项目分组 | Things Heading、Todoist Section、Linear milestone语义强度不同 | 首版阶段/分组仅组织，无额外状态；项目目标/结果单独表达 |

证据对应R03～R17。不存在一个可以无差别照搬的“最佳产品”；本系统选择应服务于个人记录与跟进。

## 4. 功能拆解与设计决策

### 4.1 任务详情

设计为唯一完善上下文的入口：标题与状态、当前内容说明、行动安排、清单/子项、媒体、进展历史。正文回答是什么与怎么做，进展回答何时发生了什么。下一步要短且可在列表看到，不埋进长文档。

Todoist task view集中属性与子项，适合作为入口参考；文字编辑与日期编辑不宜切成互不关联的多个小系统。[官方task view](https://www.todoist.com/help/todoist/features/use-the-task-view-to-manage-tasks-in-todoist-eDeRDO0C)

本系统继续保留“手动进展只追加”的审计选择。部分竞品允许编辑/删除评论，这不意味着本系统必须改写既有历史。

### 4.2 正文编辑

Things与TickTick给出的两种路线都成立。为兼顾用户提出的富文本、Markdown与可迁移性，本系统选择有限Markdown内容源，可视工具栏、源编辑和预览；支持范围内无损转换，不支持内容保留源稿。不会同时维护两份正文。

正文检查清单与可独立安排的子任务分开；外部富文本粘贴需有限格式转换，不宣称完整保留任意文档排版。后台自动保存、协作编辑、嵌入网页和块数据库不是首个编辑器目标。

### 4.3 图片与文件

按“输入→暂存上传→校验→关联→预览/下载→移除→恢复/导出”拆解，覆盖粘贴、拖拽和移动相册/相机的可用性检测。正文删除图片引用不应删除整个文件；附件保存失败不能清空文字。

TickTick与To Do的官方限额按不同维度计算，不能混写成统一限制。本项目PRD里的10/20/25MiB是实现默认值，来自规模与体验判断，不是照搬套餐权益。媒体发布后旧数据库单文件备份不再足够。

### 4.4 语音

音频附件可以稳定保存证据，转写解决文字输入，任务提取解决结构化，两者不可混为“语音功能”。录音失败必须留已取得片段并给重试；麦克风拒绝应退回文件/文字，不制造无音频记录。

Ramble支持预览后编辑，但其文档不支持所有任务结构；本项目未来也应先提议，再确认，不把任意口述时间静默写为截止日。语音原始资料与用户校对文本分别保存，不让转写覆盖原正文。[Todoist Ramble](https://www.todoist.com/help/todoist/todoist-and-ai/dictate-to-add-tasks-with-ramble-P1Raq7vVF)

### 4.5 快速记录

先捕获后整理、紧凑与展开两档、来源链接可追溯、标题不足的媒体记录有临时标题、多行粘贴先预览。这些机制使“赶紧记”和“认真完善”使用同一对象。

系统快捷键、原生Siri、邮件导入、系统接收分享都是单独集成，不能据Web Share可用推断能从其他App分享进PWA。首版复制粘贴和文件选择足以形成基础闭环。

### 4.6 个人分发与等待

Things官方等待实践采用Waiting标签和跟进日期，也可按人的名称分类，说明个人系统不需要对方账号才能有效跟进。[等待事项实践](https://culturedcode.com/things/support/articles/2237050/)

本系统保持处理方式与状态、时间独立：自己处理可以等待审批；交给别人可以尚未沟通。姓名/部门自由文本，只更改当前事项；真实沟通用本人进展记录，无接收、转派或权限机制。

### 4.7 大型项目拆解

按照空间→项目→可选分组→事项→一层子事项。小步骤用于无需独立安排的动作；复杂后升级。项目描述目标，事项描述交付，分组仅组织。Things也区分小目标清单与大目标项目，并建议逐步完善下一步。[Things目标拆解](https://culturedcode.com/things/support/articles/8491676/)

本系统限制层级、禁止跨项目父子与循环；父/项目完成需要检查子项再人工确认。统计只算叶子事项，取消单列；全局行动视图平铺叶子并显示路径，项目树显示父子。这些是为了避免重复计数与隐藏到期工作作出的设计选择。

### 4.8 回顾

先检查未整理、到期行动/跟进、等待未设跟进、没有下一步的项目，再看完成成果。回顾帮助保持台账可信，而非主要展示完成数量。[GTD方法](https://gettingthingsdone.com/what-is-gtd/)

## 5. 浏览器边界

| 能力 | 核查与采用方式 |
| --- | --- |
| 麦克风 | getUserMedia要求安全上下文及授权；公网HTTPS配置与真实手机验证是前置 [R19] |
| 录音格式 | MediaRecorder需运行时检测格式；保存实际MIME/时长，不能统一假设WebM [R20] |
| 转文字 | SpeechRecognition有限支持，部分实现使用服务器处理；不作为统一离线转写承诺 [R21] |
| 接收系统分享 | share_target支持有限，先复制粘贴/文件选择，后续检测 [R22] |

本报告只依据能力文档，不等于当前目标手机已通过上述测试。

## 6. 功能落地与版本安排

| 研究决定 | 需求编号 | 新阶段 |
| --- | --- | --- |
| 无联系人个人分发 | FR-07、FR-08 | M3 |
| 正文与进展分离、有限可视/Markdown、草稿版本 | FR-09、FR-17、FR-18 | M4 |
| 图片/文件、录音保存、多模态捕获 | FR-19、FR-20、FR-21 | M4 |
| 小步骤、多行预览与来源 | FR-22、FR-27 | M4 |
| 分组、一层子项、升级、项目目标和进度 | FR-23、FR-24、FR-25、FR-26 | M5 |
| 内容/层级搜索、回顾与完整导出 | FR-10、FR-12、FR-15 | M6 |
| 真机交互、多端失败恢复与PWA | FR-13、FR-14 | M7 |
| 数据库和媒体一起备份恢复 | FR-16 | M8 |
| 转写、智能提取、完整离线 | FR-28与后续细化 | M9候选 |

保留已完成M1/M2，不把研究后的新能力算作旧验收已通过。章节重新排，稳定需求ID保留，未开始的里程碑提供旧→新映射。

## 7. 官方来源索引

所有来源核查日为2026-10-12；正文取有限相关机制，不复制整篇资料。未核实平台/套餐能力只按来源边界表达。

| 标记 | 官方资料 |
| --- | --- |
| R01 | [Things Getting Productive](https://culturedcode.com/things/support/articles/6378414/) |
| R02 | [Things项目分组](https://culturedcode.com/things/support/articles/2803577/) |
| R03 | [Things Writing Notes](https://culturedcode.com/things/support/articles/4438545/)、[Markdown Guide](https://culturedcode.com/things/support/articles/4651820/) |
| R04 | [Todoist任务描述](https://www.todoist.com/help/todoist/features/add-a-task-description-in-todoist-rOryWIHn) |
| R05 | [Todoist评论与文件](https://www.todoist.com/help/todoist/features/add-comments-or-files-to-tasks-in-todoist-CwiA50) |
| R06 | [Todoist deadlines](https://www.todoist.com/help/todoist/features/introduction-to-deadlines-in-todoist-uMqbSLM6U) |
| R07 | [TickTick Editing and Formatting](https://help.ticktick.com/articles/7507338582718152704) |
| R08 | [TickTick Add Tasks](https://help.ticktick.com/articles/7055782422935240704) |
| R09 | [TickTick附件FAQ](https://help.ticktick.com/articles/7055792921664028672) |
| R10 | [Microsoft To Do steps/notes](https://support.microsoft.com/en-gb/todo/add-steps-importance-notes-tags-and-categories-to-your-tasks) |
| R11 | [Microsoft To Do文件](https://support.microsoft.com/en-gb/todo/add-files-to-your-tasks) |
| R12 | [Asana subtasks](https://help.asana.com/s/article/subtasks?language=en_US) |
| R13 | [ClickUp checklists](https://help.clickup.com/hc/en-us/articles/6309942197783-Use-task-checklists) |
| R14 | [ClickUp subtasks](https://help.clickup.com/hc/en-us/articles/6309825777943-Intro-to-subtasks) |
| R15 | [Linear parent/sub-issues](https://linear.app/docs/parent-and-sub-issues) |
| R16 | [Linear milestones](https://linear.app/docs/project-milestones) |
| R17 | [Linear projects](https://linear.app/docs/projects) |
| R18 | [GTD五步](https://gettingthingsdone.com/what-is-gtd/) |
| R19 | [MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia) |
| R20 | [MDN MediaRecorder](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder) |
| R21 | [MDN SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition) |
| R22 | [MDN share_target](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/share_target) |

平台补充：[Todoist录音评论](https://www.todoist.com/help/todoist/features/record-audio-comments-in-a-todoist-task-pAMLZF)区分平台；[Todoist文本格式](https://www.todoist.com/zh-TW/help/todoist/features/format-text-in-a-todoist-task-e5dHw9)区分字段与移动端；[Things Quick Entry](https://culturedcode.com/things/support/articles/2249437/)是原生入口，不能据此承诺PWA系统级捕获。

[R01]: https://culturedcode.com/things/support/articles/6378414/
[R02]: https://culturedcode.com/things/support/articles/2803577/
[R03]: https://culturedcode.com/things/support/articles/4438545/
[R04]: https://www.todoist.com/help/todoist/features/add-a-task-description-in-todoist-rOryWIHn
[R05]: https://www.todoist.com/help/todoist/features/add-comments-or-files-to-tasks-in-todoist-CwiA50
[R06]: https://www.todoist.com/help/todoist/features/introduction-to-deadlines-in-todoist-uMqbSLM6U
[R07]: https://help.ticktick.com/articles/7507338582718152704
[R08]: https://help.ticktick.com/articles/7055782422935240704
[R09]: https://help.ticktick.com/articles/7055792921664028672
[R10]: https://support.microsoft.com/en-gb/todo/add-steps-importance-notes-tags-and-categories-to-your-tasks
[R11]: https://support.microsoft.com/en-gb/todo/add-files-to-your-tasks
[R12]: https://help.asana.com/s/article/subtasks?language=en_US
[R13]: https://help.clickup.com/hc/en-us/articles/6309942197783-Use-task-checklists
[R14]: https://help.clickup.com/hc/en-us/articles/6309825777943-Intro-to-subtasks
[R15]: https://linear.app/docs/parent-and-sub-issues
[R16]: https://linear.app/docs/project-milestones
[R17]: https://linear.app/docs/projects
[R18]: https://gettingthingsdone.com/what-is-gtd/
[R19]: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
[R20]: https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder
[R21]: https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition
[R22]: https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/share_target
