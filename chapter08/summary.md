# 第八章教程总结：LangGraph 单 Agent 图实战——路由、循环与质量闭环

> 来源：《AI Agents 开发实践》第八章（feat/LangGraph 分支）
> 核心命题：如何用 LangGraph 把第六章的五段式 Promise 链，一步步改造成支持路由、循环、质量闭环、持久化与人工介入的单 Agent 图
> 主线：LangChain/LangGraph 定位辨析 → 核心原语（State/Node/Edge/子图）→ 基线迁移 → 路由层 → ReAct 子图 → Critic-Refine 子图 → 工程化落地 → 排障收口
> 承接第七章的三层决策框架（路由/执行/优化），本章全部落到图结构上；不含实现代码，只梳理知识点、选型对比与实践原则

---

## 一、LangChain vs LangGraph：先辨析定位再动手

### 1.1 两者的关系

- **LangChain**：LLM 应用的组件库 + 流水线胶水。统一抽象 Chat Model、Prompt、Tool、Parser、Retriever、Memory 等组件，用 LCEL（`Runnable` / `.pipe()`）串成链。擅长**线性、可预测、一次性跑完**的任务（RAG 问答、结构化抽取、一次性工具调用）。
- **LangGraph**：在 LangChain 之上加一层**状态机 + 图的运行时**。解决的是"节点之间怎么走"——路径决策、循环、状态共享、断点恢复、人工介入、节点级流式反馈。

**关键认知：LangGraph 不是 LangChain 的替代品，而是运行时升级**。节点内部仍然大量使用 LangChain 的组件（Chat Model、Tool、Prompt、Parser），只是控制流交给 LangGraph 接管。

### 1.2 能力对比

| 能力 | LangChain（LCEL） | LangGraph |
|---|---|---|
| 线性流水线 | ✅ 核心能力 | ✅ 完全兼容 |
| 运行时条件路由 | ⚠️ 手写 if / else | ✅ 条件边原生支持 |
| 循环 / 回边 | ❌ 不支持 | ✅ 原生支持 |
| 子图组合 | ⚠️ 嵌套链手工实现 | ✅ "子图即节点" |
| 共享状态 | ⚠️ 参数透传 | ✅ 集中式 State + reducer |
| 断点恢复 / 多轮状态 | ❌ 无 | ✅ Checkpointer |
| 人工介入 | ❌ 无 | ✅ `interrupt()` + `Command` |
| 节点级流事件 | ⚠️ 粗粒度 | ✅ `streamMode: "updates"` |
| 多 Agent 协作 | ⚠️ 手工调度 | ✅ Supervisor / Swarm 模式 |

### 1.3 一句话选型

- 流程是**固定的直线或简单分支** → LangChain（LCEL）足够。
- 流程包含**运行时路径决策、循环、状态共享、人工介入、断点恢复、节点级进度**中任意一项 → 上 LangGraph。
- 用 if / else、递归函数、手写状态机也能把动态控制流塞进 LangChain，但代码复杂度很快失控——这正是 LangGraph 存在的理由。

---

## 二、LangGraph 核心原语

### 2.1 State：图的共享上下文

- State 是整张图的**共享数据层**：节点从 State 读数据、往 State 写结果，节点之间不再层层传参。
- 两个关键设计：
  - **reducer**：决定字段如何合并。`messages` 用追加型 reducer（官方 `MessagesAnnotation` 内置），业务字段一般用覆盖型（默认行为）。
  - **default**：字段缺省初始值，避免 `undefined` 判空散落各处。

⚠️ **reducer 用错是最常见的翻车点**：把 `draft` / `summary` 这类草稿字段设成追加型，每次修订都会把旧内容叠进来——看起来"越改越长"，其实全是历史垃圾。**只有天然累积的字段（消息、日志、工具调用轨迹）才适合追加**。

### 2.2 Node：一步任务

- 节点就是普通 async 函数：读 `state`，返回**要更新的字段**（`Partial<State>`）。
- **不要返回整个 state**，只返回本节点想写入的字段，其余由 reducer 自动合并。

### 2.3 Edge：节点之间怎么走

- **普通边** `addEdge(A, B)`：A 完成后一定去 B。
- **条件边** `addConditionalEdges(A, routerFn)`：A 完成后由 `routerFn(state)` 返回目标节点名——这就是**路径级推理**在图上的最直接形态。
- `START` / `END` 是内置出入口锚点（v1 起推荐用常量而非魔法字符串）。

### 2.4 循环与子图

- **循环**：条件边可以指回前序节点（回边）。可靠循环的三要素：**计数字段 + 业务退出条件 + 硬上限**。
- **子图**：一张 `compile()` 后的图可以直接作为另一张图的节点。这是 LangGraph 最重要的组合原语——外层看是一个节点，内部可以有自己的循环、工具调用和终止逻辑。

### 2.5 工程能力三件套

- **Checkpointer**：节点边界自动保存 State 快照，支持断点恢复与多轮共享。
- **`interrupt()` + `Command`**：任意节点暂停图执行、控制权交还调用方，用户确认后 `resume` 恢复，可双向传值。
- **`streamMode: "updates"`**：按节点粒度推送状态增量，天然驱动前端进度条。

---

## 三、演进路线：五段式链 → 单 Agent 图（本章主线）

第六章系统 `extract → clarify → analysis → risk → summary` 的四个升级动机，刚好一一对应 LangGraph 独有的能力：

| 业务需求 | LangGraph 能力 | 落地小节 |
|---|---|---|
| analysis 需要按情况多次调工具 | 循环（回边） | 8.5 ReAct 子图 |
| 用户请求分分析 / 查询 / 闲聊三类 | 运行时路由（条件边） | 8.4 classifier |
| 报告质量波动需末端质检修订 | 质量闭环（回边 + 计数） | 8.6 Critic-Refine |
| 长任务断点恢复 / 人工审批 / 前端进度 | Checkpointer / HITL / 流式 | 8.7 工程化 |

### 3.1 第一步：基线迁移（不带来即时收益，但提供统一容器）

- 只做一件事：**业务逻辑不动，Promise 链换线性 StateGraph**（START → extract → clarify → analysis → risk → summary → END）。
- 这一步本身收益不大，意义在于：后续路由、循环、闭环、断点恢复全部在这张基线图上做**增量替换**——每节只改一个节点或插一条边，不推翻重来。

📌 **实践原则：先图化，再加动态**。把结构统一到图上之后，每个升级都是局部手术而不是全局重写。

### 3.2 第二步：路由层（classifier + 条件边）

- 用户请求分三类：**分析需求**（跑完整五段式）、**查询需求状态**（只取数）、**闲聊寒暄**（不进业务链路）。
- 实现：加一个 `classifier` 节点（结构化输出判意图），从它发条件边分流到 `extractStep / queryHandler / chatHandler`，后两者直连 END。
- 设计要点：
  - **分类器要有降级策略**：结构化输出失败时用关键词 / 正则匹配兜底（需求编号正则、"查询"关键词等）。
  - **优先级规则要显式写进 prompt**：如"有需求编号优先 query"、"查询 XXX 分析报告"应判 query 而非 analyze。
  - **默认出口**：未知意图给默认分支（analyze），避免卡死。

📌 这就是第七章路由层在工程上的最直接形态。后续升级为 Supervisor 调度多专家子图，仍沿用这一思想。

### 3.3 第三步：分析节点循环化（ReAct 子图）

**为什么单体节点不够**：Ch6 的 analysisAgent 是一锤子买卖；真实需求分析往往需要多轮"查需求详情 → 查相似历史 → 调冲突检测 → 再综合"。这就是 ReAct 模式，塞在单节点里不合适，应拆成子图。

**子图结构**：`agent →（有 tool_calls?）→ tools → agent →…→（无 tool_calls 或达上限）→ finalize`

- **agent 节点**：模型 `bindTools()` 后决定"继续调工具"还是"直接收敛输出"。
- **tools 节点**：用官方 prebuilt `ToolNode` 执行工具，不手写分发逻辑。
- **finalize 节点**：从最后一条 AIMessage 提取分析结果写回主图 State，空消息有安全降级。

**子图三大优势**：逻辑隔离（内部循环不影响主图线性流程）、可复用（同一子图挂到不同主图）、可测试（独立运行不依赖主图其他节点）。

**关键实践原则**：

1. **硬上限不可省略**（本章 ReAct 设 6 轮）。只要存在回边，就必须有明确退出条件 + 最大循环次数，否则失控。
2. **工具描述直接影响 Agent 决策质量**：`bindTools()` 会把 name/description 传给模型，描述含糊则选错工具、传错参都明显增多。
3. **messages 是子图与主图共享的**：agent 追加 AIMessage、tools 追加 ToolMessage，后续节点可见。需要隔离时用独立 State 字段或在 finalize 清空过滤。

### 3.4 第四步：汇总节点闭环化（Critic-Refine 子图）

**为什么需要**：summary 一次生成的典型毛病——章节遗漏、排期不标依赖、冲突只描述不给方案、前后矛盾。共同特点：**不是信息缺失，而是生成质量不稳定**。适合在现有 draft 上局部修补，而不是重跑整条链。

**子图结构**：`actor → critic →（不通过?）→ refine → critic →…→（通过或达上限）→ END`

**ReAct vs Critic-Refine 对比**（同一个回边原语，两种用途）：

| 维度 | ReAct | Critic-Refine |
|---|---|---|
| 回边指向 | tools → agent（思考节点） | refine → critic（评审节点） |
| 循环目的 | 获取更多信息（工具调用） | 提升现有内容质量（修订） |
| 成本特点 | 每次循环可能有外部工具开销 | 纯 LLM 调用，无外部依赖 |
| 终止条件 | 信息足够 or 硬上限 | 质量通过 or 硬上限 |
| 硬上限建议 | 5–6 次 | 2–3 次 |
| 适用场景 | 需要外部数据的分析任务 | 报告、文档、创意内容 |

**评审标准设计三原则**：

1. **客观性**：只检查可验证的内容（"是否包含排期章节"✅，"语言是否优美"❌）。
2. **核心性**：只检查 3–5 条最重要的标准——标准越多修订越多、成本越高、越难调试。
3. **可终止性**：必须有明确通过条件 + 硬上限（2–3 次），避免"持续改进到完美"。

标准过严的后果：频繁触发修订成本线性增长 → 达上限强制终止输出仍不满意 → 难以定位是哪条标准太严。

**修订的增量性原则**：refineNode 的核心价值是**只改被指出的问题**——重新生成会引入新问题、覆盖正确章节、成本与 actor 相当，失去 Critic-Refine 的意义。保证手段：prompt 明确"只修订被指出的问题" + 原报告与评审意见一起传入 + 列出禁止行为（"不要重写整个报告"）。若模型仍频繁重写全文：标注需保留的章节、few-shot 示例、或换质量更稳定的模型。

---

## 四、工程化落地：持久化、HITL、流式输出

### 4.1 会话持久化：Checkpointer 不是必选项

LangGraph 内置 Checkpointer（`MemorySaver` / `PostgresSaver`），但**本项目刻意不用**，改用业务层持久化（NestJS + Prisma + PostgreSQL 的 conversations/messages 表）：

- 已有完整会话管理体系，图执行设计为**无状态**：历史上下文从数据库加载后传入，不依赖图内部快照。
- 前端会话生命周期（创建/删除/重命名/导出）由业务逻辑控制，无需关心图状态清理迁移。
- 避免 Checkpointer 额外表与业务表形成**双重存储**。

**何时才需要 Checkpointer**：要用 `interrupt()` / `Command` 做图级 HITL 并精确恢复中断点 / 需要图级断点续传（长任务崩溃后从最后完成节点恢复）/ 图内部跨节点临时状态不适合落业务表。

📌 **选型原则：持久化跟着会话管理权走**。会话归业务层管，就用业务层持久化；只有"图内部状态本身需要存活"时才上 Checkpointer。

### 4.2 HITL 人工介入：两种写法（本项目暂未启用，作选型参考）

- **静态中断** `interruptBefore: ['risk']`：到达某节点无条件暂停。最简单，但无法携带上下文给前端。
- **动态中断** `interrupt()`（推荐）：节点内调用，可携带自定义 payload（问题 + 预览），前端渲染确认组件后用 `Command({ resume })` 恢复，还可用 `update` 在恢复前修改 state。

**与 UI 协议的天然配套**：第六章的 `confirmation` 组件定义交互形态，`interrupt()` 提供运行时暂停与双向传值能力。**上生产建议直接用动态中断**。

前提依赖：HITL 依赖 Checkpointer，且恢复时 `thread_id` 必须与暂停时一致。业务层确认流程（如已有 confirmation 组件）已够用时不必引入图级中断。

### 4.3 流式输出：节点即进度

- **`streamMode: "updates"`**：按节点推送 State 增量（`{ [nodeName]: partialState }`），驱动 steps 进度条最直接。
- **`streamEvents`（v2）**：更细粒度（chain start/end、LLM token、tool call），适合逐 token 渲染或工具调用可视化。

📌 **核心收益：steps 不再手工硬编码**。节点名本身就是进度定义——新增节点步骤列表自动多一项；路由层提前结束，进度条按实际执行路径自动停在对应位置。**优先用 updates 喂进度条，只在需要 token / 工具级细节时才退到 streamEvents**。

---

## 五、排障方法论：按层定位，不要按症状乱翻

排障思路：先判断问题属于哪一层（路由 / 循环 / 状态 / 持久化 / 前端事件），沿"**输入 → 节点路径 → State 字段 → 条件边 → SSE 事件**"逐步缩小范围。调试首选 `streamEvents` 观察节点实际执行顺序。

**一张排查地图**：

| 现象 | 优先定位点 | 常见修复 |
|---|---|---|
| 请求走错路（分析被当闲聊 / query 跑完整链） | classifier prompt、降级关键词、`routeByIntent`、条件边 mapping | 补需求类关键词、默认意图设 analyze、确认 queryHandler/chatHandler 直连 END |
| 循环不结束（ReAct 一直调工具 / summary 一直被修订） | `shouldCallTools` / `shouldRefine` 的硬上限与退出条件 | 硬上限检查放第一行、prompt 禁止同参重复调用、critic 只留 3–5 条客观标准 |
| 节点没产出（工具一次没调 / 评审从未失败 / HITL 没暂停） | 工具 name/description、`withStructuredOutput` schema、`interruptBefore` 节点名 | 描述写准确、schema 完整、节点名与 `addNode()` 完全一致且编译时启用 checkpointer |
| State 字段异常（analysisResult 为空 / critique 残留 / 正确章节被覆盖） | reducer 设置、critique 清空逻辑、finalize 降级 | critique 通过时返回 `''` 而非 null、refine prompt 强调只改问题部分 |
| 前端进度异常（steps 不更新 / 拿不到 meta） | SSE 事件格式、streamMode、Controller 是否保留 `__interrupt__` 字段 | 统一事件结构、结束时发 done 并 complete() |
| 多轮对话失忆 | JWT 与会话校验、历史消息转换、orchestrate 是否收到上下文 | USER/ASSISTANT 两侧都落库、消息类型正确转换 |

**调试高频结论**：无限循环 = 条件边从未返回 END；State 字段丢失 = reducer 设置不当（messages 追加、业务字段覆盖）；Checkpointer 不生效 = 每次请求重新实例化图或 thread_id 不一致。

---

## 六、本章成果与下一步

**五步演进回顾**：

1. **执行层图化**：StateGraph 承接五段式，硬编码流程迁到可扩展图结构。
2. **路由层显式化**：classifier + 条件边区分分析 / 查询 / 闲聊。
3. **分析节点循环化**：ReAct 子图按需调工具，硬上限保可控。
4. **汇总节点闭环化**：Critic-Refine 子图给报告评审与局部修订能力。
5. **工程能力产品化**：业务层持久化、SSE 节点流、HITL 选型、FAQ 收口。

**与第七章三层框架的对应**：路由层 → classifier 节点 + 条件边；执行层 → 线性子图 + ReAct 子图；优化层 → Critic-Refine 子图。第七章的"按层组合策略"在本章全部映射为图原语。

**第九章预告（单 Agent → Multi-Agent 的升级路径）**：

- Router → Supervisor（决定任务交给哪个专家 Agent）
- ReAct 子图 → 拆分为独立的分析 / 查询 / 风险专家
- Critic-Refine → 从单节点质量闭环扩展为跨 Agent 评审修订
- State → 从服务单 Agent 流程变为多专家协作的共享上下文核心

---

## 七、复习速查

| 问题 | 判断标准 |
|---|---|
| **何时从 LangChain 链迁到 LangGraph 图？** | 出现运行时路径决策 / 循环 / 状态共享 / 人工介入 / 断点恢复 / 节点级进度任一需求。固定直线流程继续用 LCEL |
| **reducer 怎么设？** | 天然累积的字段（messages、日志、工具轨迹）用追加型；草稿/结果类业务字段一律覆盖型 |
| **循环怎么保命？** | 三要素缺一不可：计数字段 + 业务退出条件 + 硬上限；硬上限检查放条件边第一行 |
| **ReAct 还是 Critic-Refine？** | 缺信息（要查数据）→ ReAct；不缺信息只是质量不稳 → Critic-Refine。两者共用回边原语，回边指向不同 |
| **critic 标准怎么写？** | 客观（可验证）、核心（3–5 条）、可终止（明确通过条件 + 上限 2–3 次） |
| **要不要上 Checkpointer？** | 只有需要图级 HITL / 图内断点续传 / 图内部跨节点状态时才用；会话归业务层管就用业务层持久化 |
| **流式模式选哪个？** | 进度条用 `streamMode: "updates"`；token / 工具级细节才用 `streamEvents` |
| **HITL 用哪种中断？** | 最小可用用 `interruptBefore`；上生产用 `interrupt()` + `Command({ resume })`（可携带 payload、双向传值） |

**一句话总结**：LangGraph 不是为了把简单的事搞复杂，而是让本来就复杂的控制流变得**好写、好看、好测、好恢复**——直线能搞定的问题就别画图；一旦涉及分流、循环、质量闭环或人工介入，图结构比手写 if-else 靠谱得多。
