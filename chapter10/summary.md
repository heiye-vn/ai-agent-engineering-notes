# 第十章教程总结：Token 经济学——在 AI 能力与运行成本之间寻找平衡

> 来源：《AI Agents 开发实践》第十章（autix-demo `feat/token` 分支）
> 核心命题：第九章的 Multi-Agent 跑起来了，但它每跑一次要花多少钱？——把 Token 从"看不见的消耗"变成可度量、可治理的工程资源
> 主线：Token 基础与定价 → 用第九章真实账目拆成本 → 上下文为什么膨胀 → 六种省 Token 策略（瘦身 / 裁剪压缩 / Prompt Caching / 模型分级 / 采集落库 / 预算降级）→ 落地顺序与 FAQ
> 承接第九章：单次需求分析调模型 9–12 次，同一份上下文在多个节点间被反复传输，成本问题无法再回避

---

## 一、Token 是运行成本，不是概念（10.1）

**基本事实**

- Token 既不是字也不是词，是模型词表中的最小单元；英文约 4 字符/token（≈0.75 词），中文 1 个汉字通常占 1–2 token。
- 一次调用分**输入 Token**（system prompt + 工具定义 + 对话历史 + 用户输入 + 中间状态）与**输出 Token**（模型生成内容），**两者单价不同**。
- 三个结构性规律比具体价格更重要：**输入输出分开计费｜输出通常更贵｜强模型与小模型价差可能极其悬殊**。

| 模型/系列（写作时示例价，非长期报价） | 输入 /1M | 输出 /1M | 缓存输入 /1M | 上下文窗口 |
|---|---|---|---|---|
| GPT-4o | $2.50 | $10.00 | $1.25 | 128K |
| GPT-4o-mini | $0.15 | $0.60 | $0.075 | 128K |
| Claude Sonnet 系列 | 约 $3.00 | 约 $15.00 | 约 $0.30 | 约 200K |
| Claude Haiku 系列 | 约 $0.80–1.00 | 约 $4.00–5.00 | 约 $0.08 | 约 200K |
| DeepSeek Chat | $0.27 | $1.10 | — | 随版本变化 |

**上下文窗口是硬约束**：128K 看起来很多，但 system prompt 2–5K + 工具定义 1–3K + 20 轮历史 5–15K + 工具结果（JSON）2–5K ≈ **25–28K**，再留出输出空间，实际可用远不足 1/4。

---

## 二、用第九章的图算一笔真实账（10.2）

输入需求："移动端扫码签到 + 蓝牙围栏校验 + 批量导出 Excel + 跨境数据合规"，按节点逐项估算：

| 步骤 | 调用者 | 输入 Token | 输出 Token | 累计输入 |
|---|---|---|---|---|
| 1 | Triage / Classifier | ~1200 | ~80 | 1200 |
| 2 | Extract Agent | ~2000 | ~400 | 3200 |
| 3 | Clarify Agent | ~2500 | ~200 | 5700 |
| 4 | Supervisor | ~1500 | ~100 | 7200 |
| 5 | Functional Expert（ReAct ×2） | ~3000 | ~600 | 10200 |
| 6 | Security Expert（ReAct ×3） | ~4500 | ~800 | 14700 |
| 7 | Aggregator | ~1800 | ~200 | 16500 |
| 8 | Risk Agent | ~2200 | ~500 | 18700 |
| 9 | Summary / Critic-Refine ×2 | ~5000 | ~1200 | 23700 |

**合计：输入 ~23,700 + 输出 ~4,080 tokens ≈ $0.100/次（约 ¥0.73）**

放到调用量里差距立刻显现（日均 200 次）：全 GPT-4o 约 **$600/月** → 全 4o-mini 约 $36/月 → 混合模型（本章策略）约 **$90/月**。

### 2.1 为什么 Multi-Agent 贵：4 类重复传输

LLM API 无状态，每次调用都要完整重发上下文。Multi-Agent 把一次分析拆到多节点，同一份内容被反复搬运：

1. **对话历史**——多数框架（含 LangGraph `MessagesAnnotation`）**默认全量发送**（不是"必须全部"，而是"默认全部"）
2. **System Prompt**——每个 Agent 的角色提示词、约束、输出格式，几百到几千 token，每次都发
3. **Tool Schema**——function calling 的工具 JSON Schema 必须随请求注入，**工具越多越严重，是最容易被低估的大头**
4. **中间推理结果**——Extract → Clarify → Supervisor → Expert 链上前序输出持续累积

📌 **一句话**：Multi-Agent 贵不是单纯因为 Agent 多，而是因为无状态调用让上下文、工具定义、中间结果在 Agent 之间反复传输。10.4–10.7 的所有策略，本质都在做同一件事——**让同一份内容不要反复重发**。

### 2.2 估算器 `token-estimator.ts`

| 函数 | 职责 |
|---|---|
| `estimateTextTokens(text)` | 中文（含中文标点）按 1 token/字，其余按 0.25 token/字符，`Math.ceil` 取整；零依赖，不引 tiktoken |
| `getModelPricing(modelName)` | 内置价格表，未知模型回退 gpt-4o-mini |
| `estimateGraphNodeCost(input)` | systemPrompt + toolSchemas + messages 拼接估输入，outputText 估输出，算成本 |

⚠️ 它只回答"这条链路大概多少钱"（**设计期**粗估）；**精确值必须靠 10.8 的 `withTokenUsage` 从 provider usage 读取**。中文 1 字 ≈ 1 token 是刻意简化。

---

## 三、上下文为什么会膨胀（10.3）

**五个驱动力**

1. **State 字段累积**：`clarified` / `analysisResult` / `riskResult` 被下游节点读取，全是输入 token
2. **messages 用 append reducer**：只增不减，每个专家的对话历史都在里面堆
3. **Tool schemas 每次调用都发送**：Functional 带 3 个工具、Security 带 2 个，description + schema 完整重发
4. **每个 Expert 拿到完整的已澄清需求**：`clarified` 在所有专家节点被完整传入
5. **Critic-Refine 循环倍增成本**：每轮都重发前面全部上下文

📌 **关键洞察**：Multi-Agent 的 token 成本**不是各节点之和，而是随上下文累积放大**（加速增长）。最贵的两个节点是 **Security Expert**（ReAct ×3 工具循环多）和 **Summary/Critic**（要读所有前序分析结果）。

---

## 四、策略一：Prompt 与工具定义瘦身（10.4）

提示词是每次调用都发的**固定成本**，最容易落地、最容易长期受益。

- 案例：Supervisor 提示词从"非常专业的需求分析调度员…"（约 180 token）压成结构化规则块（约 140–160 token），省 10%–25%。
- 真正的大收益来自两类场景：**上千 token 的长角色说明压成结构化规则**；**Multi-Agent 下同类 system prompt 被多次调用反复发送，单次几十 token 的节省被调用次数放大**。

**优化清单**：删礼貌用语（"请/非常感谢"不改善判断）→ 删重复说明 → 用缩写（"澄清需求"而非"已经澄清过的需求信息"）→ 结构化列表替代叙述段落 → 规则进 system prompt、示例用 few-shot 按需加。

**工具定义瘦身**：`description` 从一段话压成短语，`schema.describe()` 同步精简。单次省 50–100 token；Security Expert 一次 ReAct 调 3 次工具就是 150–300 token，全图累计可观。

---

## 五、策略二：消息裁剪与摘要压缩（10.5，优先级最高）

`messages` 常是输入 token 的最大来源，而 `MessagesAnnotation` 只增不减。

### 5.1 滑动窗口 `message-trimmer.ts`

- 抽出全部 SystemMessage 单独保留；其余 `slice(-maxMessages)`（默认 20）；清理孤立工具消息后拼回。
- **核心难点：tool_calls 与 ToolMessage 必须成对保留**。截断带 `tool_calls` 的 AIMessage 却留着对应 ToolMessage，provider 会报错或让模型基于不完整上下文续写。
- `removeOrphanToolMessages` 采用**"全有或全无"精确配对**（三遍扫描）：
  1. 收集窗口内所有 ToolMessage 的 `tool_call_id` → `respondedToolCallIds`
  2. 每条 AIMessage 的**每一个** tool_call.id 都能在集合中找到才算幸存，其 id 进入 `survivingToolCallIds`
  3. 组装：普通消息直通；AIMessage(tool_calls) 仅幸存者保留；ToolMessage 仅 id ∈ `survivingToolCallIds` 才保留
- ⚠️ 不可退化为"前面是否存在任意 AIMessage(tool_calls)"的近似判断。

### 5.2 摘要压缩 `conversation-compressor.ts`

- 早期消息交给 `summaryModel`（接口注入，**不直接 import 真实模型**）压成 `[对话摘要]` 开头的 SystemMessage，保留最近 `keepRecent`（默认 10）条。
- 摘要 prompt 要求保留：需求编号、功能描述、用户意图、已完成的操作；长度 ≤ `summaryMaxTokens`（默认 500）。
- **压缩本身也花 token**：只在对话很长时才划算，经验阈值是**被压缩消息超过 2000 token**；用 `deepseek-chat` 这类小模型做摘要可把成本压得很低。
- ⚠️ `conversation-compressor` 内部**不再调** `trimMessagesForContext`——调用顺序（先裁剪、再压缩）由使用方控制。

### 5.3 两种策略对比

| 维度 | 滑动窗口 | 摘要压缩 |
|---|---|---|
| 实现复杂度 | 简单（纯数组操作） | 中等（需额外模型调用） |
| 信息保留 | 丢失早期信息 | 保留关键信息摘要 |
| 额外成本 | 无 | 每次压缩一次小模型调用 |
| 适用场景 | 轮数多但早期信息不重要 | 早期含关键上下文（需求编号、业务约束） |
| **推荐组合** | **先摘要压缩早期对话，再对结果做滑动窗口硬截断** | |

---

## 六、策略三：Prompt Caching 与稳定前缀（10.6）

**原理**：前缀没变就复用上次的计算结果（近似理解为 KV Cache 类机制），**不改变回复内容**，只降低重复前缀的输入处理成本。

| 厂商 | 机制 | 命中折扣（示例） | 最小前缀（示例） | 过期（示例） |
|---|---|---|---|---|
| OpenAI | 自动，无需配置 | 输入价 50% off | 1024 tokens | 5–10 分钟 |
| Anthropic | 显式 `cache_control` | cache read ≈ 普通输入价 10%；cache write 通常**更贵** | Haiku 约 1024；Sonnet/Opus 约 2048 | 常见 5 分钟 |
| DeepSeek | 自动识别相同 prefix | cache hit 显著低于 miss | 需较长稳定前缀 | 较短 |

**省钱示例**：第 2 次调用（5 分钟内）前 2000 token 命中缓存 → 成本从 $0.00525 降到 $0.0045，约省 14%。

**核心原则：把不变的内容放前面，变化的内容放后面。**

```tsx
// ✅ system prompt（不变）→ 工具定义（不变）→ 对话历史（部分可缓存）→ 用户新输入（不可缓存）
// ❌ 用户输入在最前 → 前缀每次都不同 → 缓存永不命中
```

**Anthropic 的坑**：`system` 必须写成 **block array 形式**才能挂 `cache_control`（`system: 'You are ...'` 字符串形式挂不上）；且**最小可缓存前缀有长度门槛**，太短的 system prompt 挂了也不进缓存。命中统计看响应 `usage`：`cache_creation_input_tokens` / `cache_read_input_tokens`。

📌 `cache-monitor.ts` 是**可选观测示例**——若已在 `token_usages.cachedInputTokens` 记录缓存命中，就不必单独建这个文件。

---

## 七、策略四：模型分级与节点级模型选择（10.7）

不是所有节点都需要最强模型：**高风险节点保强模型，低复杂度节点用便宜模型**。

### 7.1 `AgentModelSet`（9 个角色 → modelConfigId）

| 角色 | 默认模型 | 理由 |
|---|---|---|
| supervisor | gpt-4o | 调度决策需强推理 |
| functional / performance / risk | gpt-4o-mini | 中等复杂度，有工具辅助 |
| security / compliance | gpt-4o | 安全严谨、法律敏感 |
| summary / critic | gpt-4o | 报告质量与质量审查要求高 |
| compressor | deepseek-chat | 最便宜的活，专用省钱 |

`HIGH_RISK_AGENTS = ['supervisor', 'security_expert', 'compliance_expert', 'critic', 'summary_agent']`

### 7.2 `resolveModelForAgent` 三层决策（严格按序）

1. **预算 ≥100%**：compressor → 用默认模型（豁免，reason=null）；其余 → 记 `budget_exceeded_reject`
2. **预算 80–100% 且非高风险** → 降级到 `compressorModelConfigId`，reason=`budget_tight_downgrade (X%)`
3. **需求低复杂度且非高风险** → 同上，reason=`low_complexity_downgrade`
4. 否则按角色查表

### 7.3 成本对比（示例估算）

| 方案 | 单次 | 月度（200 次/天） |
|---|---|---|
| 全部 GPT-4o | ~$0.100 | ~$600 |
| Supervisor/Critic 4o + Expert 4o-mini | ~$0.025 | ~$150 |
| ＋ Prompt Caching | ~$0.018 | ~$108 |
| ＋ 消息裁剪/压缩 | ~$0.015 | **~$90** |

同样假设下成本下降约 **85%**。⚠️ 至此只是**声明与决策层**：`AgentModelSet` / `resolveModelForAgent` 已实现但**尚未接入主图**，子图从"单 model"升级为"ModelSet"的代码只作为文档示例，不改第九章 `experts.ts`。

---

## 八、策略五：节点级 Token 采集与落库（10.8）

前四类策略解决"如何降本"，但要回答"省了多少、哪个节点最贵"，必须有数据。

### 8.1 三层设计

`模型调用（provider 返回 usage）` → `节点归因（withTokenUsage 标注 graph/node/agent）` → `持久化（TokenUsageService 写 token_usages）`

### 8.2 `token_usages` 表（关键字段）

`conversationId / messageId / threadId`（可空）、`graphName + nodeName`（定位节点）、`agentName`（定位角色）、`modelConfigId`、`modelName`、`provider`、`inputTokens / outputTokens / totalTokens / cachedInputTokens`、`estimatedCostUsd`、**`isEstimated`（区分精确值与估算值）**、`latencyMs`、**`overrideReason`（降级原因）**、`createdAt`；索引 5 个：`conversationId`、`(graphName,nodeName)`、`agentName`、`modelConfigId`、`createdAt`。

### 8.3 `TokenUsageService`

`recordUsage`（try/catch，失败只 `console.warn` 不抛）、`getMonthlyStats`（月初起聚合成本/各类 token/调用数）、`getStatsByNode` / `getStatsByAgent`（按成本降序）、`isOverBudget(monthlyBudgetUsd)`。

### 8.4 `withTokenUsage` 包装器

- 计时 `latencyMs` → 调 `fn()` → `usageService` 为 `null` 直接返回。
- **优先**从 `response_metadata.usage` 或 `usage_metadata` 提取（兼容 OpenAI `prompt_tokens/completion_tokens/prompt_tokens_details.cached_tokens` 与 Anthropic 风格 `input_tokens/output_tokens/cache_read_input_tokens`），此时 `isEstimated=false`。
- **抽不到才估算**：`outputTokens = estimateTextTokens(content)`，`inputTokens = outputTokens × 5`（**依据 10.2 真实样本输入≈5.8×输出，保守取整**；实际场景在 3–7 波动），`isEstimated=true`。
- 成本：普通输入 × `pricing.input` + 缓存输入 × `(pricing.cachedInput || pricing.input)` + 输出 × `pricing.output`。

📌 **设计原则：记录失败不影响主流程**。Token 采集是"尽力而为"的辅助能力，绝不做业务阻塞点；`usageService` 可注入 null，测试全 mock。⚠️ 本节只交付"采集 + 持久化"工具，**主图尚未接入**（接入示例见 10.9.3，属后续工作）。

**工程注意**：Prisma 7 需 `@prisma/adapter-pg` 适配器初始化；第十章用独立 demo 库 `autix_chat_demo`，不影响主库 `autix_chat`；改完 schema 必须**先 `db push` 再 `generate`**，否则 typecheck 通不过。

---

## 九、策略六：预算阈值、降级与拒绝（10.9）

把 10.7（模型分级）和 10.8（用量数据）连起来：**预算紧张自动降级，预算耗尽拒绝调用**。三个动作：`allow` / `downgrade` / `reject`。

`resolveBudgetAction` 决策顺序：

| 预算区间 | 判定 |
|---|---|
| < 80% | `allow`，reason=`budget OK (X%)` |
| 80–100% | 高风险 → `allow`（不降级）；其余 → `downgrade` |
| ≥ 100% | compressor → `allow`（豁免，它本身就是省钱工具）；其余 → `reject` |

**逐角色策略**：supervisor / security / compliance / critic / summary → 预算紧张不降级、耗尽拒绝（调度错误影响全局、安全不能用弱模型、合规法律敏感、审查降级形同虚设、报告质量要求高）；functional / performance / risk → 可降级、耗尽拒绝；compressor → 紧张不降级、**耗尽豁免**。

**接入串联**（示例，非已完成集成）：`getMonthlyStats` → 算 `budgetPercent` → `resolveBudgetAction`（reject 则跳过并写 `[agentName 因预算耗尽被跳过]` 占位）→ `resolveModelForAgent` 选模型 → `createChatModel` → `withTokenUsage` 执行并记录 `overrideReason`。

⚠️ **降级后的质量标注**：`overrideReason` 落库，前端可在 UI meta 标注"此分析使用了降级模型"，让用户知情。

📌 职责分离：`resolveModelForAgent` 管"选哪个模型"，`resolveBudgetAction` 管"是否执行 / 是否降级 / 是否拒绝"，两者不混写；`HIGH_RISK_AGENTS` 优先 import 复用而非复制。

---

## 十、落地顺序与 FAQ（10.10）

**三步推进**：

1. **先做无侵入改造**——模型分级、Prompt Caching、提示词瘦身，不动主业务流程，适合第一轮
2. **再处理上下文增长**——成本主要来自多轮对话 / ReAct 循环 / 长工具返回时，引入滑动窗口 + 摘要压缩
3. **最后补齐治理闭环**——Token 采集与预算控制偏运行时治理，系统稳定后接入，用于持续发现异常成本并自动兜底

| 常见问题 | 对策 |
|---|---|
| usage 记录失败怎么办？ | `catch` 降级为 `console.warn`，不中断主流程；需要更强保障可加本地日志或异步队列，但绝不做阻塞点 |
| 模型降级后质量下降？ | `overrideReason` 落库 + 前端 meta 标注让用户知情；`HIGH_RISK_AGENTS` 保证安全/合规等关键 Agent 永不降级 |
| Prompt Caching 命中率低？ | 检查消息顺序（System + 工具定义必须最前）；Anthropic 确认 `cache_control` 位置；连续请求间隔别超缓存过期（OpenAI 5–10 min，Claude 5 min） |
| 摘要丢了关键信息？ | 调大 `summaryMaxTokens`；用 `keepRecent` 控制只在 >10 轮才压缩；**关键业务信息（需求编号、约束）写进 State 独立字段，而不是只存在 messages 里** |

**本章测试策略（mock-first）**：不接真实 LLM 与数据库，`bun test test/chapter10-token-economics.spec.ts` 约 200ms 跑完，适合 pre-commit / CI fast-lane；验证的是裁剪规则、成本计算、降级决策、字段写入等**工程逻辑**，模型输出质量交给集成测试或 evaluator。

---

## 十一、本章代码产物清单

| 文件 | 作用 | 是否接入主图 |
|---|---|---|
| `services/chat/src/llm/cost/token-estimator.ts` | 设计期成本估算（价格表 + 文本估算） | 工具，按需调用 |
| `services/chat/src/llm/context/message-trimmer.ts` | 滑动窗口裁剪 + tool_calls 精确配对 | 未接入 |
| `services/chat/src/llm/context/conversation-compressor.ts` | 早期对话摘要压缩（注入 SummaryModel） | 未接入 |
| `services/chat/src/llm/cost/agent-model-set.ts` | 按角色的默认模型集 + `resolveModelForAgent` | 未接入 |
| `services/chat/src/llm/cost/token-usage.service.ts` | usage 落库与月度/节点/Agent 聚合 | 未接入 |
| `services/chat/src/llm/cost/with-token-usage.ts` | 节点级采集包装器（usage 提取 + 估算兜底） | 未接入 |
| `services/chat/src/llm/cost/budget-policy.ts` | `resolveBudgetAction` 预算动作决策 | 未接入 |
| `services/chat/prisma/schema.prisma` | 新增 `token_usages` 表 | 已加 schema |
| `services/chat/test/chapter10-token-economics.spec.ts` | 777 行 mock-first 单测 | — |

📌 **共同特征**：本章交付的都是一层可插拔的**策略工具**，主图暂未改动；接入方式在文档里给示例代码。

---

## 十二、复习速查

| 问题 | 判断标准 |
|---|---|
| **多 Agent 为什么贵？** | 无状态 API 导致上下文、system prompt、tool schema、中间结果 **4 类反复传输**；成本随上下文累积放大，不是各节点简单求和 |
| **6 种策略怎么排优先级？** | 先无侵入（提示词/工具瘦身、模型分级、Prompt Caching）→ 再上下文（裁剪 + 摘要压缩）→ 最后治理（采集 + 预算） |
| **消息裁剪最容易踩的坑？** | tool_calls 与 ToolMessage **成对保留**，按 `tool_call_id` 精确配对、"全有或全无"，不能近似判断 |
| **什么时候该用摘要压缩？** | 被压缩内容 > 2000 token 才划算；用最便宜的小模型做摘要，且关键信息别只放 messages |
| **Prompt Caching 的关键原则？** | 不变在前、变化在后；Anthropic 必须 block array 挂 `cache_control`，且前缀有最小长度门槛 |
| **模型分级怎么定？** | 高风险（supervisor/security/compliance/critic/summary）保强模型；低复杂度或预算紧张时才降级；compressor 永远用最便宜的 |
| **降级策略的边界？** | 80–100% 只降非高风险；≥100% 只豁免 compressor，其余 reject；`overrideReason` 必须落库并透出到 UI |
| **怎么知道钱花在哪？** | `withTokenUsage` 采集节点级 usage → `token_usages` 落库 → 按 node / agent 聚合；精确值优先取 provider usage，估算是兜底（`isEstimated` 标记） |
| **采集/记录会不会拖垮主流程？** | 不会——`usageService` 可注入 null，失败只 warn；它是辅助能力，不是阻塞点 |

**一句话总结**：这一章把 Token 从"看不见的消耗"变成可度量的成本结构——**先算清楚账**（估算器 + 节点级采集），**再压住上下文**（瘦身、裁剪、压缩、缓存），**最后建立治理机制**（模型分级 + 预算降级与拒绝）。九章搭起来的 Multi-Agent 图由此不只是"能跑"，而是知道钱花在哪里、哪些调用可以省、什么时候必须保质量、什么时候应该停下来。

**下一步：进入 RAG**——让 AI 更懂你的业务知识（第十一章）。
