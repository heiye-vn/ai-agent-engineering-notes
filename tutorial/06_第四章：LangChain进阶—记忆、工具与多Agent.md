![image.png](https://p1-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/07cc0ce687ba47f7b91ec91ed15a6aea~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=1080&h=458&s=817889&e=png&b=0c0c35)

本章分支[feat/agent-memory-tools](https://link.juejin.cn/?target=https%3A%2F%2Fgithub.com%2FCookieboty%2Fautix-demo%2Ftree%2Ffeat%2Fagent-memory-tools)

前三章已经完成了 LangChain 基础链路的搭建：模型调用、提示模板、链式编排、结构化输出和工具调用，均已落到可测试的业务接口中。但这条链路仍以单次请求为中心：每轮输入独立处理，系统不会保留上一轮对话，也不会主动读取业务文件，更无法把复杂任务拆分给多个角色协作完成。

本章在前几章的基础上继续推进，重点补齐四类进阶能力：

- 引入会话记忆，支撑多轮需求澄清与上下文延续
- 接入业务工具，读取需求单、规范文档并输出分析报告
- 将文本转换为向量表示，为后续语义检索与 RAG 链路打基础
- 引入 Multi-Agent，说明角色拆分与固定编排的工程实现

> 由于本系列后续章节（第五章）的多 Agent 流水线本身就工作在**需求分析**业务域，因此本章把原先的电商退货示例统一改写为**需求分析**域，五个 Agent 为 `extract / clarify / analysis / risk / summary`，与后续章节的真实编排保持一致。

需要说明的是，LangChain 在 Agent 构建上更强调以 `createAgent()` 作为标准入口。本文为了保持与前几章的工程主线一致，并完整呈现需求分析助手从多轮上下文、工具调用到多角色协作的演进过程，仍以 `messages`、`tools`、`embeddings`、`vector stores` 和 fixed-workflow 多 Agent 作为讲解主线。

本章沿用同一条贯穿案例：需求单 `REQ-2026-001`——「为需求分析对话提供会话记忆」。

示例中的多轮输入固定为：

1. 我们想做一个需求分析助手，希望它能记住多轮对话。
2. 需求单号是 `REQ-2026-001`。
3. 目标用户是需求分析师和产品经理，长对话要能自动裁剪上下文。
4. 帮我判断这个需求是否完整，并产出一份需求分析报告。

后续各节将围绕这条需求依次接入 Memory、Tools、Embeddings 和 Multi-Agent，并在最后收敛为统一的 `analyze()` 接口。

![image.png](https://p3-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/f0de0b54cc18456e8275e7be205292dd~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=2752&h=1536&s=8329916&e=png&b=041124)

✅ **本章验收点**

- 理解 `RunnableWithMessageHistory` 的工作机制，跑通会话级多轮对话
- 掌握 `trimMessages` 的裁剪策略，在长对话下控制 Token 成本
- 实现业务工具（`query_requirement`、`read_file`、`write_file`），让模型读取真实数据并写出制品
- 完成文本向量化（本地小模型），搭建最小嵌入 + 向量数据库链路
- 理解 Multi-Agent 的角色拆分与 Fixed Workflow 编排模式
- 用可运行的 5 Agent 示例完成“抽取 → 澄清 → 分析 → 风控 → 汇总”全流程
- 信息不足时显式产出澄清问题（`clarificationQuestions`）
- 最终将所有能力收束为统一的 `analyze()` 服务接口
- **各阶段均提供可复用 Prompt，正文仅保留关键片段。**

------

## 4.1 多轮需求澄清为什么会失真

![image.png](https://p9-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/f052964d3d4e4ddbad065b27287eb0cf~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=2816&h=1536&s=8441681&e=png&b=051428)配图仅为示例参考，具体内容以文章说明及实际代码为准。

单次调用在演示环境中通常可以满足验证需求，但进入真实需求分析场景后，上下文断裂会很快暴露出来。第三章已经跑通了一条“单轮闭环”链路：用户提交输入，系统组装 prompt，必要时触发工具，再将结果整理为结构化输出。这种方式适合验证模型能力与接口边界，因为输入完整、流程清晰、每次请求都可以独立测试。

真实的需求沟通通常不会一次性给出全部判断条件。需求提出方往往先表达诉求，再补充需求单号、目标用户、约束条件，过程中还可能调整关注点。需求判断所需的信息并不集中在某一次请求中，而是分散在连续多轮对话里。如果系统仍沿用“每轮独立处理”的方式，链路在工程上可以运行，但在业务理解上会逐渐失真。

以上面的 4 轮对话为例，如果系统每次只把当前输入单独发送给模型，会出现以下问题：

- 第二轮只说”需求单号是 `REQ-2026-001`“，模型不知道这条需求要解决什么问题
- 第三轮补充”目标用户是需求分析师、长对话要自动裁剪”时，模型不知道这些是在补充需求约束
- 第四轮要求”判断需求是否完整并产出报告”时，模型如果拿不到前文，就很难给出完整结论

第三章解决的是“单次调用如何做对”，本章继续解决“多次调用之间如何不断线”。决定多轮需求沟通质量的关键，不是某一轮回复是否完整，而是系统能否把分散在多轮中的需求单号、目标用户和核心诉求稳定地组织成同一个任务上下文。对 LangChain 来说，这个上下文最自然的承载方式是 `messages`：它既是跨模型统一的消息抽象，也是后续接入 Memory、裁剪历史和组织多轮链路的基础。

------

## 4.2 Memory：用 RunnableWithMessageHistory 保持上下文

- 🤖 用 AI 生成本节代码（对应 4.2）

  将以下 Prompt 粘贴到 Claude CLI 中执行：

  ```css
  在 services/chat 的 LangChain 层中，接入 Memory 机制，严格按以下要求执行：
  
  1. 安装依赖（如需要）：langchain 相关 memory 模块
  
  2. Memory 服务：
     - 新建 services/chat/src/llm/memory/runnable-memory.service.ts
     - 实现 RunnableWithMessageHistory + InMemoryChatMessageHistory 的多轮对话
     - 实现 trimMessages 消息裁剪版本（maxTokens: 2000, strategy: 'last'）
     - 每个版本支持 sessionId 隔离
     - 对外暴露：chat(sessionId, input)、getHistory(sessionId)、appendMessage(sessionId, human, ai)、clearSession(sessionId)
  
  3. 新增路由（@Controller('api/memory')）：
     - POST chat：接收 { sessionId, input }，返回多轮对话结果
     - GET history/:sessionId：返回当前会话的历史记录
     - DELETE history/:sessionId：清除指定会话记忆
  
  业务场景：需求分析助手
  测试场景（同一 sessionId "s1" 依次发送）：
  第一轮：'我们想做一个需求分析助手，希望它能记住多轮对话'
  第二轮：'需求单号是 REQ-2026-001'
  第三轮：'帮我判断这个需求是否完整'
  ```

本节主要处理两项能力：使用 `RunnableWithMessageHistory` 注入会话历史，并通过 `trimMessages` 控制长对话成本。旧式 `BufferMemory`、`SummaryMemory` 不再展开，因为在当前 LangChain JavaScript 体系中，基于消息历史的实现更统一，也更贴近应用层接口设计。

### 4.2.1 会话历史的读取与注入

![image.png](https://p6-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/6be3451b94bd4181a404d2f875716a37~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=2752&h=1536&s=8252427&e=png&b=041124)

`RunnableWithMessageHistory` 是 LangChain 提供的会话历史包装层，负责把历史消息的读取、注入和保存统一抽象到 Runnable 链路中。对于需求分析场景，核心是按 `sessionId` 隔离不同会话，并把读写接口封装成可复用的服务方法。

这里直接把 4.2.1 的历史注入与 4.2.2 的消息裁剪合并成一份服务实现：在进入 prompt 之前，先用 `trimMessages` 对历史做一次裁剪，再交给 `RunnableWithMessageHistory` 注入。

```tsx
import { Injectable } from '@nestjs/common';
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import {
  RunnableWithMessageHistory,
  RunnablePassthrough,
} from '@langchain/core/runnables';
import { InMemoryChatMessageHistory } from '@langchain/core/chat_history';
import { trimMessages, type BaseMessage } from '@langchain/core/messages';
import { createChatModel } from '../model.factory';

@Injectable()
export class RunnableMemoryService {
  private store = new Map<string, InMemoryChatMessageHistory>();
  private model = createChatModel();

  private prompt = ChatPromptTemplate.fromMessages([
    ['system', '你是一名需求分析助手，请结合历史对话理解用户诉求并给出回答。'],
    new MessagesPlaceholder('history'),
    ['human', '{input}'],
  ]);

  // 长对话下控制 Token：保留最近且必要的上下文
  private trimmer = trimMessages({
    maxTokens: 2000,
    strategy: 'last',
    tokenCounter: this.model,
    includeSystem: true,
    allowPartial: false,
  });

  // 在进入 prompt 之前先对历史做裁剪
  private chain = RunnablePassthrough.assign({
    history: (input: { input: string; history?: BaseMessage[] }) =>
      this.trimmer.invoke(input.history ?? []),
  })
    .pipe(this.prompt)
    .pipe(this.model);

  private getSessionHistory = (sessionId: string) => {
    if (!this.store.has(sessionId)) {
      this.store.set(sessionId, new InMemoryChatMessageHistory());
    }
    return this.store.get(sessionId)!;
  };

  private withHistory = new RunnableWithMessageHistory({
    runnable: this.chain,
    getMessageHistory: this.getSessionHistory,
    inputMessagesKey: 'input',
    historyMessagesKey: 'history',
  });

  async chat(sessionId: string, input: string) {
    const response = await this.withHistory.invoke(
      { input },
      { configurable: { sessionId } }
    );
    return { response: response.content };
  }

  async getHistory(sessionId: string) {
    return this.getSessionHistory(sessionId).getMessages();
  }

  async appendMessage(sessionId: string, human: string, ai: string) {
    const history = this.getSessionHistory(sessionId);
    await history.addUserMessage(human);
    await history.addAIMessage(ai);
  }

  clearSession(sessionId: string) {
    this.store.delete(sessionId);
  }
}
```

这一步的核心变化，是接口从围绕“单次请求”工作，转向围绕“会话”工作。对于需求单 `REQ-2026-001`，系统可以持续保留当前需求、目标用户、上下文约束等关键信息。

📌 **当前项目的实际做法**

> 在当前项目中，`RunnableWithMessageHistory` 用于解释 LangChain 的消息历史注入机制；实际落地时，会话历史已经持久化到数据库 `messages` 表中，并通过 `MessageService` / `DbChatHistory` 转成 LangChain `BaseMessage[]`。因此生产链路不依赖进程内 `InMemoryChatMessageHistory`（见第五章）。 实际流程是：`ConversationController.chat()` 收到用户输入 → `MessageService.addMessage()` 保存用户消息 → `SearchService.similaritySearch()` 做 RAG 检索 → `OrchestratorService.streamOrchestrate()` 执行分析 → assistant 响应再写回 `messages` 表。

### 4.2.2 消息裁剪与 Token 成本控制

只保留历史还不够。需求沟通一旦拉长，原始历史会持续占用上下文窗口。`trimMessages` 提供了一种可配置的裁剪策略，在保留必要上下文的同时控制 Token 消耗。上面的服务实现已经把它接进了链路，这里单独看裁剪器本身：

![image.png](https://p6-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/f6e4e5c776064087ba748852099354b7~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=2816&h=1536&s=7510679&e=png&b=080c2b)

```tsx
const trimmer = trimMessages({
  maxTokens: 2000,
  strategy: 'last',
  tokenCounter: model,
  includeSystem: true,
  allowPartial: false,
});

// 在进入 prompt 之前对历史做裁剪
const chain = RunnablePassthrough.assign({
  history: (input: { history?: BaseMessage[] }) =>
    trimmer.invoke(input.history ?? []),
}).pipe(prompt).pipe(model);
```

在这条案例里，`trimMessages` 的作用很直接：随着对话轮次增加，系统优先保留最近且与需求判断相关的信息，而不是把所有历史原样塞回模型。

📌 **Memory 工程化小结**

- `sessionId` 负责隔离不同会话
- `getHistory()` 负责读取当前上下文
- `appendMessage()` 负责把最终结论写回历史（优先用这个，而不是让模型重跑一遍对话）
- `clearSession()` 负责清理会话状态
- `trimMessages()` 负责在长对话下控制成本
- 存储可替换：`InMemoryChatMessageHistory` 是开发阶段实现，生产可切换到 Redis / 数据库，接口不变

**🧪 验证步骤（对应 4.2）**

使用同一 `sessionId` 依次发送四轮请求，验证多轮记忆是否连贯：

```bash
# 第一轮
curl -X POST http://localhost:4001/api/memory/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"s1","input":"我们想做一个需求分析助手，希望它能记住多轮对话"}'

# 第二轮
curl -X POST http://localhost:4001/api/memory/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"s1","input":"需求单号是 REQ-2026-001"}'

# 第三轮
curl -X POST http://localhost:4001/api/memory/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"s1","input":"目标用户是需求分析师和产品经理，长对话要能自动裁剪"}'

# 第四轮
curl -X POST http://localhost:4001/api/memory/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"s1","input":"帮我判断这个需求是否完整"}'

# 查看历史（应含 8 条：4 human + 4 ai）
curl "http://localhost:4001/api/memory/history/s1"

# 清除会话
curl -X DELETE "http://localhost:4001/api/memory/history/s1"
```

**验收标准**：第四轮回复能识别需求单号和目标用户，不会失忆并重新询问。

使用 `getHistory` 返回 8 条消息。

![image.png](https://p6-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/b3a84236e2464f76917a38ed6f9ef593~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=1622&h=1414&s=1145522&e=png&b=1f1f1f)配图仅为示例参考，具体内容以文章说明及实际代码为准。

清除会话后再次调用 `getHistory` 返回空数组。

![image.png](https://p1-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/2ae8a6de9fd146fe8b7186c05b3eb8f7~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=1622&h=306&s=137114&e=png&b=1f1f1f)配图仅为示例参考，具体内容以文章说明及实际代码为准。

------

## 4.3 Tools：读取需求单、规范文档，并写出分析报告

- 🤖 用 AI 生成本节代码（对应 4.3）

  将以下 Prompt 粘贴到 Claude CLI 中执行：

  ```bash
  在 services/chat 的 LangChain 层中，接入文件系统与业务查询工具，严格按以下要求执行：
  
  1. 工具定义：
     - 新建 services/chat/src/llm/tools/business.tools.ts
     - 使用 tool() + zod schema 定义以下工具：
       - query_requirement：根据需求单号读取 workspace/requirements/{requirementId}.json
       - read_file：读取 workspace/ 下指定路径的文件内容（规范、标准等）
       - write_file：将内容写入 workspace/ 下指定路径（分析报告、制品）
     - 所有文件操作限制在 workspace/ 目录下（safePath 沙箱校验）
  
  2. 文件系统服务：
     - 新建 services/chat/src/llm/filesystem/filesystem.service.ts
     - 绑定上述工具到模型
     - 实现完整的工具执行闭环（参考第三章 3.8 的 tool-loop 模式）
  
  3. 新增路由（@Controller('api/files')）：
     - POST chat：接收 { input }，模型可按需调用工具读写文件
  
  业务场景：需求分析助手
  测试场景（workspace 内的相对路径，不带 workspace/ 前缀）：
  - '查询需求单 REQ-2026-001 的详情'
  - 如需验证 read_file，可先在 workspace 下补充 standards/requirement-spec.md
  - '把需求判断结论写入 reports/REQ-2026-001-analysis.md'
  ```

接入 Memory 后，系统可以保留对话上下文，但仍然无法获得需求单详情、规范文档和验收标准。下一步需要让模型通过受控工具读取业务数据，而不是依赖提示词补全事实。

本节的重点不是通用的 `read_file` / `write_file` 能力本身，而是先定义需求分析场景中真正需要的业务工具。对当前案例而言，`query_requirement(requirementId)` 比“任意读文件”更接近真实系统中的能力边界。

![image.png](https://p9-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/6b33e9dfc4d541b8a8000e0fb51b1ecb~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=2816&h=1536&s=8183750&e=png&b=041227)

### 4.3.1 三类业务工具：查询、读取与写入

```tsx
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { tool } from '@langchain/core/tools';

const WORKSPACE_ROOT = path.join(process.cwd(), 'workspace');

// 路径沙箱：所有文件操作必须落在 workspace/ 内，防止路径逃逸
export function safePath(filePath: string) {
  const resolved = path.resolve(WORKSPACE_ROOT, filePath);
  if (!resolved.startsWith(WORKSPACE_ROOT)) {
    throw new Error('路径不允许逃逸工作目录');
  }
  return resolved;
}

export const queryRequirementTool = tool(
  async ({ requirementId }: { requirementId: string }) => {
    const full = safePath(`requirements/${requirementId}.json`);
    if (!fs.existsSync(full)) return { error: `需求 ${requirementId} 不存在` };
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  },
  {
    name: 'query_requirement',
    description: '根据需求单号查询需求详情、提出方、目标与约束',
    schema: z.object({
      requirementId: z.string().describe('需求单号，例如 REQ-2026-001'),
    }),
  }
);

export const readFileTool = tool(
  async ({ filePath }: { filePath: string }) => {
    const full = safePath(filePath);
    if (!fs.existsSync(full)) return { error: '文件不存在' };
    return { content: fs.readFileSync(full, 'utf8') };
  },
  {
    name: 'read_file',
    description: '读取需求规范、标准或其他业务文件',
    schema: z.object({
      filePath: z.string().describe('相对于 workspace 的文件路径'),
    }),
  }
);

export const writeFileTool = tool(
  async ({ filePath, content }: { filePath: string; content: string }) => {
    const full = safePath(filePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    return { success: true, path: filePath };
  },
  {
    name: 'write_file',
    description: '写入需求分析报告或制品',
    schema: z.object({
      filePath: z.string().describe('相对于 workspace 的文件路径'),
      content: z.string().describe('要写入的内容'),
    }),
  }
);
```

这三个工具分别对应一个明确动作：查需求、读规范、写制品。对同一条需求来说，它们形成了一条完整的业务链：

- `query_requirement('REQ-2026-001')` 负责读取需求详情、目标与约束
- `read_file('standards/requirement-spec.md')` 可在自行补充规范文件后读取需求规范依据
- `write_file('reports/REQ-2026-001-analysis.md', content)` 负责把结论落到报告文件里

### 4.3.2 工具调用的分工：数据查询与制品输出

如果模型只返回一段聊天回复，分析结果很难沉淀为可复用制品；当系统能够把需求判断写入 `reports/`，输出才具备后续复核、归档和协作价值。

工具调用在这里沿用第三章的分工：**模型负责决定是否调用、调用哪个工具，以及何时继续；工具负责返回确定性结果。** 对这组业务工具来说，可以拆成三类职责：

- `query_requirement`：读取业务数据，返回事实结果
- `read_file`：读取规范与标准，返回规则依据
- `write_file`：执行写入动作，生成持久化制品

对应的文件系统服务用 tool-loop 把这三类工具串起来：

```tsx
import { Injectable } from '@nestjs/common';
import { HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { createChatModel } from '../model.factory';
import { queryRequirementTool, readFileTool, writeFileTool, safePath } from '../tools/business.tools';
import fs from 'node:fs';
import path from 'node:path';

@Injectable()
export class FilesystemService {
  private tools: StructuredToolInterface[] = [
    queryRequirementTool,
    readFileTool,
    writeFileTool,
  ];
  private toolMap = new Map(this.tools.map((t) => [t.name, t]));
  private model = createChatModel().bindTools(this.tools);

  // 工具循环：模型决定调用工具 → 执行 → 回灌结果 → 直到模型给出最终回答
  async chat(input: string) {
    const messages: BaseMessage[] = [new HumanMessage(input)];
    const usedTools: string[] = [];

    for (let i = 0; i < 5; i++) {
      const ai = await this.model.invoke(messages);
      messages.push(ai);

      const calls = ai.tool_calls ?? [];
      if (calls.length === 0) return { response: ai.content, usedTools };

      for (const call of calls) {
        usedTools.push(call.name);
        const selected = this.toolMap.get(call.name);
        const result = selected
          ? await selected.invoke(call.args)
          : { error: `未知工具 ${call.name}` };
        messages.push(
          new ToolMessage({
            content: JSON.stringify(result),
            tool_call_id: call.id ?? call.name,
          })
        );
      }
    }
    return { response: '工具调用超出上限', usedTools };
  }

  // 供 analyze() 直接落盘报告，无需经过工具循环
  writeReport(filePath: string, content: string) {
    const full = safePath(filePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    return filePath;
  }
}
```

⚠️ **安全提醒**：`safePath()` 的路径沙箱校验必须放在工具内部，不能依赖模型“自觉遵守”。生产环境里，写操作还应接入审计日志，并进一步限制可写目录范围。**写入类工具的生产建议**：`write_file` 这种通用文件写入工具在教学中便于演示，但生产环境中必须收敛到明确业务目录，不能让模型决定任意文件路径。当前项目更推荐通过业务服务写入 artifact、message 或数据库记录，而不是把文件系统写入暴露为通用能力。

**🧪 验证步骤（对应 4.3）**

仓库内已预置示例需求单 `services/chat/workspace/requirements/REQ-2026-001.json`。当前仓库默认未预置 `standards/requirement-spec.md`，因此下面先验证已具备的查询、写入与路径越权拒绝：

```bash
# 查询需求单（触发 query_requirement 工具）
curl -X POST http://localhost:4001/api/files/chat \
  -H "Content-Type: application/json" \
  -d '{"input":"查询需求单 REQ-2026-001 的详情"}'

# 写入需求分析（触发 write_file 工具）
curl -X POST http://localhost:4001/api/files/chat \
  -H "Content-Type: application/json" \
  -d '{"input":"把以下内容写入 reports/REQ-2026-001-analysis.md：需求 REQ-2026-001 核心功能明确（会话记忆+长对话裁剪），目标用户清晰，需求基本完整，建议进入设计阶段"}'

# 确认文件落盘
cat services/chat/workspace/reports/REQ-2026-001-analysis.md

# 越权路径测试（应返回错误，不写入）
curl -X POST http://localhost:4001/api/files/chat \
  -H "Content-Type: application/json" \
  -d '{"input":"把内容写入 ../../../etc/passwd"}'
```

**验收标准**：工具可正常调用并返回结果；

`services/chat/workspace/reports/REQ-2026-001-analysis.md` 存在且内容完整；

越权路径请求应返回“路径不允许逃逸工作目录”错误。

![image.png](https://p6-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/58e287f2108b469aad31ae1321171f2c~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=1622&h=374&s=254272&e=png&b=1f1f1f)配图仅为示例参考，具体内容以文章说明及实际代码为准。

------

## 4.4 Embeddings + Vector Store：先建立语义基础

- 🤖 用 AI 生成本节代码（对应 4.4）

  将以下 Prompt 粘贴到 Claude CLI 中执行：

  ```markdown
  在 services/chat 的 LangChain 层中，接入向量化能力，严格按以下要求执行：
  
  1. 安装依赖：
     - @xenova/transformers（本地嵌入模型运行时）
     - @langchain/classic（包含 MemoryVectorStore）
  
  2. 嵌入服务：
     - 新建 services/chat/src/llm/embedding/embedding.service.ts
     - 继承 LangChain 的 Embeddings 抽象类，模型：Xenova/paraphrase-multilingual-MiniLM-L12-v2
     - 对外暴露：embedQuery(text) 和 embedDocuments(documents)
  
  3. 向量存储服务：
     - 新建 services/chat/src/llm/embedding/vector-store.service.ts
     - 使用 MemoryVectorStore（内存存储，无需外部服务）
     - 实现 addTexts(texts: string[])
     - 实现 search(query: string, k: number)
  
  4. 新增路由（@Controller('api/embedding')）：
     - POST embed：接收 { text }，返回向量维度与向量
     - POST store：接收 { texts }，存入向量库
     - POST search：接收 { query, k }，返回相似文档
  
  初始灌库文档：需求规范片段、验收标准片段、约束说明片段
  ```

本节暂不展开完整 RAG，也不直接实现问答链路，而是先完成更基础的一层能力：将需求规范、验收标准和约束说明转换为可语义召回的对象，为后续检索系统打基础。

![image.png](https://p9-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/ef2fa106ca0e492ba650fc357cea00d9~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=2816&h=1536&s=7002683&e=png&b=080b2d)

### 4.4.1 本地嵌入模型：Xenova/paraphrase-multilingual-MiniLM-L12-v2

`Xenova/paraphrase-multilingual-MiniLM-L12-v2` 是 Hugging Face 上的一个多语言句向量模型，由 `@xenova/transformers` 驱动，可以在 Node.js 环境中**纯本地**运行，无需调用任何远程 API。

**模型本身存在哪里？**

这里需要区分“本地模型”和“内存存储”两个概念：

- **模型权重文件**：首次运行时会自动从 Hugging Face 下载，并**持久缓存到本地磁盘**（默认路径 `~/.cache/huggingface/`）。之后启动不会重新下载，直接从磁盘加载。
- **运行时内存**：模型推理时会占用一定内存（`MiniLM-L12` 大约 90MB），但这是正常的运行时占用，进程退出后自然释放。
- **向量存储**：本章用 `MemoryVectorStore` 做内存演示；当前项目生产链路使用 PostgreSQL + pgvector 持久化保存向量（见第五章），服务重启后数据不会丢失。

**为什么选这个模型？**

| 特性        | 说明                                            |
| ----------- | ----------------------------------------------- |
| 多语言支持  | 原生支持中文、英文等 50+ 语言，中文语义效果较好 |
| 轻量        | 模型约 90MB，推理速度快，本地可用               |
| 无 API 依赖 | 完全离线运行，不消耗 token，不需要密钥          |
| 向量维度    | 384 维，适合小规模知识库场景                    |



**局限性**：384 维向量的语义精度不如 OpenAI `text-embedding-3-small`（1536 维）或 `text-embedding-3-large`（3072 维）；这里选用它主要是为了降低教学门槛，方便本地验证。上层接口不依赖具体实现，后续切换到 OpenAI embeddings 只需替换底层实现，调用方式不变。

### 4.4.2 嵌入接口：embedQuery 与 embedDocuments

LangChain 的 `Embeddings` 抽象对外只暴露两个方法：`embedQuery()` 用于在线检索时对单条输入编码，`embedDocuments()` 用于离线批量灌库。底层实现（本地模型或 API）可以随时替换，上层调用方式不变。本章直接**继承 `Embeddings` 抽象类**，这样实例可以无缝喂给 `MemoryVectorStore`。

📌 **关于 LangChain community 封装** LangChain community 也提供 `HuggingFaceTransformersEmbeddings` 封装。但本项目没有使用这层封装，而是直接调用 `@xenova/transformers`，原因是当前依赖组合中 `@huggingface/transformers` / `onnxruntime-node` 存在版本兼容风险。

本章使用 `@xenova/transformers` 直接调用 pipeline，并做 mean pooling + L2 单位化：

```tsx
import { Injectable } from '@nestjs/common';
import { Embeddings } from '@langchain/core/embeddings';
import { pipeline, mean_pooling } from '@xenova/transformers';

@Injectable()
export class EmbeddingService extends Embeddings {
  private embedder: any = null;
  private readonly modelName = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';

  constructor() {
    super({});
  }

  // 延迟初始化：模型下载一次后复用
  private async getEmbedder() {
    if (!this.embedder) {
      this.embedder = await pipeline('feature-extraction', this.modelName);
    }
    return this.embedder;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const embedder = await this.getEmbedder();
    const cleanTexts = texts.map((t) => t.replace(/\n/g, ' '));

    const rawOutput = (await embedder(cleanTexts)) as any;
    const inputs = embedder.tokenizer(cleanTexts, { padding: true, truncation: true });
    // mean pooling（按 attention_mask 加权）+ L2 单位化（余弦相似度 = 点积）
    const pooled = mean_pooling(rawOutput, inputs.attention_mask);
    return pooled.normalize(2, -1).tolist();
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embedDocuments([text]);
    return vector;
  }
}
```

### 4.4.3 向量存储与相似度检索

本章用 LangChain v1 的 `MemoryVectorStore`（来自 `@langchain/classic`）做最小可用的相似度检索：把文本存入内存向量库，再按查询语义召回最相近的片段。把上面的 `EmbeddingService` 直接传给它即可。

```tsx
import { Injectable } from '@nestjs/common';
import { MemoryVectorStore } from '@langchain/classic/vectorstores/memory';
import { Document } from '@langchain/core/documents';
import { EmbeddingService } from './embedding.service';

@Injectable()
export class VectorStoreService {
  private store: MemoryVectorStore;

  constructor(private readonly embeddings: EmbeddingService) {
    this.store = new MemoryVectorStore(this.embeddings);
  }

  async addTexts(texts: string[]) {
    const docs = texts.map((text) => new Document({ pageContent: text }));
    await this.store.addDocuments(docs);
    return { added: texts.length };
  }

  async search(query: string, k = 3) {
    const results = await this.store.similaritySearchWithScore(query, k);
    return results.map(([doc, score]) => ({ content: doc.pageContent, score }));
  }
}
```

📌 **当前项目实际依赖**

- `@xenova/transformers`：本地运行 embedding 模型
- `@langchain/classic`：本章 `MemoryVectorStore` 内存演示
- PostgreSQL + pgvector（第五章）：持久化向量存储与相似度检索`MemoryVectorStore` 进程重启即丢失，只适合教学演示；生产链路在第五章切换到 pgvector。LangChain.js v1 中 `MemoryVectorStore` 应从 `@langchain/classic/vectorstores/memory` 引入。

第五章会把这条内存链路替换为真实的文档处理流程：`ChunkService` 用 `RecursiveCharacterTextSplitter` 切分文本，`EmbeddingService` 生成 384 维向量，写入 `document_chunks.embedding`，查询时由 `SearchService` 使用 pgvector 的 `<=>` 距离运算做相似度排序。本章先把语义基础设施搭起来。

对本章这条案例来说，可以先把下面几类需求知识片段灌进向量库：

- 需求规范片段
- 验收标准片段
- 约束说明片段

这样做的目的，是先把这些业务说明从普通文本转换成可语义召回的对象。后面无论是接 RAG、长期记忆，还是需求知识库，都会建立在这一层基础设施之上。

**🧪 验证步骤（对应 4.4）**

> 首次调用会自动下载嵌入模型（约 90MB），需要联网，请耐心等待。

```bash
# 单条向量化（返回 dimension 和 vector）
curl -X POST http://localhost:4001/api/embedding/embed \
  -H "Content-Type: application/json" \
  -d '{"text":"需求分析助手需要记住多轮对话"}'

# 灌库（无需启动任何外部服务，直接请求即可）
curl -X POST http://localhost:4001/api/embedding/store \
  -H "Content-Type: application/json" \
  -d '{"texts":["需求规范：核心功能、目标用户、业务目标三者齐全才算需求完整","验收标准：同一会话连续多轮对话应保持上下文一致，不重复提问","约束说明：单会话上下文不超过 2000 tokens，会话之间互相隔离"]}'

# 语义搜索
curl -X POST http://localhost:4001/api/embedding/search \
  -H "Content-Type: application/json" \
  -d '{"query":"怎样判断一个需求是否完整","k":3}'
```

**验收标准**：

执行 `embed` 后返回 `dimension: 384` 和对应向量；![image.png](https://p6-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/ba0928e509b24cd9aaefb4978e6dd63c~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=1412&h=1246&s=934417&e=png&b=1f1f1f)配图仅为示例参考，具体内容以文章说明及实际代码为准。

执行 `store` 后返回 `{"added":3}`，表示灌库成功；![image.png](https://p6-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/1c53e4f7f8d14b2e93451a6892ac097a~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=2488&h=1288&s=1163326&e=png&b=1e1e1e)配图仅为示例参考，具体内容以文章说明及实际代码为准。

执行 `search` 后，第一条结果应与“需求完整性判断”相关（即包含核心功能/目标用户/业务目标的那条规范片段）。

![image.png](https://p1-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/163e3dea44944799ad8b05099916b0fd~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=1622&h=408&s=340570&e=png&b=20201f)配图仅为示例参考，具体内容以文章说明及实际代码为准。

------

## 4.5 Multi-Agent：把需求分析拆成 5 个专职角色

- 🤖 用 AI 生成本节代码（对应 4.5）

  将以下 Prompt 粘贴到 Claude CLI 中执行：

  ```markdown
  在 services/chat 的 LangChain 层中，实现 Multi-Agent 固定编排，严格按以下要求执行：
  
  1. Agent 提示词：
     - 新建 services/chat/src/llm/prompts/requirement.prompts.ts
     - 用 ChatPromptTemplate 定义五个需求分析 Agent 的提示词：
       extractPrompt / clarifyPrompt / analysisPrompt / riskPrompt / summaryPrompt
  
  2. 子 Agent 定义：
     - 新建 services/chat/src/llm/agents/sub-agents.ts
     - 每个 Agent = prompt.pipe(model).pipe(StringOutputParser)：
       - extractAgent：从用户描述抽取结构化需求字段，输出 JSON
       - clarifyAgent：判断是否需要澄清并生成问题，输出 JSON
       - analysisAgent：多维度需求分析（功能分解/用户故事/验收标准/依赖/建议）
       - riskAgent：风险识别与评估
       - summaryAgent：汇总生成最终需求分析报告
  
  3. 编排服务：
     - 新建 services/chat/src/llm/agents/orchestrator.service.ts
     - 实现 fixed workflow：抽取 → 澄清判断 → 并行（分析 + 风控）→ 汇总
     - 需要澄清时，返回 clarificationQuestions 并终止流程
     - 失败时返回 fallback: 'manual_review'
     - 返回字段：mode、status、clarificationQuestions、usedAgents、fallback、steps、report
  
  4. 新增路由（@Controller('api/agents')）：
     - POST orchestrate：接收 { input }，执行多 Agent 协作
  
  业务场景：需求分析
  测试输入：'开发一个面向需求分析师的会话记忆系统，支持多轮澄清并自动裁剪长对话上下文'
  ```

如果一个 prompt 配合少量工具已经可以稳定完成任务，就不需要立即拆成多 Agent。只有当任务存在清晰的阶段划分、角色分工或后续扩展需求时，多 Agent 才具备引入价值。对当前需求分析链路来说，任务可以自然拆分为五类：

- `extractAgent`：抽取需求类型、核心功能、目标用户、约束等结构化字段
- `clarifyAgent`：判断信息是否充分，必要时生成澄清问题
- `analysisAgent`：做功能分解、用户故事、验收标准等多维度分析
- `riskAgent`：识别模糊性、范围、技术、业务风险
- `summaryAgent`：汇总并输出最终需求分析报告

![image.png](https://p1-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/ca802ada2689461781458a019ba05081~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=2816&h=1536&s=7685455&e=png&b=030a16)配图仅为示例参考，具体内容以文章说明及实际代码为准。

### 4.5.1 子 Agent 的结构与职责划分

每个 Agent 都是一条独立的小链，有自己的 system prompt、输入变量和输出格式。这和第三章的链式编排是同一种思路，只是这里把不同职责分给了不同的链。五个 Agent 的提示词集中放在 `prompts/requirement.prompts.ts`（导出 `extractPrompt / clarifyPrompt / analysisPrompt / riskPrompt / summaryPrompt`），`sub-agents.ts` 只负责把它们 `.pipe(model).pipe(parser)` 组装成链：

```tsx
import { StringOutputParser } from '@langchain/core/output_parsers';
import { createChatModel } from '../model.factory';
import {
  extractPrompt,
  clarifyPrompt,
  analysisPrompt,
  riskPrompt,
  summaryPrompt,
} from '../prompts/requirement.prompts';

const model = createChatModel();
const parser = new StringOutputParser();

// 抽取 Agent：输出结构化需求 JSON
export const extractAgent = extractPrompt.pipe(model).pipe(parser);

// 澄清 Agent：判断是否需要澄清并生成问题
export const clarifyAgent = clarifyPrompt.pipe(model).pipe(parser);

// 多维度分析 Agent
export const analysisAgent = analysisPrompt.pipe(model).pipe(parser);

// 风险评估 Agent（与 analysisAgent 并行）
export const riskAgent = riskPrompt.pipe(model).pipe(parser);

// 汇总 Agent：生成最终需求分析报告
export const summaryAgent = summaryPrompt.pipe(model).pipe(parser);
```

其中，`extractPrompt` 要求模型输出结构化需求 JSON（`requirementType / coreFeature / targetUsers / businessGoal / constraints / priority / isComplete / missingFields`）；`clarifyPrompt` 输出 `{ needsClarification, questions }`；`analysisPrompt` 与 `riskPrompt` 输出 Markdown 小节；`summaryPrompt` 负责汇总完整报告。提示词较长，完整内容见仓库 `prompts/requirement.prompts.ts`。

### 4.5.2 Fixed Workflow 编排实现

本节先实现 fixed workflow。当前案例的流程相对稳定：先抽取需求字段，再判断是否需要澄清；如果信息不足则短路返回澄清问题，否则并行执行分析和风控，最后汇总为报告。

```tsx
import { Injectable } from '@nestjs/common';
import {
  extractAgent,
  clarifyAgent,
  analysisAgent,
  riskAgent,
  summaryAgent,
} from './sub-agents';

// LLM 偶尔会带 ```json 代码块包裹，做一次容错解析
function parseJsonLoose(raw: string): any {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  return JSON.parse(cleaned);
}

@Injectable()
export class OrchestratorService {
  async orchestrate(input: string) {
    try {
      const extractResult = await extractAgent.invoke({ input });

      // 澄清判断：信息不足时短路返回澄清问题
      const clarifyRaw = await clarifyAgent.invoke({ extractResult, input });
      let clarificationQuestions: string[] = [];
      try {
        const clarify = parseJsonLoose(clarifyRaw);
        if (clarify?.needsClarification && Array.isArray(clarify.questions)) {
          clarificationQuestions = clarify.questions;
        }
      } catch {
        // 澄清结果解析失败时不阻塞主流程，按"无需澄清"继续
      }

      if (clarificationQuestions.length > 0) {
        return {
          mode: 'fixed_workflow',
          status: 'need_clarification',
          clarificationQuestions,
          usedAgents: ['extractAgent', 'clarifyAgent'],
          fallback: 'ask_user',
        };
      }

      const [analysisResult, riskResult] = await Promise.all([
        analysisAgent.invoke({ extractResult, input }),
        riskAgent.invoke({ extractResult, input }),
      ]);

      const report = await summaryAgent.invoke({
        input,
        extractResult,
        analysisResult,
        riskResult,
        retrievedContext: '无相关参考文档',
      });

      return {
        mode: 'fixed_workflow',
        clarificationQuestions: [],
        usedAgents: ['extractAgent', 'clarifyAgent', 'analysisAgent', 'riskAgent', 'summaryAgent'],
        fallback: null,
        steps: { extract: extractResult, analysis: analysisResult, risk: riskResult },
        report,
      };
    } catch (error) {
      return {
        mode: 'fixed_workflow',
        clarificationQuestions: [],
        usedAgents: ['extractAgent'],
        fallback: 'manual_review',
        report: '分析流程失败，请转人工复核。',
        error: String(error),
      };
    }
  }
}
```

> `summaryPrompt` 预留了 `retrievedContext` 变量，用于接入知识库检索结果。本章还没有 RAG，所以传入占位的 `'无相关参考文档'`；第五章接入 pgvector 检索后，这里会替换为真实召回片段。

### 4.5.3 其他编排模式参考

**Fixed Workflow** 是当前案例最适合的编排方式。除此之外，Multi-Agent 还有几类常见模式，分别适配不同的业务诉求。

### **Router（分流路由）**

适合“先分类，再处理”的场景。

- 主 Agent 先识别用户意图
- 再把请求路由到对应的专项 Agent
- 典型场景：用户消息可能是功能需求、非功能需求、缺陷反馈或咨询
- 路由 Agent 先判断类型
- 再分别交给需求分析 Agent、缺陷处理 Agent 等

### Supervisor（动态调度）

适合流程不固定、需要主 Agent 实时决策的场景。

- 主 Agent 根据每一步的执行结果决定下一步调用哪个子 Agent
- 典型场景：处理一条复杂需求时
  - 主 Agent 先抽取需求
  - 如果发现涉及合规，再临时调用“合规审查 Agent”
  - 如果发现是高风险变更，再调用“风控 Agent”
- 整体流程是动态生成的，而不是预先固定的

### Handoff（控制权交接）

适合多阶段、需要角色切换的场景。

- 一个 Agent 处理到某个节点后，将控制权和上下文一起移交给下一个 Agent
- 典型场景：
  - 需求收集 Agent 完成信息收集后，把整理好的需求“交接”给评审 Agent
  - 评审 Agent 判断完毕后，再交接给通知 Agent 发送结果
- 每个 Agent 只处理自己职责范围内的工作
- 结束时主动交棒

### Planner-Executor（规划执行分离）

适合任务复杂、步骤不确定的场景。

- Planner Agent 先把目标拆成可执行的子任务列表
- Executor Agent 再逐步执行
- 典型场景：用户提交“帮我把这份 PRD 拆成可排期的需求清单”
  - Planner 先生成处理计划（抽取→逐条分析→风险评估→汇总报告）
  - Executor 按计划依次执行
  - 遇到异常时再回传给 Planner 重新规划

本章不逐一实现这些模式，而是先把 **Fixed Workflow** 讲透。原因在于，当前需求分析链路的步骤是确定的，不需要动态调度，也不需要分类路由。先把固定流程跑通、跑稳，才是后续扩展的基础。

📌 **什么时候适合上多 Agent** • 一个 prompt 配合工具就能稳定解决 → **不需要多 Agent** • 任务天然分阶段、分角色、分工具 → **适合多 Agent** • 需要不同工具集或不同模型配置 → **适合多 Agent** • 需要较强扩展性、后续持续增加角色 → **非常适合多 Agent**

**🧪 验证步骤（对应 4.5）**

分两个场景验证：信息完整触发全链路，信息不足触发澄清：

```bash
# 场景 A：信息完整，触发完整五 Agent 编排
curl -X POST http://localhost:4001/api/agents/orchestrate \
  -H "Content-Type: application/json" \
  -d '{"input":"开发一个面向需求分析师的会话记忆系统，支持多轮澄清并自动裁剪长对话上下文"}'

# 场景 B：信息不足，触发澄清问题返回
curl -X POST http://localhost:4001/api/agents/orchestrate \
  -H "Content-Type: application/json" \
  -d '{"input":"做个系统"}'
```

**验收标准**：场景 A 的响应中 `usedAgents` 包含全部 5 个 Agent，`report` 含需求分析报告结论，`fallback` 为 `null`。

![image.png](https://p3-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/b4650165d2404046bb91c2dbaca51ae0~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=2882&h=1246&s=2729826&e=png&b=1f1f1f)配图仅为示例参考，具体内容以文章说明及实际代码为准。

场景 B 的 `status` 为 `need_clarification`，`clarificationQuestions` 数组非空，`usedAgents` 仅含 `extractAgent` 和 `clarifyAgent`。

![image.png](https://p1-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/1cb28c6603084d3e9711794532e3d947~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=1534&h=356&s=229126&e=png&b=1f1f1f)配图仅为示例参考，具体内容以文章说明及实际代码为准。

------

## 4.6 统一入口：把 Memory、Tools、Embeddings、Multi-Agent 收成一个接口

- 🤖 用 AI 生成本节代码（对应 4.6）

  将以下 Prompt 粘贴到 Claude CLI 中执行：

  ```markdown
  把第四章所有能力收回到 Nest 服务端统一入口，严格按以下要求执行：
  
  1. 模块注册：
     - 新建 services/chat/src/llm/advanced.module.ts
     - 注册 RunnableMemoryService、EmbeddingService、VectorStoreService、FilesystemService、OrchestratorService、AdvancedAnalysisService
     - 在 AppModule 中 import AdvancedModule
  
  2. 统一分析服务：
     - 新建 services/chat/src/llm/advanced-analysis.service.ts
     - 实现 analyze(sessionId: string, input: string)：
       1. 调用 OrchestratorService 执行多 Agent 分析
       2. 如果需要澄清，直接返回澄清问题
       3. 否则将报告写入 reports/ 目录
       4. 用 appendMessage() 写回最终结论（不重新调用模型）
       5. 返回完整分析报告
  
  3. 统一 Controller：
     - 在 services/chat/src/llm/advanced.controller.ts 中统一承载 MemoryController、FilesystemController、EmbeddingController、AgentsController、AdvancedController
     - AdvancedController 使用 @Controller('api/advanced')
     - POST analyze：接收 { sessionId, input }，返回完整分析报告
  
  测试场景（同一 sessionId 依次发送前三轮，再发第四轮触发 analyze）：
  第四轮：'帮我判断这个需求是否完整，并产出一份需求分析报告'
  ```

到这里，前面的能力已经分别完成验证。最后一步，是将它们整理为统一的业务入口，避免停留在彼此分散的 demo 接口上。

统一入口 `analyze()` 的职责包括：

1. 调用 Orchestrator 做多 Agent 分析
2. 需要澄清时直接返回澄清问题
3. 否则把报告写出到 `reports/`
4. 用 `appendMessage()` 把最终结论写回会话记忆

![image.png](https://p6-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/6241d80a375d45f8812b3d410d71d22c~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=2816&h=1536&s=7241482&e=png&b=020f23)

```tsx
import { Injectable } from '@nestjs/common';
import { OrchestratorService } from './agents/orchestrator.service';
import { FilesystemService } from './filesystem/filesystem.service';
import { RunnableMemoryService } from './memory/runnable-memory.service';

export type AnalyzeResult =
  | { needsClarification: true; questions: string[] }
  | { needsClarification: false; report: string; reportPath: string; usedAgents: string[] };

@Injectable()
export class AdvancedAnalysisService {
  constructor(
    private readonly orchestrator: OrchestratorService,
    private readonly filesystem: FilesystemService,
    private readonly memory: RunnableMemoryService
  ) {}

  async analyze(sessionId: string, input: string): Promise<AnalyzeResult> {
    const result = await this.orchestrator.orchestrate(input);

    if (result.status === 'need_clarification') {
      return { needsClarification: true, questions: result.clarificationQuestions };
    }

    const report = result.report ?? '分析未生成报告';
    const reportPath = this.filesystem.writeReport(
      `reports/${sessionId}-${Date.now()}.md`,
      report
    );
    // 用 appendMessage 写回结论，不重新调用模型
    await this.memory.appendMessage(sessionId, input, report);

    return { needsClarification: false, report, reportPath, usedAgents: result.usedAgents };
  }
}
```

> `FilesystemService` 额外提供了一个 `writeReport(filePath, content)` 同步辅助方法（同样走 `safePath` 沙箱），供 `analyze()` 直接落盘报告，无需经过完整的工具循环。

⚠️ **关键实现细节**：写回记忆时，优先使用 `appendMessage(sessionId, input, report)`，将“用户输入 + 最终结论”作为一轮完整消息写入历史，而不是把原始输入重新交给模型执行一次。这样既能保留上下文，也能避免不必要的模型调用。

**🧪 验证步骤（对应 4.6）**

用同一 sessionId 触发完整 analyze 链路：

```bash
# 信息完整：触发完整分析并落盘报告
curl -X POST http://localhost:4001/api/advanced/analyze \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"demo","input":"帮我判断这个需求是否完整，并产出一份需求分析报告：开发一个面向需求分析师的会话记忆系统，支持多轮澄清并自动裁剪长对话上下文"}'

# 验证报告文件落盘（文件名形如 demo-<时间戳>.md）
ls services/chat/workspace/reports/

# 验证 Memory 中写回了最终结论
curl "http://localhost:4001/api/memory/history/demo"
```

**验收标准**：返回完整 `report` 与 `reportPath`；`services/chat/workspace/reports/` 下存在对应报告文件且与报告内容一致；`getHistory` 最后一条 AI 消息是报告内容，而非模型重新生成的聊天回复。

![image.png](https://p9-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/e2e62077ffbd4dcd9bb3911d388421ef~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=2038&h=1420&s=317880&e=png&b=181818)

完成这个统一入口后，同一条需求的处理链路就形成了闭环：历史可以延续，需求单可以查询，规范可以读取，分析可以拆解，结果可以落盘，结论也可以写回记忆。

至此，系统不再只是单次问答接口，而是具备持续对话、制品沉淀和流程追踪能力的业务系统接口。

------

## 4.7 本章小结

这一章围绕同一条需求，逐步为系统补齐了四项核心能力：

- **Memory**：用 `RunnableWithMessageHistory` 保持会话上下文，配合 `trimMessages` 控制长对话的 Token 成本，解决多轮对话中信息断裂的问题。
- **Tools**：定义 `query_requirement`、`read_file`、`write_file` 三类业务工具，让模型能够主动读取真实数据、查询需求规范，并将分析结论写入报告文件，产出持久化制品。
- **Embeddings + Vector Store**：使用本地多语言小模型对需求规范和验收标准进行向量化，存入 `MemoryVectorStore`，为后续语义检索和 RAG 链路打下基础（第五章替换为 pgvector）。
- **Multi-Agent**：将需求分析拆解为抽取、澄清、分析、风控、汇总五个专职 Agent，以固定编排（Fixed Workflow）串联执行，信息不足时提前返回澄清问题。

最终通过统一的 `analyze()` 接口，将多 Agent 分析、报告落盘与记忆写回收敛为一条端到端链路。系统不再是一次性问答接口，而是可持续对话、可追溯制品的业务处理单元。