# Chapter 03 · NestJS 集成 LLM / LangChain 总结

> 复习向笔记：如何在 NestJS 中把 LangChain 封装成可持续演进的模型服务层。
> 工程原型：autix `services/chat`（`@autix/chat`），模型 `ChatOpenAI`（兼容 OpenAI / 百炼 / 中转网关）。
> 铁律：**所有密钥、地址、模型名一律走 `process.env` / 配置文件，禁止硬编码。**

---

## 0. 全局心智图

```
配置层(env/yaml → ConfigService)
   → 封装层(LLM Provider + ChatService)
      → 调用层(invoke / stream / batch)
         → 增强层(提示词模板 → 结构化输出 → LCEL 调用链 → 工具调用)
```

每一层只依赖下一层的抽象，不直接碰 SDK 细节——这是能长期演进的关键。

---

## 1. 配置层：env + yaml

### 1.1 环境变量（.env）

环境变量承载**敏感信息与随部署环境变化的值**：

```env
# .env（严禁提交 git，配合 .env.example 提供模板）
LLM_API_KEY=sk-xxxxxx
LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
LLM_MODEL=qwen-plus
LLM_TEMPERATURE=0.7
PORT=3000
```

### 1.2 yaml 配置（config.yaml）

yaml 承载**非敏感的结构化业务配置**（模型参数、路由前缀、开关）：

```yaml
llm:
  model: qwen-plus
  temperature: 0.7
  maxTokens: 2048
  timeoutMs: 60000
api:
  prefix: /api/langchain
  streaming: true
```

### 1.3 在 NestJS 中加载与校验

- `@nestjs/config` 的 `ConfigModule.forRoot({ isGlobal: true, load: [...] })` 统一注册；
- yaml 用 `js-yaml` 读取后并入 `load` 工厂函数；env 通过内置 loader 读取；
- **启动期校验**（zod / class-validator）：配置缺失直接 fail-fast，不让带病服务上线。

```ts
// app.module.ts
import yaml from 'js-yaml';
import { readFileSync } from 'fs';

const yamlConfig = () => yaml.load(readFileSync('config.yaml', 'utf8'));

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [yamlConfig],
      // env 会被自动合并进 process.env，经 ConfigService 取用时类型安全
    }),
  ],
})
export class AppModule {}
```

```ts
// 取用：任何 provider 注入 ConfigService，严禁直接散落 process.env
constructor(private readonly config: ConfigService) {
  this.apiKey = this.config.get<string>('LLM_API_KEY'); // 敏感项仍来自 env
  this.model = this.config.get<string>('llm.model');    // 业务项来自 yaml
}
```

**分工原则**：敏感/环境相关 → env；结构化/业务可调 → yaml；两者统一经 `ConfigService` 出口。

---

## 2. LLM 封装：Provider + Service

NestJS 的依赖注入天然适合做「模型实例单例化」：

- **Provider**：工厂模式创建 `ChatOpenAI` 实例（读配置、注入实例），全局单例、可替换实现；
- **Service**：封装业务语义方法（如 `chat()` / `streamChat()`），Controller 只调用 Service，不感知 SDK。

```ts
// llm.provider.ts
export const LLM_PROVIDER = 'LLM_PROVIDER';

export const LlmProvider: Provider = {
  provide: LLM_PROVIDER,
  useFactory: (config: ConfigService) =>
    new ChatOpenAI({
      apiKey: config.get<string>('LLM_API_KEY'),
      configuration: { baseURL: config.get<string>('LLM_BASE_URL') },
      model: config.get<string>('llm.model'),
      temperature: config.get<number>('llm.temperature'),
      maxTokens: config.get<number>('llm.maxTokens'),
    }),
  inject: [ConfigService],
};
```

```ts
// langchain.service.ts
@Injectable()
export class LangchainService {
  constructor(@Inject(LLM_PROVIDER) private readonly llm: ChatOpenAI) {}
  // 业务方法写在这里……
}
```

**收益**：换模型只改工厂；单测可 mock `LLM_PROVIDER`；Controller 零 SDK 依赖。

---

## 3. 三种调用方式：invoke / stream / batch

| 方式 | 返回形态 | 典型场景 |
|------|---------|---------|
| `invoke` | 一次性完整结果 | 内部任务、结构化抽取、不需要人眼实时等待的过程调用 |
| `stream` | 异步迭代 token | 用户可见的对话界面（打字机效果）、长文本生成 |
| `batch` | 并发批量结果 | 离线批处理：批量打标、批量摘要、批量分类 |

### 3.1 invoke——最朴素的一问一答

```ts
const res = await this.llm.invoke([
  new SystemMessage('你是一个严谨的技术助手'),
  new HumanMessage(input),
]);
return res.content as string;
```

### 3.2 stream + SSE——流式返回的关键

服务端用 LangChain 的 `stream()` 逐 chunk 拿增量，再用 SSE 推给前端：

```ts
@Sse('stream')  // GET /api/langchain/stream?input=...
stream(@Query('input') input: string) {
  const stream = await this.llm.stream(input);

  return new Observable<MessageEvent>((subscriber) => {
    (async () => {
      for await (const chunk of stream) {
        subscriber.next({ data: { content: chunk.content } }); // 每个 chunk 一条 SSE event
      }
      subscriber.next({ data: { done: true } }); // 结束标记
      subscriber.complete();
    })();
    return () => stream.return?.(undefined); // 客户端断开时释放资源
  });
}
```

要点：
- SSE 是**单向**（服务端 → 客户端）长连接，协议就是普通 HTTP，比 WebSocket 轻，适合纯推送场景；
- 流式接口用 `GET + @Sse`（EventSource 原生只支持 GET）；非流式走 `POST + DTO 校验`；
- 必须处理**取消**：客户端断开时终止上游迭代，否则模型 token 白烧；
- 结束要有 sentinel（如 `{ done: true }`），前端据此关流。

### 3.3 batch——一次提交并发跑

```ts
const results = await this.llm.batch([
  '总结这篇文档：……A',
  '总结这篇文档：……B',
  '总结这篇文档：……C',
]);
// 返回与输入顺序一致的数组，内部自动并发（concurrency 可配）
```

注意：batch ≠ for 循环 invoke——它由 SDK 统一调度并发，吞吐高；但要防限流（配 `maxConcurrency`）。

---

## 4. 提示词模板化

**问题**：字符串拼接提示词难维护、难测试、易注入。
**方案**：`ChatPromptTemplate` 把「骨架」与「变量」分离，变量自动转义。

```ts
import { ChatPromptTemplate } from '@langchain/core/prompts';

const prompt = ChatPromptTemplate.fromMessages([
  ['system', '你是资深 {domain} 架构师，回答控制在 {maxPoints} 点以内。'],
  ['human', '{question}'],
]);

const filled = await prompt.invoke({ domain: '前端', maxPoints: 3, question: '微前端如何做隔离？' });
```

要点：
- system / human / ai 角色**成对有序**构成对话骨架；
- 模板实例通常作为类的常量属性（或独立 `prompts/` 目录），**与业务逻辑分离**；
- 模板化后天然可与 LCEL 拼装成链（见 §6）。

---

## 5. 结构化输出与程序化消费

**问题**：`res.content` 是 string 或未知结构，程序无法安全消费。
**方案**：zod schema 声明契约 → `withStructuredOutput()` 强约束 → 拿到**类型安全的对象**。

```ts
import { z } from 'zod';

const AnalysisResult = z.object({
  sentiment: z.enum(['positive', 'negative', 'neutral']),
  keywords: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});
type AnalysisResult = z.infer<typeof AnalysisResult>;

const structuredLlm = this.llm.withStructuredOutput(AnalysisResult);

const result = await structuredLlm.invoke('分析这条评论：界面真难用……');
result.keywords.forEach((k) => console.log(k)); // ✅ 类型安全，直接程序化消费
```

链路：**zod schema →（SDK 内部转为 function calling / JSON mode 约束）→ 校验后的对象**。

要点：
- 底层常用 tool-calling 协议实现强约束，比「prompt 里求它输出 JSON」可靠得多；
- zod 既是**编译期类型**也是**运行时校验**，两道保险；
- 消费侧拿到的是普通 TS 对象，可直接入库、进管道、喂下游函数；
- 兜底：仍要 catch 校验失败/模型拒答，做重试（呼应 chapter01 的容错重试闭环）。

---

## 6. 基础调用链（LCEL）

LCEL（LangChain Expression Language）用 `pipe` 把 Runnable 组件串成链：

```ts
const chain = prompt.pipe(this.llm).pipe(new StringOutputParser());

// 链本身也是 Runnable，因此天然获得三种调用方式：
await chain.invoke({ domain: '前端', maxPoints: 3, question: '...' });
await chain.stream({ ... });   // 流式：模板→模型→parser 逐环节透传流
await chain.batch([{ ... }, { ... }]);
```

要点：
- `prompt.pipe(llm).pipe(parser)` 是最经典三段式：**组装上下文 → 推理 → 规整输出**；
- Runnable 接口是统一抽象：prompt、llm、parser、retriever、自定义函数（`RunnableLambda`）都可互换拼装；
- 链上层调用方式（invoke/stream/batch）自动继承，**封装一次，三种消费方式全通**；
- 调试可用 `.streamEvents()` 观察链内每一步的输入输出（也是可观测性的切入点）。

---

## 7. 工具调用机制

让模型从「会说」升级为「会做」：模型不执行工具，只**决策**调用哪个工具＋参数；**执行权永远在程序侧**。

### 7.1 定义工具（zod 描述参数）

```ts
import { tool } from '@langchain/core/tools';

const weatherTool = tool(
  async ({ city }) => {
    // 真实实现：查库 / 调 API
    return `${city} 今天多云，22℃`;
  },
  {
    name: 'get_weather',
    description: '查询指定城市的实时天气',
    schema: z.object({ city: z.string().describe('城市名，如"成都"') }),
  },
);
```

**description 和 zod 的 `.describe()` 就是给模型看的说明书**，写得越准，选择越准。

### 7.2 绑定并触发

```ts
const llmWithTools = this.llm.bindTools([weatherTool]);

const res = await llmWithTools.invoke('成都今天适合穿什么？');
// res.tool_calls = [{ name: 'get_weather', args: { city: '成都' } }]
```

### 7.3 手动执行循环（理解原理）

```ts
const aiMsg = await llmWithTools.invoke(messages);
while (aiMsg.tool_calls?.length) {
  for (const call of aiMsg.tool_calls) {
    const result = await toolMap[call.name].invoke(call.args); // 程序执行
    messages.push(aiMsg, new ToolMessage({ tool_call_id: call.id, content: result }));
  }
  aiMsg = await llmWithTools.invoke(messages); // 把结果回喂，模型决定继续调 or 收尾
}
return aiMsg.content; // 模型不再发起 tool_call 时，给出最终回答
```

要点：
- 循环 = **模型决策 → 程序执行 → 结果回喂 → 再决策**，直到模型不再要求调工具；
- 生产可用 `createReactAgent` / AgentExecutor 封装此循环（含 maxIterations 防失控）；
- 工具必须幂等/受控——模型可能重复或以异常参数调用；
- `tool_call_id` 必须原样回传，否则协议报错。

---

## 8. 复习速查

| 知识点 | 一句话记忆 |
|--------|-----------|
| env vs yaml | 敏感/环境值走 env；结构化业务配置走 yaml；统一 ConfigService 出口 |
| LLM 封装 | Provider 工厂产单例，Service 收敛业务，Controller 零 SDK 依赖 |
| invoke | 一问一答，拿完整结果，过程调用首选 |
| stream + SSE | 逐 token 推送；单向 HTTP 长连接；记得处理断连与结束标记 |
| batch | SDK 统一并发调度；注意限流与 maxConcurrency |
| 提示词模板 | ChatPromptTemplate 分离骨架与变量；system/human 成对有序 |
| 结构化输出 | zod + withStructuredOutput；编译期类型 + 运行时校验双保险 |
| LCEL | pipe 串 Runnable；链是 Runnable，三种调用方式自动继承 |
| 工具调用 | 模型只决策不执行；循环=决策→执行→回喂→再决策；tool_call_id 必须回传 |
| 安全红线 | 密钥零硬编码；.env 不进 git；配置启动期校验 fail-fast |

**常见坑**：
1. Controller 里直接 new ChatOpenAI → 配置散落、无法测试（应走 Provider）；
2. SSE 接口用 POST → EventSource 不支持，得用 fetch+ReadableStream 或改 GET；
3. 忘记 `StringOutputParser` → 拿到的是 AIMessage 对象而非 string；
4. 直接信任模型输出的 JSON 字符串 → 应使用 withStructuredOutput 强约束；
5. 工具循环不设上限 → 构造死循环烧 token。
