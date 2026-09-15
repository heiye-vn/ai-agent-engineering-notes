# 第九章教程总结：LangGraph Multi-Agent——Supervisor、Handoff 与组合流水线

> 来源：《AI Agents 开发实践》第九章（feat/LangGraph 分支）
> 核心命题：当一个 Agent 不够用时，怎么办？——把第八章的单 Agent 图升级为 Multi-Agent 系统
> 主线：单 Agent 的三个症状 → Supervisor + 专家集群 → 并行分发 → Handoff 分诊 → Plan-and-Execute + Reflexion 外层流水线 → 生产化（错误降级 / HITL / 并行 UI / 成本控制）→ FAQ
> 承接第八章：Multi-Agent 不引入任何新原语，本质是"子图编排"——把"子图作为节点"用到更大规模；不含实现代码，只梳理知识点、选型对比与实践原则

---

## 一、为什么需要 Multi-Agent：三个症状定位根因

第八章的单 Agent ReAct 子图在需求类型扩展到"功能/性能/安全/合规"四大类后，会同时打破三件事：

| 症状 | 根因 | Multi-Agent 的对策 |
|---|---|---|
| 模型经常选错工具、参数传错 | 单 Agent 上下文里 15+ 工具签名互相干扰，判断力下降 | 每个领域的工具只暴露给对应专家 |
| system prompt 失控、token 成本爆炸 | 要同时讲四个领域的分析规范 | 每个专家的 prompt 只讲自己的领域 |
| 想单独优化"安全评审"却波及所有领域 | 单体节点耦合了所有职责 | 专家子图独立迭代、独立评估 |

📌 **判断信号**：不是"需求多了就上 Multi-Agent"，而是出现**工具膨胀导致选错、prompt 膨胀导致成本失控、调优互相牵连**这三类症状时才拆。拆的本质是**职责隔离**，不是堆 Agent 数量。

**最重要的认知**：每个专家 Agent 就是一张和第八章 ReAct 子图**完全同构**的图，只有三个变量不同——工具集、system prompt、写入的 State 字段。Multi-Agent 模式只是"怎么编排这些子图"。主图完全不用改，只要新子图的输入输出契约不变（读 `clarified`、写 `analysis`），主图对此无感——这是"子图作为节点"的复利兑现。

---

## 二、Supervisor：中心化调度（9.2）

### 2.1 结构与职责

`supervisor →（按需分发）→ N 个专家子图 → aggregator`

- **supervisor**：轻量调度节点，用结构化输出判断本次需要哪些专家（`activeExperts` 数组），不执行任何分析。
- **专家子图**：工厂函数参数化创建，四个专家只是同一个模板的四次调用。
- **aggregator**：只读各专家的 outputField、只写汇总字段，把选中专家的结论合成结构化报告。

### 2.2 Supervisor 的 prompt 设计要点

调度结果偏保守（总是只选 functional）是最常见的坑，对策：

1. **把"何时该选"显式写进 prompt**——逐条列出判断规则（涉及批量操作 → 必须包含 performance；涉及权限/数据访问 → security；涉及跨境/个人信息 → compliance；任何需求至少包含 functional）。
2. **zod schema 用 `.describe()` 给每个选项加说明**，结构化输出的元信息直接影响选择稳定性。
3. **`.min(1)` 约束不可省**——空数组会让条件边返回空、图卡死。
4. 确实太简单的请求应该在 triage 层就短路，不进 analysis 子图。

📌 **模型实例传递原则**：所有专家共用同一个 model 实例（由外层一路透传），不在图内部自行创建——保证行为一致、切换模型只改一处配置。

---

## 三、并行分发：条件边返回数组（9.3）

### 3.1 机制

条件边路由函数**返回数组而非单个字符串**，LangGraph 会并发触发所有目标节点，并自动等它们全部到达汇合节点（aggregator）后再继续。三个专家各 4 秒：串行 12 秒 → 并行约 4 秒（取最慢的）。

### 3.2 并发写 State 的关键细节

- 每个专家写**各自独立的 outputField** → 默认覆盖式 reducer 不冲突。
- **并发写同一字段必须用追加/合并 reducer**，否则并发写入变成"随机保留一个"——这是并行场景最容易踩的坑。
- **最严重的问题：多个专家同时往 `messages` 写入**。追加型 reducer 会让四个专家的工具调用对话交叉污染。对策：专家结论只写 outputField，子图内部需要 messages 就在局部维护，不回传主图。

### 3.3 与手写 Promise.all 的对比

| 维度 | Promise.all | 图原生并行 |
|---|---|---|
| 并发表达 | 手动 await | 条件边返回数组，引擎自动并发 |
| 状态共享 | 手动合并各 Agent 输出 | State + reducer 自动合并 |
| 错误处理 | 一个失败全体失败 | 节点级失败可单独降级 |
| 可观测性 | 手工打日志 | streamEvents 自动分别上报每个并发节点 |
| 持久化 | 中间状态自己存 | Checkpointer 自动快照已完成的并发分支 |

**Checkpointer 部分尤其关键**：4 个专家 3 个完成、1 个挂起，断点恢复后**只重跑未完成的那一个**，不重复消耗已完成专家的 token——Promise.all 完全做不到。

### 3.4 验收要点

调度正确性（不同输入选中不同专家组合）、并行效果（总耗时接近最慢专家而非总和）、输出完整性（每个被调专家有对应字段、报告含必需章节）、容错（单专家失败不拖垮整体）、工具调用在 maxSteps 限制内。

---

## 四、Handoff：去中心化交接（9.4）

### 4.1 与 Supervisor 的分工

| 场景 | 选择 |
|---|---|
| 一个请求明确涉及多个独立维度（功能+性能+安全） | Supervisor |
| 分诊场景：先粗判，简单问题直接回，复杂问题转专家 | Handoff |
| 对话连续性重要：前一个 Agent 把上下文"交接"给下一个 | Handoff |

### 4.2 落地形态：classifier 升级为 triage

原 classifier 只做意图分类，闲聊也要走"分类 → chatHandler"两步。升级为 triage Agent 后：

- 结构化输出三选一：`answer`（直接回答）/ `handoff_to_query` / `handoff_to_analysis`
- **chat 短路**：闲聊由 triage 直接回答并路由到 END，省一次 LLM 调用
- `intent` 字段类型不变，前端 SSE / UI 协议无感知——升级收敛在节点内部

📌 **两种模式可以共存，且生产系统常见组合就是共存**：外层 Handoff（triage 粗分诊）+ 领域内 Supervisor（analysis 子图内部派发专家）。

---

## 五、组合流水线：Plan-and-Execute + Reflexion（9.5）

### 5.1 解决什么问题

单需求分析已够用，但**跨多个工单的联合分析**处理不好（如"评估本季度三个需求对核心系统的总体影响"）。这类任务需要：先规划（拆成步骤）→ 再执行（逐步调用已有能力）→ 最后复盘（总报告不达标时整体重跑）。

关键定位：**不替代 9.2/9.3，而是包在外层**。executor 不是新写分析逻辑，而是把整张分析图当成一次调用。

### 5.2 外层结构

`planner → executor →（还有步骤?）→ evaluator →（不通过?）→ reflector → executor`

- **planner**：大任务拆解为 1–10 个步骤，每步 description 可直接作为需求分析系统的输入。
- **executor**：按 `currentStepIndex` 逐步调用完整分析图；子任务用独立 thread_id（`{parentThreadId}:step-{index}`）——每步状态独立持久化、独立恢复，天然支持"某步失败单独重跑"。
- **evaluator**：通读所有步骤结果拼成总报告，按 0–100 评分决定通过与否。
- **reflector**：分析为什么不达标，修订计划（补步骤/调顺序），`currentStepIndex` 归零带着反思重跑。

### 5.3 Reflexion vs Critic-Refine：回边指向不同

| 维度 | Critic-Refine（8.7） | Reflexion（9.5） |
|---|---|---|
| 回边指向 | refine → critic（局部修订） | reflector → executor（**整条链起点**） |
| 修订对象 | 最终产出的表达质量 | 计划本身（可能是前面步骤信息不足） |
| 成本 | 低（纯 LLM 局部调用） | 高（整链重跑） |
| 硬上限 | 2–3 次 | **最多 1 次**（retryCount >= 1 强制结束） |

### 5.4 两层错误降级形成防护网

- **专家级** catch：4 个并行专家一个失败不拖垮 analysis 子图（降级输出标记"暂不可用"）。
- **executor 级** catch：N 个步骤一个失败不拖垮 pipeline（记录 `[执行失败]` 继续推进）。
- 两处兜底信息最终都汇聚到 evaluator，由它决定是否触发 Reflexion。

### 5.5 三种推理模式在最终图中的位置（全书对照表）

| 第七章模式 | 图中位置 | 回边指向 |
|---|---|---|
| Router（路由层） | classifier + triage | 无（一次性分发） |
| Fixed Workflow（执行层） | extract → clarify → analysis → risk → summary 主链 | 无 |
| ReAct（执行层·局部决策） | 每个专家子图 | tools → agent |
| Plan-and-Execute（执行层·全局规划） | 最外层 planner → executor | executor → executor |
| Critic-Refine（优化层·局部修订） | summary 子图 | refine → critic |
| Reflexion（优化层·整体重跑） | evaluator → reflector → executor | reflector → executor |
| Self-Consistency（优化层） | 未采用（适合分类判断，不适合报告） | — |

**适用边界**：Pipeline 适合"明确可拆解"的大任务。高度不确定的探索性任务，单次 Reflexion 可能不够——要么拆成多个独立 Pipeline 调用，要么在外层加人工审核环节。

---

## 六、生产化要点（9.6）

### 6.1 错误降级：带缺口的完整报告优于 500

专家节点 try-catch 后**返回降级输出而非抛错**，aggregator 识别降级标记在报告中标 ⚠️。效果：用户拿到带缺口的完整报告；Critic-Refine 能看到缺口并在修订时补充说明；运维从 streamEvents 错误事件定位哪个专家为什么失败。

### 6.2 HITL 三件套：start / update / resume

- 图工厂接收可选的 `checkpointer` + `interruptBefore` 参数，不传时行为与无状态版完全一致（向后兼容）。
- 中断点选在 `clarifyStep` 前：跑到暂停 → `getState` 拿快照 → 用户补充后 `updateState` 写回 → `invoke(null)` 从断点继续。
- **MemorySaver → PostgresSaver 只换 saver 实例**，HITL 逻辑不动。注意：与会话库共用同一个 PostgreSQL；thread_id 命名规范 `user-{userId}:session-{sessionId}`；**长期运行必须有旧 thread 清理策略**（Checkpointer 按 thread 累积快照）。
- 行为差异：chat/query 意图不触发中断（短路或直通到底），只有 analyze 路径会停在 clarifyStep 前。

### 6.3 并行可视化：双映射 + parallel 旗标

9.2 之后，子图内部节点（supervisor / 各专家 / aggregator）也会触发 node 事件，必须与主图节点**区分处理**：

- **主图节点** → 推进进度条（step 计数，分母固定 6 步）
- **子图节点** → 沿用父 step，打 `parallel: true` 旗标，前端路由到独立并行面板

如果不做双映射：进度条从 6 步膨胀成 12 步，回退一次出现"step 3 → step 9 → step 4"的诡异跳变。`parallel` 旗标要从 orchestrator → controller（SSE payload）→ 前端 store **全程透传**，任何一环丢失都会让专家事件挤进主进度条。

配套细节：只产 JSON 的节点（triage/extract/clarify）过滤 token 事件避免推半截 JSON；专家子图内部的 ReAct 循环也过滤，外层只暴露专家级开始/结束。

### 6.4 成本控制两条线

Multi-Agent + Reflexion 很容易让 token 失控，两条防线：

1. **硬上限**：专家子图 maxSteps=6 / Critic-Refine maxRevises=2 / Reflexion retryCount≤1 / activeExperts 最多 4 个（zod 约束）。
2. **短路路由**：chat 由 triage 直答短路 END、query 直达 queryHandler、单专家需求跳过并发开销、简单需求（文案修改）只走 functional 专家。

---

## 七、Multi-Agent FAQ 排查地图

| 症状 | 根因 | 修复 |
|---|---|---|
| activeExperts 始终只有 functional | supervisor prompt 太保守 / schema 缺说明 / 温度太低 | 显式判断规则 + `.describe()` + 温度 0.3–0.5 |
| activeExperts 为空、图卡住 | schema 缺 `.min(1)` | 补约束；简单请求在 triage 层短路 |
| 并行耗时和串行一样 | 条件边没返回数组 | 确认路由函数返回数组 + 条件边 mapping 完整 |
| messages 出现多专家对话混杂 | 专家并发写共享 messages（追加型 reducer 交叉污染） | 只写各自 outputField，子图内部局部维护上下文 |
| 专家 outputField 为空 | finalize 没执行 / 字段名拼写错 / LLM 空 content | 补 finalize 节点和边、对齐字段名、空值兜底占位 |
| 单专家超时拖垮整个子图 | agentNode 没 try-catch | 降级输出 + aggregator 标记缺口 |
| aggregator 覆盖了专家字段 | aggregator 错误写入了专家字段 | aggregator 只读专家字段、只写汇总字段 |
| 并行面板不显示 / 进度条跳变 | expertSubgraphMap 缺节点 / parallel 旗标中途丢失 | 补全映射 + 全链路透传 parallel + setProgress 顺手清空面板 |
| 正文缺失但进度正常 | jsonNodes 名单配错 / SSE 被代理缓冲 | 核对过滤名单 + 加 `X-Accel-Buffering: no` |
| 专家反复调工具不停 | prompt 没说何时停 / 工具返回信息不足 | prompt 加工具使用策略 + 合理 maxSteps（5–8） |

**调试三板斧**：节点级输入输出日志、streamEvents 观察实际执行路径、同一输入分别跑 Ch8 单 Agent 版和 Ch9 Multi-Agent 版对比行为差异。

---

## 八、复习速查

| 问题 | 判断标准 |
|---|---|
| **何时从单 Agent 拆到 Multi-Agent？** | 出现工具膨胀选错 / prompt 膨胀成本失控 / 调优互相牵连三类症状。没有这些症状就别拆——拆的是职责，不是 Agent 数量 |
| **Supervisor 还是 Handoff？** | 多独立维度需并发评审 → Supervisor；分诊（简单直答、复杂转专家）+ 上下文交接 → Handoff。生产常见两者共存 |
| **并行怎么触发？** | 条件边路由函数返回数组。每个并发节点写独立字段；必须共写一字段时用追加/合并 reducer |
| **专家怎么隔离输出？** | 结论只写各自 outputField，不碰共享 messages；子图内部上下文局部维护 |
| **Reflexion 还是 Critic-Refine？** | 只差在回边指向：局部修订 → refine；计划级/信息级不足需整链重跑 → reflector，上限 1 次 |
| **Pipeline 何时用？** | 明确可拆解的跨工单/跨步骤任务；探索性任务拆成多个独立调用或加人工审核 |
| **HITL 挂哪个节点？** | clarifyStep 前（需求澄清）；用可选参数注入 checkpointer + interruptBefore，不传则无状态向后兼容 |
| **成本怎么防失控？** | 硬上限四件套（maxSteps/maxRevises/retryCount/activeExperts）+ 短路路由（chat/query 直通、单专家跳并发） |

**一句话总结**：Multi-Agent 不是把系统写复杂，而是把已经复杂的需求拆到合适的位置——Supervisor 负责分发，Handoff 负责交接，Plan-and-Execute 负责拆大任务，Reflexion 负责兜底复盘；它们底层依赖的仍然是第八章反复强调的"子图作为节点"。用图结构承载复杂度，用子图原语承载复用，用 State 承载持久化和并发。

**下一章预告**：Multi-Agent 跑起来后单次请求 token 消耗显著上升，第十章进入 Token 经济学——上下文堆积在哪、如何用路由/裁剪/缓存/预算减少无效消耗、成本控制如何做成可观测可配置的工程策略。
