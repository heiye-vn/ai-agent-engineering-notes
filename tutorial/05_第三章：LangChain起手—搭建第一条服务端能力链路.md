![image.png](https://p3-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/bff873d344b44ce0b7677ddc42290fa6~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=1080&h=589&s=813526&e=png&b=120f4a)

本章分支[feat/first-chain](https://link.juejin.cn/?target=https%3A%2F%2Fgithub.com%2FCookieboty%2Fautix-demo%2Ftree%2Ffeat%2Ffirst-chain)

第二章已经把工程底座跑通：monorepo、Web、API、共享包和 Compose 都有了稳定落点。第 2.5 章进一步讨论了 AI 如何参与真实开发：先澄清边界、再写 Spec 和 Plan，最后按阶段交付、验收和收尾。

有了这两层准备，第三章才正式把模型能力接进系统。这里不再讨论“怎样让 AI 帮我们写代码”，而是回到服务端本身：当一次简单的模型调用已经不够用时，怎样把它整理成一条可维护、可复用、可测试的能力链路。

LangChain 在这里的作用，不是给模型调用再包一层语法糖，而是把提示模板、模型、输出解析、工具调用和链路编排放到同一套编程模型里。这样，原本散落在业务代码里的 Prompt、解析逻辑和调用细节，才能逐步收束到清晰的位置。

本章会沿着同一个递进节奏展开：

- 先把 LangChain 接进现有 Nest 服务端
- 再把散落的字符串提示整理成模板
- 再把模型输出收束为稳定字段
- 再接入工具调用，让模型可以触发确定性校验
- 最后把能力回收到业务接口，形成可测试的服务端入口

为了避免示例停留在“看起来能用”的层面，本章会始终围绕一个明确任务展开：**从需求文本中抽取结构化字段 `action / constraints / entities`。**

✅ **本章验收点**

- 理解并跑通 LangChain 在服务端常用的几组 API
- 按顺序将模型调用、提示模板、输出解析、工具调用串到同一条链路里
- 将能力收束到 Nest Service / Controller 中，而不是停留在零散示例
- 最终落到一个可测试的业务接口：`POST /requirement/extract`
- 文中每个阶段都提供可直接交给 AI 编程工具执行的 Prompt；代码片段只保留关键部分，实际落地时可结合仓库实现做小幅调整。

> 注意：每个阶段都有对应的 Prompt 可供 AI 生成代码，不必逐行复制或手抄代码。受篇幅所限，文中仅展示关键代码片段。我们要做的是掌握 API 的使用，理解其设计思路，并引导 AI 产出代码，从而减少重复劳动。但是，AI 生成的代码难免存在差异，例如方法名称或部分实现不一致，可结合本文与示例进行微调。

本章示例直接使用当前 autix-demo 仓库里的真实命名：

- 服务端：`services/chat`，端口 `4001`
- 前端：`clients/chat-web`，端口 `3002`
- 共享包：`@autix/contracts`
- `LlmController` 为 `@Controller('api/langchain')`，演示接口形如 `POST /api/langchain/invoke`
- 统一业务入口为 `POST /requirement/extract`，例如 `curl http://localhost:4001/requirement/extract`

------

## 3.1 引入 LangChain 的必要性

如果只是发起一次最简单的模型调用，直接使用 OpenAI SDK 就足够了。但一旦进入业务系统，问题很快会从“能不能调通”变成“能不能长期维护”：

- **提示内容会变多**：难维护的往往不是模型调用本身，而是分散在不同文件里的提示词、变量拼接和输出要求（对应：提示层）。
- **模型结果要进入程序**：当结果要作为接口返回值、页面数据源或后续流程输入时，输出格式是否稳定就会直接影响可用性（对应：解析层 / 结构化输出）。
- **系统会需要工具与检索**：只靠提示词，模型只能生成回答，不能真正调用外部系统；只靠模型已有知识，也无法覆盖最新文档、业务规则和内部资料（对应：工具层 / 检索层）。
- **多个步骤要形成固定流程**：当流程从单步调用扩展为多步处理时，就需要一种可组合、可复用、可测试的编排方式（对应：链式编排 / pipe）。

所以，引入 LangChain 的重点不是“换一种写法调用模型”，而是把这些迟早会出现的工程问题提前收口。

![image.png](https://p9-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/fa47f0efdcd74d54a5b6a1bd049917fb~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=1408&h=768&s=1225499&e=png&b=04101e)

不过，比技术选型更重要的是先把任务定义清楚。如果需求只写成“提取核心目标 / 限制 / 关键词”，后面很难稳定实现：

- “核心目标”的边界是什么？
- 关键词应该抽到什么粒度？
- 同一段文本是否只有一个合理结果？
- 测试时该断言什么？

因此，本章不会用泛泛的文本生成示例，而是固定在一个可验证、可复用的抽取任务上：

```tsx
{
  action: string;
  constraints: string[];
  entities: string[];
}
```

例如输入：

```
用户注册时必须绑定手机号，密码至少8位
```

预期输出：

```json
{
  "action": "用户注册",
  "constraints": ["必须绑定手机号", "密码至少8位"],
  "entities": ["用户", "手机号", "密码"]
}
```

为了更清楚地对比“每加一层能力”到底带来了什么变化，后文会始终围绕这段需求抽取任务，按下面五个层次递进实现：

1. **模型层**：先学会创建模型，理解 `invoke()`、`stream()`、`batch()` 分别适合什么场景
2. **提示层**：把原本写死在代码里的长字符串整理成模板，学会用变量填充
3. **解析层**：让模型返回更适合继续进入代码，而不是只得到一段自由文本
4. **工具层**：让模型可以根据上下文决定是否调用校验工具
5. **收束层**：把能力落回业务 Service / Controller，形成稳定、可验证的接口

------

## 3.2 服务端承载模型能力的分工原则

明确任务之后，下一步要确定能力应该放在哪一层。

这里继续沿用第二章建立的工程分层：

- `clients/chat-web` 只负责输入、展示和交互
- `services/chat` 负责组织模型调用、工具、检索与后续链路
- `packages/` 负责沉淀会被多处复用的共享定义

把复杂度放到服务端，不只是习惯问题，而是因为模型链路中的关键能力更适合在后端统一治理：

- API Key 不会暴露在浏览器端
- 工具调用和检索过程更容易统一管理
- 日志、限流、缓存、重试、监控都更好收口
- 后面你要加多模型路由、RAG、MCP、Agent runtime，也有明确落点

### **补充：Next 与 Nest 的区别，以及为什么这里不直接用 Next 充当服务层底座**

Next 可以承担 BFF 与部分接口，但不适合作为本书后续的“主服务层底座”。核心差异在于两者的关注点不同：

- **定位**：Next 偏应用层（渲染、路由、RSC/SSR、贴近 UI 的数据获取）；Nest 偏服务层（模块化、DI、中间件/守卫/拦截器、面向业务域的编排）。
- **性能与稳定性**：AI 服务主要压力来自长耗时请求、流式连接、重试/超时、工具与检索串联；Nest 更适合围绕这些链路做统一治理。
- **安全边界**：模型/向量库/工具/MCP 等凭证与权限集中在后端更易做最小暴露、审计与限权。
- **部署与扩缩容**：前端发布节奏与后端能力迭代不同；后端服务常需要独立扩容、独立告警、独立超时策略。
- **并发形态**：AI 请求更像服务编排而非普通 CRUD，易演化出异步队列、后台任务、消费者；Nest 更自然。

结论更准确地说：

- Next：前端应用层 + BFF
- Nest：长期承载 AI 能力、业务编排、内部工具与系统集成的后端底座

这也解释了为什么本章示例都围绕 `services/chat` 组织：第二章已经证明前后端和共享包可以稳定协作，第 2.5 章又强调复杂任务要按阶段收束。到了这一章，LangChain 就应该进入服务端，而不是被当成浏览器里的临时调用脚本。

------

## 3.3 LangChain 接入前的项目准备

在开始写调用链之前，先把配置和依赖整理好。这样后面每增加一层能力，都有明确落点，不需要一边写示例一边返工基础设施。

### **3.3.1 安装依赖**

服务端需要以下依赖：

- `langchain`
- `@langchain/openai`
- `@langchain/core`
- `js-yaml`

在服务端安装：

```sql
bun add langchain @langchain/openai @langchain/core js-yaml --cwd services/chat
```

共享层的 `zod` 沿用前面已安装的版本。

### **3.3.2 配置分层：环境变量与 YAML**

LangChain 的配置，建议从一开始就拆成两层：

- **环境变量（`.env` / Docker）**：放令牌、密钥、外部服务地址——凡是敏感的、按环境变化的，一律走 `process.env`
- **YAML 配置文件**：放模型参数、功能开关、检索配置——不敏感但会频繁调整的运行时调优项

这样做是为了把“安全相关的变化”和“运行时策略的变化”分开处理，后续维护会更清晰。

### **令牌与密钥：环境变量注入**

敏感凭证必须和代码解耦。

开发阶段放在 `.env`：

```ini
# services/chat/.env
OPENAI_API_KEY=sk-xxxx
OPENAI_BASE_URL=https://api.amux.ai/v1
EMBEDDING_API_KEY=sk-xxxx
VECTOR_DB_URL=http://localhost:6333
VECTOR_DB_API_KEY=
```

生产阶段通过 Docker Compose 直接注入，不落盘任何密钥文件：

```yaml
services:
chat:
environment:
- OPENAI_API_KEY=${OPENAI_API_KEY}
- OPENAI_BASE_URL=${OPENAI_BASE_URL}
- EMBEDDING_API_KEY=${EMBEDDING_API_KEY}
- VECTOR_DB_URL=${VECTOR_DB_URL}
- VECTOR_DB_API_KEY=${VECTOR_DB_API_KEY}
```

⚠️ **原则：凡是令牌、密钥、外部服务地址，一律走环境变量，不写进 YAML，也不写进代码。** `.env` 文件必须加入 `.gitignore`，CI/CD 和 Docker 环境通过 secrets 或环境变量注入。

### **运行参数：YAML 化管理**

和敏感凭证不同，运行参数更适合落在可读、可调的配置文件里：

```arduino
services/chat/config/langchain.yaml
```

示例：

```yaml
llm:
provider: openai
model: gpt-5.4
temperature:0
maxTokens:800

retrieval:
enabled:true
topK:3

tools:
enableConstraintCheck:true
enableEntityLookup:true

features:
enableStructuredOutput:true
enableStreaming:true
```

📌 **配置分层小结**

- 令牌 / 密钥 / 服务地址 → `process.env`（`.env` 开发，Docker 生产）
- 模型参数 / 功能开关 / 检索配置 → `config/langchain.yaml`
- 提示模板 / 业务逻辑 → TypeScript 代码（`prompts/` 目录）

### **3.3.4 配置加载器的实现**

配置分层之后，下一步就是把它们收束到一个统一的加载入口里。

```
services/chat/src/config/load-langchain-config.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

export type LangChainAppConfig = {
  llm: {
    provider: string;
    model: string;
    temperature: number;
    maxTokens: number;
  };
  retrieval: {
    enabled: boolean;
    topK: number;
  };
  tools: {
    enableConstraintCheck: boolean;
    enableEntityLookup: boolean;
  };
  features: {
    enableStructuredOutput: boolean;
    enableStreaming: boolean;
  };
};

export function loadLangChainConfig(): LangChainAppConfig {
  const filePath = path.join(process.cwd(), 'config', 'langchain.yaml');
  const raw = fs.readFileSync(filePath, 'utf8');
  return yaml.load(raw) as LangChainAppConfig;
}

export function getApiKeys() {
  return {
    openaiApiKey: process.env.OPENAI_API_KEY ?? '',
    openaiBaseUrl: process.env.OPENAI_BASE_URL,
    embeddingApiKey:
      process.env.EMBEDDING_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
    vectorDbUrl: process.env.VECTOR_DB_URL,
    vectorDbApiKey: process.env.VECTOR_DB_API_KEY,
  };
}
```

到这里，配置层就算准备完成了。接下来就可以正式进入模型调用本身。

------

## 3.4 模型调用基础

- 🤖 用 AI 生成本节代码（对应 3.3 与 3.4）

  将以下 Prompt 粘贴到 Claude CLI 中执行：

  ```bash
  在现有 monorepo 的 services/chat 下，完成 LangChain 的接入准备与模型调用基础，严格按以下要求执行：
  
  前置：
  - 在 services/chat 安装依赖：langchain @langchain/openai @langchain/core js-yaml
  - 在 services/chat/.env 中配置环境变量：OPENAI_API_KEY, OPENAI_BASE_URL, EMBEDDING_API_KEY, VECTOR_DB_URL, VECTOR_DB_API_KEY
  - .env 加入 .gitignore
  
  1. 配置层：
     - 新建 services/chat/config/langchain.yaml，只放运行参数：llm、retrieval、tools、features
     - 新建 services/chat/src/config/load-langchain-config.ts
  
  2. 统一模型工厂：
     - 新建 services/chat/src/llm/model.factory.ts
     - 从 YAML 读取模型参数，从 getApiKeys() 读取令牌和 baseURL
  
  3. NestJS 骨架 + 三种调用路由：
     - 新建 services/chat/src/llm/llm.module.ts
     - 新建 services/chat/src/llm/llm.service.ts
     - 新建 services/chat/src/llm/llm.controller.ts（@Controller('api/langchain')）
     - 在 LlmService + LlmController 中实现：POST invoke / POST stream / POST batch
     - 输入统一使用：'用户注册时必须绑定手机号，密码至少8位'
  
  约束：
  - 令牌/密钥/服务地址一律走 process.env
  - 所有路由的 SystemMessage 角色为“需求结构化抽取助手”
  - 不要在 Service 里直接 new ChatOpenAI，统一用 createChatModel()
  - 所有能力以 Service 方法 + Controller 路由形式暴露
  ```

### **3.4.1 统一模型工厂的建立**

有了配置加载器之后，模型初始化也应该统一收口到工厂函数里，而不是散落在各个 Service 中。

```
services/chat/src/llm/model.factory.ts
import { ChatOpenAI } from '@langchain/openai';
import {
  loadLangChainConfig,
  getApiKeys,
} from '../config/load-langchain-config';

export function createChatModel() {
  const config = loadLangChainConfig();
  const keys = getApiKeys();

  return new ChatOpenAI({
    model: config.llm.model,
    temperature: config.llm.temperature,
    maxTokens: config.llm.maxTokens,
    openAIApiKey: keys.openaiApiKey,
    configuration: keys.openaiBaseUrl
      ? { baseURL: keys.openaiBaseUrl }
      : undefined,
  });
}
```

接下来搭一组 NestJS 骨架。后面的能力都会以 Service + Controller 的形式落地，便于测试和替换。

```
services/chat/src/llm/llm.module.ts
import { Module } from '@nestjs/common';
import { LlmService } from './llm.service';
import { LlmController } from './llm.controller';
import { RequirementService } from './requirement.service';

@Module({
  providers: [LlmService, RequirementService],
  controllers: [LlmController],
  exports: [LlmService, RequirementService],
})
export class LlmModule {}
services/chat/src/llm/llm.service.ts
import { Injectable } from '@nestjs/common';
import { createChatModel } from './model.factory';

@Injectable()
export class LlmService {
  private model = createChatModel();
}
services/chat/src/llm/llm.controller.ts
import { Body, Controller, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { LlmService } from './llm.service';
import { RequirementService } from './requirement.service';

@Controller('api/langchain')
export class LlmController {
  constructor(
    private readonly llmService: LlmService,
    private readonly requirementService: RequirementService
  ) {}
}
```

### **3.4.2 `invoke()` 的基本用法**

模型工厂搭好之后，先从 `invoke()` 开始。它是最常见的单次调用方式，适合先把主链路跑通。

它适合下面几类场景：

- 一次请求只需要一个完整结果
- 你希望先把“输入 → 模型 → 输出”的主流程打通
- 暂时不考虑流式返回和批量处理

Service 新增方法：

```tsx
import { HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';

async invokeDemo(input: string): Promise<string> {
  const systemMessage = new SystemMessage('你是一名需求结构化抽取助手');
  const humanMessage = new HumanMessage(
    `请从下面文本中抽取 action、constraints、entities：\n${input}`
  );
  const messages: BaseMessage[] = [systemMessage, humanMessage];
  const response = await this.model.invoke(messages);
  return response.content.toString();
}
```

Controller 新增路由：

```tsx
@Post('invoke')
async invoke(@Body() body: { input: string }) {
  const result = await this.llmService.invokeDemo(body.input);
  return { result };
}
```

用 `curl` 验证：

```json
curl -s -X POST http://localhost:4001/api/langchain/invoke \
  -H "Content-Type: application/json" \
  -d '{"input": "用户注册时必须绑定手机号，密码至少8位"}'
```

![img.png](https://p9-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/8641f9e9a2ab4c8ead87df5315c607ff~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=1216&h=770&s=587237&e=png&b=fefefe)配图仅为示例参考，具体内容以文章说明及实际代码为准。

### **3.4.3 `stream()` 的流式调用方式**

当单次返回能跑通之后，接下来就可以看 `stream()`。它适合那些“结果不必等到全部生成完才展示”的场景，前端也可以据此做逐步渲染。

Service 新增方法：

```tsx
async streamDemo(input: string) {
  return this.model.stream([
    new SystemMessage('你是一名需求结构化抽取助手'),
    new HumanMessage(`请逐步分析并输出结构化抽取结果：\n${input}`),
  ]);
}
```

Controller 新增路由（SSE 方式）：

```tsx
@Post('stream')
async stream(@Body() body: { input: string }, @Res() res: Response) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const stream = await this.llmService.streamDemo(body.input);

  for await (const chunk of stream) {
    res.write(chunk.content);
  }

  res.end();
}
```

用 `curl` 验证：

```json
curl -s -X POST http://localhost:4001/api/langchain/stream \
  -H "Content-Type: application/json" \
  -d '{"input": "用户注册时必须绑定手机号，密码至少8位"}'
```

![https://p9-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/4694aa616f0d4bba91e4eed74349379f~tplv-k3u1fbpfcp-jj-mark](https://p9-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/4694aa616f0d4bba91e4eed74349379f~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=1216&h=994&s=384993&e=png&b=fefefe)配图仅为示例参考，具体内容以文章说明及实际代码为准。

### **3.4.4 `batch()` 的批量处理方式**

如果说 `invoke()` 解决的是“跑通一条”，`stream()` 解决的是“边生成边返回”，那么 `batch()` 解决的就是“同一套处理逻辑一次跑多条”。

Service 新增方法：

```tsx
async batchDemo(inputs: string[]) {
  const messageGroups = inputs.map((input) => [
    new SystemMessage('你是一名需求结构化抽取助手'),
    new HumanMessage(`请抽取 action、constraints、entities：\n${input}`),
  ]);

  const responses = await this.model.batch(messageGroups);
  return responses.map((item) => item.content.toString());
}
```

Controller 新增路由：

```tsx
@Post('batch')
async batch(@Body() body: { inputs: string[] }) {
  const results = await this.llmService.batchDemo(body.inputs);
  return { results };
}
```

### **3.4.5 三种调用方式的适用场景**

到这里，三种基础调用方式就都具备了。后面更复杂的能力，也都会建立在这些执行方式之上。

![img.png](https://p9-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/6030cd60312b40798a56bb08999eb624~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=1408&h=768&s=1198508&e=png&b=041324)

- **`invoke()`：一次请求拿到最终结果（最常用的默认选择）**
  - 适合：接口型能力（例如 `POST /requirement/extract`）需要一次性返回可断言的 JSON 或文本结果。
  - 适合：链路还在早期搭建阶段，先把“输入 → 模型 → 输出”主路径跑通，再逐步叠加解析、工具、检索。
  - 适合：需要更好地做重试、超时、缓存、幂等等工程治理，因为请求边界清晰。
  - 不太适合：内容很长、前端希望边生成边展示，或者用户等待时间会明显变长的场景。
- **`stream()`：边生成边返回（强调体验与可见性）**
  - 适合：前端要“逐字渲染”的交互，用户能立刻看到输出在推进，降低体感延迟。
  - 适合：输出较长的场景，例如多段解释、长文生成，或需要展示逐步推理过程（如果你的产品允许展示）。
  - 适合：服务端希望实时记录输出，或在生成过程中支持用户中断（前端断开连接即可停止接收）。
  - 注意：流式更难做结构化消费与断言测试。若目标是稳定 JSON，通常先 `invoke()` 拿结构化结果，再决定是否需要把“解释性内容”做成流式。
- **`batch()`：一次处理多条输入（强调吞吐与成本）**
  - 适合：离线任务、定时任务、数据回填，例如批量把一组需求文本抽取成结构化字段并写回数据库。
  - 适合：对同一 Prompt 处理多条相似输入时，减少请求开销，提升吞吐。
  - 适合：评测与回归测试：给定一组样本输入，批量跑一遍，对比输出差异。
  - 注意：批量请求的失败处理要更精细，例如返回顺序对应、部分失败重试，以及单条超时对整体的影响。

顺着这个基础，下一步就可以开始解决另一个真正会迅速膨胀的问题：提示词本身。

------

## 3.5 提示模板化改造

- 🤖 用 AI 生成本节代码（对应 3.5）

  将以下 Prompt 粘贴到 Claude CLI 中执行：

  ```markdown
  在 services/chat 的 LangChain 层中，把提示内容抽成模板，并提供最小模板渲染与调用示例，严格按以下要求执行：
  
  1. 提示模板：
     - 新建 services/chat/src/llm/prompts/requirement.prompt.ts
     - 导出 REQUIREMENT_SYSTEM_PROMPT
     - 导出 REQUIREMENT_USER_TEMPLATE（包含 {input} 占位符）
  
  2. 模板构建器：
     - 新建 services/chat/src/llm/requirement.prompt-builder.ts
     - 用 ChatPromptTemplate.fromMessages() 组装 system + human 消息
  
  3. 示例路由：
     - POST prompt-preview：只渲染模板，不调模型
     - POST prompt-to-model：模板 → formatMessages → 模型调用
  
  测试输入统一为：'用户注册时必须绑定手机号，密码至少8位'
  ```

### **3.5.1 字符串拼接方式的局限**

当接口和任务开始变多之后，直接拼接字符串会越来越难维护：提示重复、改动分散、变量插入也不够直观。与其等到后面再集中整理，不如在这个阶段就把提示内容抽到专门目录里。

```bash
services/chat/src/llm/prompts/
├─ requirement.prompt.ts
├─ classify.prompt.ts
└─ retrieve-answer.prompt.ts
```

### **3.5.2 最小提示模板的定义**

有了目录结构之后，先定义一组最小模板，把“系统角色”与“用户输入”从一开始就分开。

```
services/chat/src/llm/prompts/requirement.prompt.ts
export const REQUIREMENT_SYSTEM_PROMPT = `
你是一名"需求结构化抽取助手"。

你的任务是：
从输入文本中提取结构化字段。

严格要求：
1. 不允许编造信息
2. action 必须是唯一核心动作（动词+对象）
3. constraints 只保留明确约束（必须 / 至少 / 不得 / 不能）
4. entities 只提取文本中真实出现的名词
5. 如果不存在某字段，返回空数组

输出必须符合 schema，不要输出解释
`.trim();

export const REQUIREMENT_USER_TEMPLATE = `
请抽取结构化信息：

输入：
{input}
`.trim();
```

### **3.5.3 `ChatPromptTemplate.fromMessages()` 的作用**

模板常量定义好之后，接下来用 `ChatPromptTemplate` 把 system 与 human 两段消息组装成可复用提示。

```
services/chat/src/llm/requirement.prompt-builder.ts
import { ChatPromptTemplate } from '@langchain/core/prompts';
import {
  REQUIREMENT_SYSTEM_PROMPT,
  REQUIREMENT_USER_TEMPLATE,
} from './prompts/requirement.prompt';

export const requirementPrompt = ChatPromptTemplate.fromMessages([
  ['system', REQUIREMENT_SYSTEM_PROMPT],
  ['human', REQUIREMENT_USER_TEMPLATE],
]);
```

### **3.5.4 模板渲染结果的查看**

在真正把模板送给模型之前，最好先单独验证一次渲染结果。这样可以先确认变量替换和消息结构是否正确，再继续往后接。

Service 新增方法（只渲染模板，不调模型）：

```tsx
import { requirementPrompt } from './requirement.prompt-builder';

async promptPreview(input: string) {
  const promptValue = await requirementPrompt.invoke({ input });
  return { rendered: promptValue.toString() };
}
```

Controller 新增路由：

```tsx
@Post('prompt-preview')
async promptPreview(@Body() body: { input: string }) {
  return this.llmService.promptPreview(body.input);
}
```

### **3.5.5 将模板转换为消息数组**

模板确认无误后，再把它转换成消息数组并传给模型。这样调用路径就从“手写消息”切换成了“模板 → 消息 → 模型”。

Service 新增方法（模板 → 消息 → 模型）：

```tsx
async promptToModel(input: string) {
  const messages = await requirementPrompt.formatMessages({ input });
  const response = await this.model.invoke(messages);
  return { result: response.content };
}
```

Controller 新增路由：

```tsx
@Post('prompt-to-model')
async promptToModel(@Body() body: { input: string }) {
  return this.llmService.promptToModel(body.input);
}
```

用 `curl` 验证：

```json
curl -s -X POST http://localhost:4001/api/langchain/prompt-to-model \
  -H "Content-Type: application/json" \
  -d '{"input": "用户注册时必须绑定手机号，密码至少8位"}'
```

![img](https://p9-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/c7b19efa328c43e9b25ea202509d5281~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=1216&h=324&s=177196&e=png&b=fefefe)配图仅为示例参考，具体内容以文章说明及实际代码为准。

到这里，提示层就从“临时拼接”变成了“可复用模板”。接下来要解决的，就是如何把模板、模型和解析稳定地串成一条固定流程。

------

## 3.6 基础调用链的构建

- 🤖 用 AI 生成本节代码（对应 3.6）

  将以下 Prompt 粘贴到 Claude CLI 中执行：

  ```markdown
  在 services/chat 的 LangChain 层中，用 pipe() 构建最小调用链，严格按以下要求执行：
  
  1. 调用链：
     - 新建 services/chat/src/llm/requirement.chain.ts
     - 用 requirementPrompt.pipe(model).pipe(new StringOutputParser()) 构建链
     - 导出 requirementChain
  
  2. 新增以下路由：
     - POST chain-invoke
     - POST chain-stream
     - POST chain-batch
  
  输入统一为：'用户注册时必须绑定手机号，密码至少8位'
  ```

### **3.6.1 `pipe()` 的链式组合能力**

当步骤开始以固定顺序反复出现时，就不适合继续分散写在各个地方了。更合适的做法，是用 `pipe()` 把它们串成一条链。

![generated-image-1774765273638.png](https://p1-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/cfda5c0dd49e44fb96837af125652f42~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=1408&h=768&s=1225499&e=png&b=04101e)

### **3.6.2 `StringOutputParser` 的接入**

最小调用链通常由三段组成：提示模板、模型、输出解析。这里先接入一个最基础的 `StringOutputParser`，把模型输出统一转成纯字符串。

```
services/chat/src/llm/requirement.chain.ts
import { StringOutputParser } from '@langchain/core/output_parsers';
import { createChatModel } from './model.factory';
import { requirementPrompt } from './requirement.prompt-builder';

const model = createChatModel();
const parser = new StringOutputParser();

export const requirementChain = requirementPrompt.pipe(model).pipe(parser);
```

### **3.6.3 `chain.invoke()` 的调用方式**

链建好之后，最先用到的仍然是 `invoke()`。只不过这时你调用的，已经不再是“一个模型”，而是一条固定流程。

Service 新增方法：

```tsx
import { requirementChain } from './requirement.chain';

async chainInvoke(input: string) {
  const result = await requirementChain.invoke({ input });
  return { result };
}
```

Controller 新增路由：

```tsx
@Post('chain-invoke')
async chainInvoke(@Body() body: { input: string }) {
  return this.llmService.chainInvoke(body.input);
}
```

用 `curl` 验证：

```json
curl -s -X POST http://localhost:4001/api/langchain/chain-invoke \
  -H "Content-Type: application/json" \
  -d '{"input": "用户注册时必须绑定手机号，密码至少8位"}'
```

![image.png](https://p6-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/7964fe2486f54b169f0fe8d7310e572b~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=1216&h=326&s=158344&e=png&b=fefefe)配图仅为示例参考，具体内容以文章说明及实际代码为准。

### **3.6.4 `chain.stream()` 的流式执行**

如果同一条固定流程需要边执行边返回，那么也没必要退回手写拼接。链本身同样支持 `stream()`。

Service 新增方法：

```tsx
async chainStream(input: string) {
  return requirementChain.stream({ input });
}
```

Controller 新增路由（SSE 方式）：

```tsx
@Post('chain-stream')
async chainStream(@Body() body: { input: string }, @Res() res: Response) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const stream = await this.llmService.chainStream(body.input);

  for await (const chunk of stream) {
    res.write(chunk);
  }

  res.end();
}
```

### **3.6.5 `chain.batch()` 的批量执行**

同理，如果这条标准流程需要在多条输入上重复执行，那么也可以直接切到 `batch()`。

Service 新增方法：

```tsx
async chainBatch(inputs: string[]) {
  const results = await requirementChain.batch(
    inputs.map((input) => ({ input }))
  );
  return results.map((result, i) => ({ index: i + 1, result }));
}
```

Controller 新增路由：

```tsx
@Post('chain-batch')
async chainBatch(@Body() body: { inputs: string[] }) {
  return this.llmService.chainBatch(body.inputs);
}
```

### **3.6.6 链式调用的具体使用场景**

到这一节，重点已经不再是单独使用 `prompt`、`model` 或 `parser`，而是：**当一组步骤总是以同样顺序反复出现时，就应该把它们收束成一条可以重复执行的链。**

和 3.4 里直接调用模型相比，3.6 更适合解决这类问题：

- 你的输入前面总要先走一次提示模板填充
- 你的输出后面总要接一次统一解析
- 同一套流程会在多个接口、多个任务里反复复用
- 你希望把“提示 + 模型 + 解析”当成一个整体来调用、测试和替换

因此，链最适合承接的，不是“一次性的临时调用”，而是那些**已经开始稳定、会被反复复用的最小业务流程**。

### **`chain.invoke()`：适合固定流程的一次性结果返回**

当你的场景不是“裸调模型”，而是“模板 → 模型 → 解析”这一整套流程都必须稳定执行时，`chain.invoke()` 会成为最自然的默认选择。

- **需求抽取接口**：例如 `POST /requirement/extract` 这类接口，输入一段需求文本，输出一段已按统一风格整理过的结果。此时你不只是调用模型，而是在调用一条固定处理链。
- **文案标准化改写**：例如把用户原始输入统一改写为“更正式的需求描述”“更规范的标题”“更适合进入数据库的摘要”。这类任务通常都包含固定提示和固定输出形式。
- **分类、打标、轻量判断类任务**：比如判断一段文本属于“注册”“支付”“权限”哪个领域，或者先把问题改写后再进入后续流程。只要前后步骤稳定，链就比散落调用更容易维护。
- **服务层复用**：如果多个 Controller、定时任务、后台脚本都要复用同一套处理逻辑，那么把它收成 `requirementChain.invoke()`，比每个地方都各自写一遍 prompt 和 parser 更清晰。

一句话概括，`chain.invoke()` 适合：**结果要完整返回，而且这次返回背后其实已经有一条固定流水线。**

### **`chain.stream()`：适合同一条流程需要边产出边展示**

如果这条链本身已经稳定，但输出内容较长、用户等待时间较明显，或者前端希望边生成边展示，那么就适合把同一条链切到 `stream()`。

- **长文本生成**：例如根据一段需求说明生成一份较长的分析说明、接口草案、测试建议。如果仍然沿用同一个提示模板和输出流程，就没有必要退回“手动逐段拼接”，直接流式执行整条链即可。
- **前端即时反馈**：在聊天页、AI 辅助写作页、需求分析页中，用户往往不想等到最后一次性看到全部结果，而是希望看到内容正在生成。此时 `chain.stream()` 可以保留链式封装，又兼顾交互体验。
- **后台实时透出过程结果**：某些管理后台或内部工具，希望把生成过程实时输出到日志面板、控制台或 SSE 通道中。只要前面的 prompt 和后面的 parser 不变，流式链路仍然成立。
- **先统一流程，再决定展示方式**：一个很实用的工程思路是——先把固定流程写成 chain，之后再根据产品需要选择 `invoke()` 还是 `stream()`。这样“业务流程”和“返回方式”是分开的。

也就是说，`chain.stream()` 不是为了改变业务逻辑，而是为了在**同一条稳定流程**上优化用户体验。

### **`chain.batch()`：适合批量跑同一条标准处理链**

当同一个处理链要在多条输入上重复执行时，`chain.batch()` 会更合适。它解决的不是“能不能跑”，而是“怎样更成批、更统一地跑”。

- **历史数据回填**：例如你已经有一批旧需求文档，现在想批量抽取 `action / constraints / entities` 并写回数据库。此时最合适的不是在循环里一条条手写调用，而是直接批量执行同一条链。
- **导入前预处理**：比如运营或产品一次性导入几十条需求文本，希望在入库前先完成标准化整理、分类或摘要提取。链式批量处理可以让前置清洗逻辑保持一致。
- **评测与回归测试**：当你改了 prompt、换了模型、调整了解析逻辑，最需要做的就是拿一组样本批量重跑，对比前后输出差异。`chain.batch()` 天然适合这种“同题集测试”。
- **定时任务 / 离线任务**：晚上低峰时批量处理待分析文本、知识卡片、工单摘要等，本质上都是“同一条链在多条数据上重复执行”的场景。

在工程实践里，`chain.batch()` 往往是把“能跑的 AI 功能”推进到“可规模化处理的数据流程”的关键一步。

### **什么时候优先上链，而不是继续手写分散调用？**

可以用一个很直接的判断标准：**如果你已经连续两次以上写出“同一个 prompt + 同一个 model + 同一个 parser”的组合，就应该考虑把它收成 chain。**

因为从这个时点开始，你真正要维护的，已经不再是某次调用，而是一条业务流程。

所以，3.6 的核心意义并不是“会用 `pipe()` 这个 API”，而是学会识别：

- 哪些步骤属于稳定的固定链路
- 哪些能力应该被封装成可复用单元
- 哪些场景应该用统一链来承接，而不是把提示、模型、解析散落在各个文件和路由里

当你后面继续往结构化输出、工具调用、检索增强推进时，这种“先收束成链，再逐步加能力”的思路会越来越重要。

------

## 3.7 结构化输出与程序化消费

- 🤖 用 AI 生成本节代码（对应 3.7）

  将以下 Prompt 粘贴到 Claude CLI 中执行：

  ```markdown
  在 services/chat 的 LangChain 层中，让模型返回固定字段格式，严格按以下要求执行：
  
  1. 共享字段定义：
     - 在 packages/contracts/src/index.ts 中新增：
       - RequirementSchema
       - RequirementResultSchema
       - 导出 RequirementResult
  
  2. 结构化服务：
     - 新建 services/chat/src/llm/requirement.service.ts
     - 复用 prompts/requirement.prompt.ts 中的常量
     - 用 ChatPromptTemplate.fromMessages() 构建提示
     - 方法 extract(input: string)：
       - 用 prompt.formatMessages({ input })
       - 用 model.withStructuredOutput(RequirementResultSchema)
       - 返回结构化结果
  
  3. 新增路由：
     - POST structured
  ```

### **3.7.1 自由文本输出的局限**

前面几节已经把调用流程整理得更清楚了，但如果模型输出仍然是一段自由文本，它进入程序后的价值仍然有限。只要结果要作为接口返回值、下游输入或测试断言的一部分，自由文本的不稳定性就会成为问题。

![image.png](https://p1-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/426540da61ee4227995632bc27d96e29~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=2912&h=1440&s=6935174&e=png&b=1a1e2b)

### **3.7.2 共享字段结构的定义**

因此，下一步要做的，就是先把字段结构明确下来，并沉淀到共享 contract 中。

定义在 `packages/contracts/src/index.ts`：

```tsx
import { z } from 'zod';

export const RequirementSchema = z.object({
  input: z.string().min(1),
});

export const RequirementResultSchema = z.object({
  action: z.string().describe('唯一核心动作'),
  constraints: z.array(z.string()).describe('明确约束条件'),
  entities: z.array(z.string()).describe('关键实体'),
});

export type RequirementResult = z.infer<typeof RequirementResultSchema>;
```

### **3.7.3 `withStructuredOutput()` 的使用方式**

有了共享 schema 之后，就可以让模型直接朝着这个结构输出，而不是再依赖后置字符串清洗。

```
services/chat/src/llm/requirement.service.ts
import { Injectable } from '@nestjs/common';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import {
  RequirementResultSchema,
  type RequirementResult,
} from '@autix/contracts';
import { createChatModel } from './model.factory';
import {
  REQUIREMENT_SYSTEM_PROMPT,
  REQUIREMENT_USER_TEMPLATE,
} from './prompts/requirement.prompt';

@Injectable()
export class RequirementService {
  private model = createChatModel();

  private prompt = ChatPromptTemplate.fromMessages([
    ['system', REQUIREMENT_SYSTEM_PROMPT],
    ['human', REQUIREMENT_USER_TEMPLATE],
  ]);

  async extract(input: string): Promise<RequirementResult> {
    const messages = await this.prompt.formatMessages({ input });
    const structuredModel = this.model.withStructuredOutput(
      RequirementResultSchema
    );
    return structuredModel.invoke(messages);
  }
}
```

### **3.7.4 结构化输出的工程价值**

到这里，模型结果才真正开始具备“可被程序稳定消费”的条件。

Controller 新增路由：

```tsx
@Post('structured')
async structured(@Body() body: { input: string }) {
  return this.requirementService.extract(body.input);
}
```

用 `curl` 进行验证：

```json
curl -s -X POST http://localhost:4001/api/langchain/structured \
  -H "Content-Type: application/json" \
  -d '{"input": "用户注册时必须绑定手机号，密码至少8位"}'
```

返回结果：

![image4.png](https://p6-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/3fd1d252464d48148ec51a6f5ed6d702~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=1216&h=292&s=139827&e=png&b=fefefe)配图仅为示例参考，具体内容以文章说明及实际代码为准。

- 注意：如果出现解析错误，可以在 prompt 中明确要求返回 JSON 结构，或额外实现一个 JSON 解析兜底。即使已经声明返回 JSON，也仍可能出现输出夹杂解释文本的情况；这种问题需要通过提示约束、解析兜底和测试样例一起处理。

到这一层之后，LangChain 才开始进入工程化语境：只有结构稳定，测试、回归、复用和下游编排才有基础。

------

## 3.8 工具调用机制的接入

- 🤖 用 AI 生成本节代码（对应 3.8）

  将以下 Prompt 粘贴到 Claude CLI 中执行：

  ```markdown
  在 services/chat 的 LangChain 层中，接入工具调用机制，严格按以下要求执行：
  
  1. 工具定义：
     - 新建 services/chat/src/llm/tools/basic.tools.ts
     - 定义两个工具：
       - check_constraint_validity
       - lookup_entity_definition
  
  2. 在 LlmService + LlmController 中新增以下路由：
     - POST tool-bind
     - POST tool-loop
  
  输入统一使用需求抽取场景。
  ```

### **3.8.1 工具的本质：可调用函数**

做到结构化输出之后，同一段需求文本已经能被整理成稳定字段。但模型本身仍然只能生成内容。如果希望它在抽取之后继续校验约束、补充规则说明，就需要把工具接进来。

![image.png](https://p1-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/483e25eda6c44dcbb78764d9ed4262ca~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=2528&h=1696&s=6899533&e=png&b=1f2733)

这里先接两个最小工具，目的不是把场景做复杂，而是帮助你看清：模型负责决策，工具负责提供确定性结果。

- 校验约束是否合法
- 查询实体定义

```
services/chat/src/llm/tools/basic.tools.ts
import { z } from 'zod';
import { tool } from '@langchain/core/tools';

export const checkConstraintValidityTool = tool(
  async ({ constraint }: { constraint: string }) => {
    const passed = /必须|至少|不得|不能/.test(constraint);
    return {
      constraint,
      passed,
      reason: passed ? '命中明确约束模式' : '不属于明确约束表达',
    };
  },
  {
    name: 'check_constraint_validity',
    description: '校验一条约束是否属于明确约束表达',
    schema: z.object({
      constraint: z.string(),
    }),
  }
);

export const lookupEntityDefinitionTool = tool(
  async ({ entity }: { entity: string }) => {
    const map: Record<string, string> = {
      用户: '系统中的账号主体',
      手机号: '用于身份绑定与验证的联系字段',
      密码: '用于登录认证的安全凭证',
    };

    return {
      entity,
      definition: map[entity] ?? '未命中内置定义',
    };
  },
  {
    name: 'lookup_entity_definition',
    description: '查询实体在业务中的定义说明',
    schema: z.object({
      entity: z.string(),
    }),
  }
);
```

### **3.8.2 `bindTools()` 的绑定方式**

工具定义好之后，下一步就是把它们绑定到模型上。

Service 新增方法：

```tsx
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import {
  checkConstraintValidityTool,
  lookupEntityDefinitionTool,
} from './tools/basic.tools';

async toolBindDemo(input: string) {
  const modelWithTools = this.model.bindTools([
    checkConstraintValidityTool,
    lookupEntityDefinitionTool,
  ]);

  const response = await modelWithTools.invoke([
    new SystemMessage('你可以按需要调用工具来校验约束和查询实体定义。'),
    new HumanMessage(`请分析下面需求：${input}`),
  ]);

  return {
    result: response.content.toString(),
    toolCalls: response.tool_calls,
  };
}
```

### **3.8.3 `tool_calls` 返回结构的理解**

当模型绑定工具后，它不一定会立刻给出最终答案。很多时候，它会先通过 `tool_calls` 声明：它准备调用哪个工具、参数是什么、调用 id 是多少。

这一步非常关键，因为从这里开始，模型就不再只是“生成一段文本”，而是在参与一个可审计的执行流程。

### **3.8.4 工具执行闭环的手动实现**

工具调用的关键，不只是让模型声明要调用哪个工具，还要把“声明调用 → 执行工具 → 回填结果 → 生成最终答复”这条闭环接起来。

Service 新增方法（完整工具执行闭环）：

```tsx
import {
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';

async toolLoopDemo(input: string) {
  const tools: StructuredToolInterface[] = [
    checkConstraintValidityTool,
    lookupEntityDefinitionTool,
  ];
  const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));
  const modelWithTools = this.model.bindTools(tools);

  const messages: BaseMessage[] = [
    new SystemMessage('你可以调用工具来帮助完成需求抽取后的校验。'),
    new HumanMessage(
      `先抽取 action、constraints、entities，再按需要调用工具：${input}`
    ),
  ];

  const firstResponse = await modelWithTools.invoke(messages);
  messages.push(firstResponse);

  for (const toolCall of firstResponse.tool_calls ?? []) {
    const targetTool = toolMap[toolCall.name];
    if (!targetTool) continue;
    const toolResult = await targetTool.invoke(toolCall.args);
    messages.push(
      new ToolMessage({
        tool_call_id: toolCall.id ?? '',
        content: JSON.stringify(toolResult),
      })
    );
  }

  const finalResponse = await modelWithTools.invoke(messages);
  return { result: finalResponse.content };
}
```

用 `curl` 验证：

```json
curl -s -X POST http://localhost:4001/api/langchain/tool-bind \
  -H "Content-Type: application/json" \
  -d '{"input": "用户注册时必须绑定手机号，密码至少8位"}'
```

返回结果：

![img.png](https://p6-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/455fa7edae4e420dbdb9a610e755aad3~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=1776&h=340&s=262203&e=png&b=fefefe)配图仅为示例参考，具体内容以文章说明及实际代码为准。

### **3.8.5 工具调用适合解决什么问题**

这一节要抓住的判断是：**当答案依赖外部事实、外部规则或真实动作时，就该上工具；否则优先用 prompt / 结构化输出解决。**

工具调用的分工可以概括为一句话：**模型负责“决定是否调用、调用哪个、何时继续”，工具负责“给出确定性结果”。**

常见场景可以浓缩成四类：

- **规则校验**：抽取后再验（例如 `check_constraint_validity` 判断约束是否合格）。
- **事实查询**：实体定义、配置、订单状态等必须“查系统 / 查库”（例如 `lookup_entity_definition`）。
- **流程编排**：模型做路由 / 决策，工具做执行（工单分流、表单审核、缺失项检查）。
- **高风险闭环**：先产出 `tool_calls` → 系统执行 → `ToolMessage` 回填 → 再生成最终答复，保证可审计、可限权、可定位失败点。

当你接受了这个分工，后面再进入 RAG、MCP 或 Agent runtime 时，理解成本就会低很多：因为这些能力的本质，也是在进一步扩展“模型负责判断，系统负责执行”的边界。

## 3.9 能力收束与统一入口

- 🤖 用 AI 生成本节代码（对应 3.9）

  将以下 Prompt 粘贴到 Claude CLI 中执行：

  ```markdown
  把前面所有 LangChain 能力收回到 Nest 服务端，并更新前端页面，严格按以下要求执行：
  
  1. 服务层：
     - services/chat/src/llm/requirement.service.ts
     - @Injectable() 类 RequirementService
     - 对外提供 extract(input: string): Promise<RequirementResult>
  
  2. Controller：
     - services/chat/src/app.controller.ts
     - POST /requirement/extract 接收 { input: string }
  
  3. 前端页面：
     - textarea + 提交按钮 + JSON 结果展示
     - 默认输入：'用户注册时必须绑定手机号，密码至少8位'
  
  4. 增加测试文件：
     - services/chat/test/requirement.spec.ts
  ```

前面几个小节里，我们有意把能力拆开来看：模型调用、提示模板、链式组合、结构化输出、工具调用。到了这一节，就要把这些分散示例重新收束回业务入口。

### **3.9.1 按业务域拆分 Service**

当能力开始变多时，Service 的拆分方式也该逐渐从“技术演示”切换到“业务域承载”。因此，这里不再继续使用 `SummaryService` 之类的泛化命名，而是直接落到真实业务名：`RequirementService`。

```
services/chat/src/llm/requirement.service.ts
import { Injectable } from '@nestjs/common';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import {
  RequirementResultSchema,
  type RequirementResult,
} from '@autix/contracts';
import { createChatModel } from './model.factory';
import {
  REQUIREMENT_SYSTEM_PROMPT,
  REQUIREMENT_USER_TEMPLATE,
} from './prompts/requirement.prompt';

@Injectable()
export class RequirementService {
  private model = createChatModel();

  private prompt = ChatPromptTemplate.fromMessages([
    ['system', REQUIREMENT_SYSTEM_PROMPT],
    ['human', REQUIREMENT_USER_TEMPLATE],
  ]);

  async extract(input: string): Promise<RequirementResult> {
    const messages = await this.prompt.formatMessages({ input });
    const structuredModel = this.model.withStructuredOutput(
      RequirementResultSchema
    );
    return structuredModel.invoke(messages);
  }
}
```

### **3.9.2 统一入口 Controller**

Service 按业务域收束之后，Controller 也应同步收口成统一入口，而不是继续暴露一堆演示性质的路由。

```
services/chat/src/app.controller.ts
import { Body, Controller, Get, Post } from '@nestjs/common';
import { AppService } from './app.service';
import { RequirementService } from './llm/requirement.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly requirementService: RequirementService
  ) {}

  // 健康探针：为 Compose/监控提供稳定入口
  @Get('health')
  getHealth() {
    return this.appService.getHealth();
  }

  // 验证「共享包 + API 返回 + 前端消费」的最小闭环
  @Get('hello')
  getHello() {
    return this.appService.getHello();
  }

  // 3.9 能力收束：把整条链路落到统一业务入口
  @Post('/requirement/extract')
  async extract(@Body() body: { input: string }) {
    return this.requirementService.extract(body.input);
  }
}
```

测试文件：

```
services/chat/test/requirement.spec.ts
import { describe, it, expect } from 'bun:test';
import { RequirementService } from '../src/llm/requirement.service';

// 该用例会发起真实模型调用（耗时且依赖外部服务），默认跳过。
// 需要端到端验证时显式开启：RUN_LLM_E2E=1 bun test
const runIf = process.env.RUN_LLM_E2E ? it : it.skip;

describe('Requirement Extract', () => {
  runIf(
    'should extract correctly',
    async () => {
      const service = new RequirementService();
      const result = await service.extract(
        '用户注册时必须绑定手机号，密码至少8位'
      );

      // 结构化输出约定：字段类型稳定（这是 withStructuredOutput 的核心保证）
      expect(typeof result.action).toBe('string');
      expect(result.action.length).toBeGreaterThan(0);
      expect(Array.isArray(result.constraints)).toBe(true);
      expect(Array.isArray(result.entities)).toBe(true);
      expect(result.constraints.length).toBeGreaterThan(0);
      // 输入中明确出现"手机号"，应在抽取结果中有所体现（LLM 措辞可能不同，故只断言语义命中）
      expect(JSON.stringify(result)).toContain('手机号');
    },
    30000
  );
});
```

> 说明：用例运行时，模型返回的字段措辞会随模型/温度波动（例如 `action` 可能是「用户注册」也可能是「绑定手机号」）。因此断言只校验**结构化约定**与关键语义命中，而不锁死具体字符串；这正是 `withStructuredOutput` 想保证的部分。

### **3.9.3 前端页面的职责边界**

服务端入口收束完成后，前端的职责反而会变得更清楚：它不负责理解模型，不负责解析结构，也不负责规则校验，只负责输入、请求与展示。

```
clients/chat-web/app/page.tsx
'use client';

import { useState } from 'react';
import type { RequirementResult } from '@autix/contracts';

export default function Home() {
  const [input, setInput] = useState('用户注册时必须绑定手机号，密码至少8位');
  const [result, setResult] = useState<RequirementResult | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit() {
    setLoading(true);
    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_BASE_URL}/requirement/extract`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input }),
        }
      );
      const data = await res.json();
      setResult(data);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ padding: 24, maxWidth: 720 }}>
      <h1>Requirement Extract Demo</h1>

      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        rows={8}
        style={{ width: '100%' }}
      />

      <button onClick={handleSubmit} disabled={loading} style={{ marginTop: 12 }}>
        {loading ? '提取中…' : '提取'}
      </button>

      <pre style={{ marginTop: 16 }}>{JSON.stringify(result, null, 2)}</pre>
    </main>
  );
}
```

![image.png](https://p9-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/60b046f69afe4d9fa3afbf05b9465339~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=2182&h=1418&s=110515&e=png&b=fcfcfc)配图仅为示例参考，具体内容以文章说明及实际代码为准。

前端职责边界可以浓缩成三件事：

- **输入需求文本**：提供 textarea 或表单组件，让用户输入原始需求描述，前端只负责采集，不做任何预处理或格式约束。
- **请求统一接口**：通过 `fetch` 调用 `POST /requirement/extract`，把输入原样交给服务端，前端不关心背后是哪个模型、哪条链、用了什么工具。
- **展示结构化 JSON**：拿到服务端返回的 `action / constraints / entities` 后直接渲染，前端不需要做二次解析或字段校验。

模型规则、结构化抽取、工具调用、测试与校验都留在服务端处理。前端越薄，后端能力迭代时需要联动改动的地方就越少。

到这里，本章前面拆开的能力——模型调用、提示模板、链式编排、结构化输出、工具调用——就收束成了一个业务上可用、可测试、可持续迭代的入口。

------

## 3.10 本章小结

这一章承接第二章和第 2.5 章，完成了一次关键过渡：第二章搭好了工程底座，第 2.5 章把 AI 辅助开发的节奏讲清楚，而本章开始把模型能力真正接进服务端。

整章只围绕一个任务展开：从需求文本中抽取 `action / constraints / entities`。这样做的好处是，每一步都能落到同一个业务目标上，而不是为了展示 API 而展示 API。

### **回顾：每一层解决了什么问题**

- **模型层（3.4）**：解决”怎样把模型接进服务端”。通过统一工厂收口初始化，避免配置散落；通过 `invoke()` / `stream()` / `batch()` 三种执行方式，覆盖最常见的调用形态。
- **提示层（3.5）**：解决”提示内容怎样不失控”。把角色定义和用户输入模板化，拆到独立目录，变量填充有据可查，修改不再牵一发动全身。
- **链式层（3.6）**：解决”重复出现的步骤怎样统一管理”。用 `pipe()` 把模板、模型、解析串成一条可复用的固定流程，后续只需调用链，而不是每次重写拼装逻辑。
- **解析层（3.7）**：解决”模型输出怎样进入程序”。通过共享 Zod schema 和 `withStructuredOutput()`，让返回结果从自由文本变成可断言、可消费的固定字段结构。
- **工具层（3.8）**：解决”模型只会生成内容、不会执行动作”。通过 `bindTools()` 和工具执行闭环，让模型可以在需要时主动调用校验与查询，而不是把所有判断都塞进提示词。
- **收束层（3.9）**：解决”能力怎样变成业务入口”。把前面所有层次重新收进 `RequirementService` + `POST /requirement/extract`，前端只负责输入与展示，服务端承接全部复杂度。

### **本章的核心收获**

比记住 API 名称更重要的，是形成几条后面可以反复使用的判断标准：

- **什么时候该上模板？** 当你发现同一段提示词出现在两个以上的地方，或者修改一次提示需要改动多个文件时。
- **什么时候该上链？** 当”模板 → 模型 → 解析”这组步骤已经稳定，并且在多个接口或任务中被反复调用时。
- **什么时候该上结构化输出？** 当模型结果需要作为接口返回值、下游输入或测试断言的一部分，而不是仅供人类阅读时。
- **什么时候该上工具？** 当答案依赖外部事实、外部规则或真实动作，而不是模型自身的生成能力就能覆盖时。
- **什么时候该收束？** 当分散的示例代码已经验证通过，下一步是让它变成可被其他模块、其他团队、其他环境稳定调用的入口时。

### **后续章节的衔接**

本章建立的递进方式——先定义任务、再逐层叠加能力、最后收束成接口——会继续贯穿后续章节。区别只在于，后面要处理的能力会从“单链路”扩展到更复杂的系统形态：

- **RAG（检索增强生成）**：模型不再只依赖自身知识，而是在回答前先检索相关文档，解决”知识覆盖不足”的问题。
- **MCP（模型上下文协议）**：工具调用不再局限于本地函数，而是通过标准化协议接入外部系统，解决”能力边界封闭”的问题。
- **Agent Runtime**：模型不再只执行一条固定链路，而是根据上下文动态决定下一步该做什么，解决”流程不够灵活”的问题。

但无论后面走多远，核心原则都不变：**先把任务定义清楚，再把能力放到正确的层，最后收束成可测试、可迭代的入口。** 只要这条线不断，系统复杂度就始终有归属，不会退回到“到处散落、难以维护”的状态。