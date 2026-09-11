![cleaned-image_(3).png](https://p9-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/24be15f6b1bc43c28bc5ba45f33f9b14~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=2752&h=1536&s=7203580&e=png&b=0a1d32)

本章分支[feat/db-vector](https://link.juejin.cn/?target=https%3A%2F%2Fgithub.com%2FCookieboty%2Fautix-demo%2Ftree%2Ffeat%2Fdb-vector)

第四章已经完成了 Memory、Tools、Embeddings 与 Multi-Agent 的能力验证，但这些实现仍停留在 **demo 形态**：数据主要保存在进程内存或本地文件中。`InMemoryChatMessageHistory` 会在服务重启后丢失，`MemoryVectorStore` 会随进程退出清空，`workspace/requirements/*.json` 也只是手写 mock 数据；同时，系统尚未引入用户身份与数据隔离机制。

对于学习验证或原型演示，这种实现足够支撑流程跑通。**但当系统需要服务多个用户、长期运行，并支持历史回溯与知识库复用时**，就必须把会话、文件、向量和任务状态迁移到可持久、可管理、可隔离的存储体系中。

**本章承接第四章的能力基础，完成从 demo 到生产形态的关键改造：数据库建模、会话持久化、文档上传、向量化落库、任务通知，以及端到端分析链路串联。**

> 📎 **命名 / 路径 / 数据模型对齐** 本章直接采用当前仓库中的真实落地命名：`services/chat`（NestJS，端口 `4001`）。后文涉及的代码路径、接口路由与验证命令均与仓库实现保持一致。
>
> 数据模型以仓库真实 schema 为准，便于第六章继续叠加 artifacts 与 UI 协议：
>
> - **chat 库不内建 User 表**：用户系统由 user-system 微服务维护，chat 服务仅保存裸 `String` 类型的 `userId`，不建立跨服务外键。
> - 表名采用 snake_case 复数：`conversations / messages / documents / document_chunks / task_events`。
> - `messages.role` 使用枚举 `MessageRole { USER, ASSISTANT }`，与 `DbChatHistory` 中的 LangChain `HumanMessage / AIMessage` 映射保持一致。
> - `document_chunks.embedding` 使用 `Unsupported("vector")`，不在 schema 层限定维度，实际写入 384 维向量。
> - 文档处理完成状态统一为 `done`，不是 `completed`。
> - SSE 事件既用于实时推送，也会持久化到 `task_events` 表。

本章还依赖一个前提：用户系统已经完成（见第 2.5 章的 RBAC user-system）。chat 服务复用同一套 **JWT 鉴权**机制，通过相同的 `JWT_SECRET` 校验访问令牌，并从令牌中解析 `userId`，据此为不同用户隔离会话、文档和向量数据。

✅ **本章验收点**

- 完成 Prisma Schema 设计：conversations、messages、documents、document_chunks、task_events 五张核心表（User 由 user-system 维护）
- 用 pgvector 扩展替换 MemoryVectorStore，向量数据持久化到 PostgreSQL
- 实现文件上传接口，支持 PDF/TXT/MD/DOCX 格式，元数据入库
- 实现文件解析 → 分块 → 向量化 → 落库的完整 Pipeline
- 会话按用户隔离，历史消息持久化到数据库，重启不丢失
- SSE 实时推送向量化任务进度，并把任务事件持久化
- 统一调用链路：用户登录 → 创建会话 → 上传需求文档 → 带上下文的需求分析 → 结果持久化
- 每个阶段都保留对应的实现 Prompt，正文只展开关键设计与核心片段。

------

## 5.1 从 Demo 到生产，还差什么

第四章已经验证了完整流程，但距离可上线的工程形态仍存在明显差距：

| **能力** | **第四章实现**               | **生产级问题**             | **本章方案**                            |
| -------- | ---------------------------- | -------------------------- | --------------------------------------- |
| 会话记忆 | `InMemoryChatMessageHistory` | 重启丢失，无用户隔离       | PostgreSQL + Prisma 持久化              |
| 向量存储 | `MemoryVectorStore`          | 进程退出即清空，需重新灌库 | pgvector 扩展，持久化检索               |
| 业务数据 | `workspace/*.json` 手写文件  | 无法动态新增，无权限控制   | 文件上传 + 数据库元数据                 |
| 用户体系 | 无                           | 所有人共享同一上下文       | 复用 RBAC 用户系统，JWT 鉴权            |
| 分析制品 | `reports/*.md` 本地文件      | 无法检索，无法关联用户     | 分析结果入库（Message），关联会话与用户 |



**归纳起来，核心差距集中在三类问题：**

- **数据不持久**：内存数据随进程消失，无法支撑长期运行
- **用户不隔离**：没有身份概念，所有请求共享同一上下文
- **文件不可管理**：本地文件没有元数据、没有权限、没有生命周期管理

本章围绕这三类问题展开，把第四章中已验证的能力升级为可持久、可隔离、可观测的工程实现。

------

## 5.2 系统架构总览

在编写 Schema 之前，需要先明确整条链路的总体结构。下面的架构图用于说明本章的系统边界、模块职责和数据流向，确保后续各节的实现能够汇聚为一条完整的生产级调用链。

![image.png](https://p3-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/26ce3134ac8f4cbd9b266ef5ede7b2e7~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=2752&h=1536&s=7067360&e=png&b=0e2139)

整条链路可以拆成四个关键环节：

1. **用户鉴权**：复用已有的 RBAC 用户系统，通过 JWT 识别当前用户
2. **文档管理**：上传 → 解析 → 分块 → 向量化 → 落库，建立用户私有的需求知识库
3. **会话对话**：创建会话 → 发送消息 → 加载历史 → 语义检索 → Multi-Agent 分析 → 结果持久化
4. **统一存储**：会话、消息、文档元数据和向量全部落在同一个 PostgreSQL 实例中

📌 **为什么选择 pgvector，而不是独立向量数据库？** 在教学项目和中小规模业务中，pgvector 的优势在于**不额外引入独立服务**。会话、消息、文档元数据和向量可以统一保存在 PostgreSQL 中，事务一致性更容易保证，部署与运维成本也更低。当数据规模增长到百万级以上，再评估 Qdrant、Milvus 等专用向量数据库会更合适。只要上层检索接口保持稳定，底层存储可以在后续阶段替换。

------

## 5.3 数据库设计：Prisma Schema 全貌

- 🤖 用 AI 生成本节代码（对应 5.3）

  将以下 Prompt 粘贴到 Claude CLI 中执行：

  ```bash
  在 services/chat 中完成数据库设计与初始化，严格按以下要求执行：
  
  前置：
  - 安装依赖：prisma @prisma/client @prisma/adapter-pg pg（Prisma 7）
  - 在 prisma.config.ts 中配置 datasource.url = process.env["DATABASE_URL"]（Prisma 7 不再在 schema 内写 url）
  
  1. Prisma Schema 设计（prisma/schema.prisma）：
     - 启用 pgvector：generator 加 previewFeatures = ["postgresqlExtensions"]，datasource 加 extensions = [vector]
     - 不建 User 表：用户系统由 user-system 微服务维护，userId 用裸 String 关联
     - conversations：id, userId, title, createdAt, updatedAt
     - messages：id, conversationId(关联 conversations, onDelete: Cascade), role(MessageRole), content, metadata(Json?), createdAt
     - documents：id, userId, filename, mimeType, size, filePath?, storageType(默认 local), status(默认 pending), chunkCount(默认 0), createdAt
     - document_chunks：id, documentId(关联 documents, onDelete: Cascade), content, chunkIndex, embedding(Unsupported("vector"))
     - task_events：id, userId, taskType, taskId, status(TaskStatus), message?, metadata?, createdAt, readAt?
     - 枚举：MessageRole { USER, ASSISTANT }、TaskStatus { pending, processing, done, error }
  
  2. Prisma Service：
     - 新建 services/chat/src/prisma/prisma.service.ts（用 @prisma/adapter-pg）
     - 新建 services/chat/src/prisma/prisma.module.ts（Global module）
  
  3. 迁移与验证：
     - 执行 bun run db:migrate
     - 执行 bun run db:generate
  ```

### 5.3.1 整体数据模型

本章的数据模型由五张核心表组成，关系结构如下：

![img.png](https://p3-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/68d2fa32c1734e3aadb91ec92563324f~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=2752&h=1536&s=6716772&e=png&b=142436)

每张表的设计意图：

- **conversations**：会话容器，绑定到具体用户（`userId`）。对应第四章的 `sessionId`，但现在有了持久化和归属关系。
- **messages**：会话中的每一条消息。`role` 用枚举区分 `USER` / `ASSISTANT` 两类，与 `DbChatHistory` 的 `HumanMessage` / `AIMessage` 映射对齐。
- **documents**：上传文件的元数据。`status` 字段跟踪处理进度（`pending` → `processing` → `done` / `error`）。
- **document_chunks**：文件被切分后的文本块，每个块都带有向量嵌入（`embedding` 字段），用于语义检索。
- **task_events**：异步任务事件（如向量化），既用于 SSE 实时推送，也作为可查询的任务历史。

### 5.3.2 Prisma Schema 定义

```java
// services/chat/prisma/schema.prisma

generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["postgresqlExtensions"]
}

datasource db {
  provider   = "postgresql"
  extensions = [vector]
}

// 用户表维护在 user-system 微服务中，这里 userId 用裸 String 关联（不建外键）。

model conversations {
  id        String     @id @default(cuid())
  userId    String
  title     String     @default("New Conversation")
  createdAt DateTime   @default(now())
  updatedAt DateTime   @updatedAt
  messages  messages[]

  @@index([userId])
}

model messages {
  id             String        @id @default(cuid())
  conversationId String
  role           MessageRole
  content        String
  metadata       Json?
  createdAt      DateTime      @default(now())
  conversations  conversations @relation(fields: [conversationId], references: [id], onDelete: Cascade)

  @@index([conversationId])
}

model documents {
  id              String            @id @default(cuid())
  userId          String
  filename        String
  mimeType        String
  size            Int
  filePath        String?
  storageType     String            @default("local")
  status          String            @default("pending")
  chunkCount      Int               @default(0)
  createdAt       DateTime          @default(now())
  document_chunks document_chunks[]

  @@index([userId])
}

model document_chunks {
  id         String                 @id @default(cuid())
  documentId String
  content    String
  chunkIndex Int
  embedding  Unsupported("vector")?
  documents  documents              @relation(fields: [documentId], references: [id], onDelete: Cascade)

  @@index([documentId])
}

model task_events {
  id        String     @id @default(cuid())
  userId    String     @db.VarChar(255)
  taskType  String     @db.VarChar(100)
  taskId    String     @db.VarChar(255)
  status    TaskStatus
  message   String?
  metadata  Json?
  createdAt DateTime   @default(now()) @db.Timestamptz(6)
  readAt    DateTime?  @db.Timestamptz(6)

  @@index([taskType])
  @@index([userId, createdAt])
}

enum MessageRole {
  USER
  ASSISTANT
}

enum TaskStatus {
  pending
  processing
  done
  error
}
```

⚠️ **关于 `vector` 维度**这里 `embedding` 用 `Unsupported("vector")` 不限定维度，实际写入的是第四章 `Xenova/paraphrase-multilingual-MiniLM-L12-v2` 模型输出的 **384 维**向量。如果后续切换到 OpenAI `text-embedding-3-small`（1536 维），无需改 schema，只需保证写入维度一致即可（也可显式 `vector(384)` 加约束）。

### 5.3.3 关键设计决策说明

**为什么 messages 使用 `onDelete: Cascade`？**

会话被删除时，其下消息应同步清除，避免留下没有归属的孤儿数据。同理，`document_chunks` 也应随着 `documents` 删除而级联清理。

**为什么 documents 的 status 用字符串而不是枚举？**

文档处理状态变更较频繁、取值可能随业务扩展（如新增 `archived`），字符串更灵活；而 `messages.role`、`task_events.status` 取值稳定，用枚举获得更强的类型约束。

**为什么 embedding 字段标记为可选（`?`）？**

因为文档分块和向量化是异步的两步操作。Chunk 创建时可能还没有完成向量化，所以 embedding 允许为空，检索时再用 `embedding IS NOT NULL` 过滤。

### 5.3.4 PrismaService（全局模块）

Prisma 7 使用驱动适配器连接数据库（`@prisma/adapter-pg`），连接串放在 `prisma.config.ts` 与 `PrismaClient` 构造里：

```tsx
// services/chat/src/prisma/prisma.service.ts
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
    super({ adapter });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
// services/chat/src/prisma/prisma.module.ts
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
```

**🧪 验证步骤（对应 5.3）**

```bash
cd services/chat
# 确保 PostgreSQL 已启动，且 .env 中配置了 DATABASE_URL
bun run db:migrate
bun run db:generate

# 验证表结构
bun run db:studio
```

**验收标准**：Prisma Studio 能打开，五张表结构正确显示；`document_chunks` 表包含 `embedding` 列（类型 `vector`）。

![img](https://p3-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/a2c2d2b3f2eb4daf9ccfb59188ea1656~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=2410&h=1264&s=137336&e=png&b=141417)

------

## 5.4 会话持久化：从 InMemoryHistory 到 PostgreSQL

- 🤖 用 AI 生成本节代码（对应 5.4）

  将以下 Prompt 粘贴到 Claude CLI 中执行：

  ```scss
  在 services/chat 的 LangChain 层中，用 PostgreSQL 替换 InMemoryChatMessageHistory，严格按以下要求执行：
  
  1. 会话服务（services/chat/src/conversation/conversation.service.ts）：
     - create(userId, title?) / findByUser(userId) / findById(conversationId, userId)（含权限校验）/ delete(conversationId, userId)
  
  2. 消息服务（services/chat/src/message/message.service.ts）：
     - addMessage(conversationId, role, content, metadata?)
     - getHistory(conversationId, limit?)
     - getHistoryAsLangChainMessages(conversationId)：转换为 LangChain BaseMessage 数组
  
  3. 自定义 ChatMessageHistory（services/chat/src/message/db-chat-history.ts）：
     - 继承 BaseListChatMessageHistory，内部调用 MessageService 读写 messages 表
     - 与 RunnableWithMessageHistory 兼容
  
  4. 新增路由（@Controller('api/conversations')，全部经 JwtAuthGuard）：
     - POST /：创建会话
     - GET /：当前用户会话列表
     - GET /:id/messages：会话消息历史
     - POST /:id/chat：在指定会话中发送消息
     - DELETE /:id：删除会话
  ```

第四章的 `RunnableMemoryService` 通过 `Map<string, InMemoryChatMessageHistory>` 保存会话历史，进程重启后数据会全部丢失。本节将这部分内存结构替换为 PostgreSQL 持久化存储。

### 5.4.1 从内存到数据库：变化了什么，不变的是什么

变化的是存储层：

- `Map<string, InMemoryChatMessageHistory>` → Prisma 操作 `conversations` + `messages` 表
- `sessionId` → `conversationId`（有了真实的数据库主键）
- 匿名会话 → 用户绑定会话（通过 `userId` 关联）

不变的是调用方式：`getMessages()` 仍返回 `BaseMessage[]`，`addMessage()` 仍接受 `BaseMessage`，`RunnableWithMessageHistory` 的使用方式完全不变。这正是第四章中“上层不依赖具体实现”的工程价值。

### 5.4.2 自定义 DbChatHistory

LangChain 的 `BaseListChatMessageHistory` 要求实现 `getMessages()` 和 `addMessage()`。我们只需把底层实现从内存换成 Prisma。注意 role 映射：`HumanMessage → USER`，其余（`AIMessage` 等）→ `ASSISTANT`。

```tsx
// services/chat/src/message/db-chat-history.ts
import { BaseListChatMessageHistory } from '@langchain/core/chat_history';
import { BaseMessage, HumanMessage } from '@langchain/core/messages';
import { MessageService } from './message.service';
import { MessageRole } from '@prisma/client';

export class DbChatHistory extends BaseListChatMessageHistory {
  lc_namespace = ['chat', 'db'];

  constructor(
    private readonly conversationId: string,
    private readonly messageService: MessageService,
  ) {
    super();
  }

  async getMessages(): Promise<BaseMessage[]> {
    return this.messageService.getHistoryAsLangChainMessages(this.conversationId);
  }

  async addMessage(message: BaseMessage): Promise<void> {
    const role =
      message instanceof HumanMessage ? MessageRole.USER : MessageRole.ASSISTANT;
    await this.messageService.addMessage(
      this.conversationId,
      role,
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    );
  }

  async addMessages(messages: BaseMessage[]): Promise<void> {
    for (const m of messages) await this.addMessage(m);
  }

  async clear(): Promise<void> {
    await this.messageService.clearHistory(this.conversationId);
  }
}
```

对应的 `MessageService` 负责读写 `messages` 表，并提供 LangChain 消息转换：

```tsx
// services/chat/src/message/message.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MessageRole, Prisma } from '@prisma/client';
import { BaseMessage, HumanMessage, AIMessage } from '@langchain/core/messages';

@Injectable()
export class MessageService {
  constructor(private readonly prisma: PrismaService) {}

  async addMessage(conversationId: string, role: MessageRole, content: string, metadata?: Record<string, unknown>) {
    return this.prisma.messages.create({
      data: { conversationId, role, content, metadata: metadata as Prisma.InputJsonValue },
    });
  }

  async getHistory(conversationId: string, limit?: number) {
    return this.prisma.messages.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      ...(limit ? { take: limit } : {}),
    });
  }

  async getHistoryAsLangChainMessages(conversationId: string): Promise<BaseMessage[]> {
    const messages = await this.getHistory(conversationId);
    return messages.map((m) =>
      m.role === MessageRole.USER ? new HumanMessage(m.content) : new AIMessage(m.content),
    );
  }

  async clearHistory(conversationId: string) {
    await this.prisma.messages.deleteMany({ where: { conversationId } });
  }
}
```

### 5.4.3 会话服务：CRUD + 用户隔离

```tsx
// services/chat/src/conversation/conversation.service.ts
import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ConversationService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, title?: string) {
    return this.prisma.conversations.create({
      data: { userId, title: title ?? 'New Conversation' },
    });
  }

  async findByUser(userId: string) {
    return this.prisma.conversations.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async findById(conversationId: string, userId: string) {
    const conv = await this.prisma.conversations.findUnique({ where: { id: conversationId } });
    if (!conv) throw new NotFoundException('会话不存在');
    if (conv.userId !== userId) throw new ForbiddenException('无权访问该会话');
    return conv;
  }

  async delete(conversationId: string, userId: string) {
    await this.findById(conversationId, userId);
    await this.prisma.conversations.delete({ where: { id: conversationId } });
  }
}
```

JWT 鉴权由 `JwtAuthGuard` + `JwtStrategy` 完成，从 `Authorization: Bearer` / Cookie / query `token` 三种来源取令牌，校验后把 `userId` 注入 `req.user`（与 user-system 共用同一 `JWT_SECRET`）。

**🧪 验证步骤（对应 5.4）**

```bash
# 创建会话
curl -X POST http://localhost:4001/api/conversations \
  -H "Authorization: Bearer$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "需求分析测试"}'

# 在会话中发送消息（RAG + 多 Agent，见 5.9）
curl -X POST http://localhost:4001/api/conversations/$CONV_ID/chat \
  -H "Authorization: Bearer$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"input": "我们要做一个面向需求分析师的会话记忆系统"}'

# 重启服务后，验证历史不丢失
bun run dev:chat
curl http://localhost:4001/api/conversations/$CONV_ID/messages \
  -H "Authorization: Bearer$TOKEN"
```

**验收标准**：重启服务后，`GET /:id/messages` 仍能返回之前的完整对话历史；不同用户无法访问对方的会话（403）。

![img.png](https://p6-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/3a02f3d89c8d46ffb761ae97ad734a6a~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=2688&h=1786&s=273044&e=png&b=070808)配图仅为示例参考，具体内容以文章说明及实际代码为准。

------

## 5.5 文件上传与存储

- 🤖 用 AI 生成本节代码（对应 5.5）

  将以下 Prompt 粘贴到 Claude CLI 中执行：

  ```bash
  在 services/chat 中实现文件上传功能，严格按以下要求执行：
  
  1. 安装依赖：@nestjs/platform-express、multer、@types/multer
  
  2. 文件上传服务（services/chat/src/document/document.service.ts）：
     - upload(userId, file, filename)：保存到 uploads/{userId}/{timestamp}-{name}，元数据写入 documents 表（status: pending）
     - findByUser(userId) / findById(documentId, userId)（权限校验）/ delete(documentId, userId)（含物理文件）
     - 允许类型：text/plain, text/markdown, text/x-markdown, application/pdf, docx/msword
     - 文件大小限制：10MB
  
  3. 新增路由（@Controller('api/documents')，经 JwtAuthGuard）：
     - POST /upload（multipart/form-data，内存存储 + fileFilter）
     - POST /:id/process：触发解析+分块+向量化（异步，返回 202）
     - GET / : 文档列表；GET /:id：详情；DELETE /:id
  ```

第四章中的“文件”是预先放在 `workspace/` 目录下的静态样例，既无法由用户动态新增，也没有明确的归属关系。本节实现真实的文件上传能力：用户上传自己的需求文档，系统负责保存文件、记录元数据，并为后续解析与向量化做准备。

### 5.5.1 文件上传服务

```tsx
// services/chat/src/document/document.service.ts（节选）
async upload(userId: string, file: Express.Multer.File, filename: string) {
  if (!file) throw new BadRequestException('未上传文件');
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    throw new BadRequestException(`不支持的文件类型：${file.mimetype}`);
  }

  const dir = path.join('uploads', userId);
  fs.mkdirSync(dir, { recursive: true });

  const savedName = `${Date.now()}-${filename}`;
  const filePath = path.join(dir, savedName);
  fs.writeFileSync(filePath, file.buffer);

  return this.prisma.documents.create({
    data: { userId, filename, mimeType: file.mimetype, size: file.size, storageType: 'local', filePath },
  });
}
```

### 5.5.2 上传路由

控制器用 `FileInterceptor` + `memoryStorage()`，并在 `fileFilter` 里拦截非法类型、`limits` 限制 10MB。`POST /:id/process` 异步触发处理并立即返回 **202**：

```tsx
// services/chat/src/document/document.controller.ts（节选）
@Post(':id/process')
@HttpCode(HttpStatus.ACCEPTED)
async process(@Req() req: Request, @Param('id') id: string) {
  const userId = (req.user as any).userId;
  await this.documentService.findById(id, userId);
  this.chunkService.processDocument(id, userId).catch((err) => {
    console.error(`[DocumentProcess] documentId=${id} failed:`, err);
  });
  return { message: '处理已开始', documentId: id };
}
```

**🧪 验证步骤（对应 5.5）**

```bash
# 上传需求规范文档
curl -X POST http://localhost:4001/api/documents/upload \
  -H "Authorization: Bearer$TOKEN" \
  -F "file=@requirement-spec.md;type=text/markdown" -F "filename=requirement-spec.md"

# 获取文档列表
curl http://localhost:4001/api/documents -H "Authorization: Bearer$TOKEN"
```

**验收标准**：上传成功返回 document 记录，`status` 为 `pending`；`uploads/{userId}/` 下能找到对应文件；文档列表接口返回用户已上传的文件。

![img](https://p6-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/ffb5117b31b84bebabf8b4857721c698~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=910&h=262&s=38923&e=png&b=1c1c1c)

![img](https://p1-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/9abd3cc3649f440ea4f6d5ae56952ab6~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=2706&h=856&s=108796&e=png&b=050606)配图仅为示例参考，具体内容以文章说明及实际代码为准。

------

## 5.6 文件解析与分块策略

- 🤖 用 AI 生成本节代码（对应 5.6）

  将以下 Prompt 粘贴到 Claude CLI 中执行：

  ```markdown
  在 services/chat 中实现文件解析与分块，严格按以下要求执行：
  
  1. 安装依赖：@langchain/textsplitters、pdf-parse、mammoth
  
  2. 文件解析器（services/chat/src/document/parsers/）：
     - text.parser.ts（TXT/MD）、pdf.parser.ts（PDF）、docx.parser.ts（DOCX）
     - parser.factory.ts：extractText(filePath, mimeType) 按 MIME 路由
  
  3. 分块 + 向量化（services/chat/src/document/chunk.service.ts）：
     - RecursiveCharacterTextSplitter（chunkSize: 500, chunkOverlap: 50）
     - processDocument(documentId, userId)：解析 → 分块 → 向量化 → 落库 → 更新 status/chunkCount
  ```

文件上传完成后，系统获得的仍只是静态文件。要让后续检索能够基于语义工作，需要先将文件解析为文本，并切分为适合向量化的文本块。

### 5.6.1 文件解析器

![image.png](https://p6-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/ee51d573625d40608e4033022580dca1~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=2684&h=140&s=115704&e=png&b=eeecfe)

不同文件类型采用不同解析方式，由工厂按 MIME 路由：

```tsx
// services/chat/src/document/parsers/parser.factory.ts
import { parseText } from './text.parser';
import { parsePdf } from './pdf.parser';
import { parseDocx } from './docx.parser';

export async function extractText(filePath: string, mimeType: string): Promise<string> {
  switch (mimeType) {
    case 'application/pdf':
      return parsePdf(filePath);
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/msword':
      return parseDocx(filePath);
    case 'text/plain':
    case 'text/markdown':
    case 'text/x-markdown':
      return parseText(filePath);
    default:
      return parseText(filePath);
  }
}
```

### 5.6.2 分块 + 落库

`chunkDocument` 在仓库里与向量化合并成一个 `processDocument`（见 5.7），核心分块逻辑：

```tsx
const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 500, chunkOverlap: 50 });
const text = await extractText(doc.filePath, doc.mimeType);
const chunks = await splitter.splitText(text);
// 先清空旧分块，再逐条写入 document_chunks
await this.prisma.document_chunks.deleteMany({ where: { documentId } });
```

📌 **分块参数的选择**

- `chunkSize: 500`：每个块约 500 字符，适合中文短文档场景
- `chunkOverlap: 50`：相邻块有 50 字符重叠，避免语义在切分边界处断裂

------

## 5.7 向量化落库：从 MemoryVectorStore 到 pgvector

- 🤖 用 AI 生成本节代码（对应 5.7）

  将以下 Prompt 粘贴到 Claude CLI 中执行：

  ```bash
  在 services/chat 中实现向量化落库，严格按以下要求执行：
  
  1. 向量化服务（services/chat/src/document/embedding.service.ts）：
     - 复用第四章 @xenova/transformers（Xenova/paraphrase-multilingual-MiniLM-L12-v2）
     - embedTexts(texts)：mean pooling + L2 单位化，返回 384 维向量
  
  2. 完整 Pipeline（chunk.service.ts 的 processDocument）：
     - 解析 → 分块 → embedTexts → 用 raw SQL 写入 document_chunks.embedding（vector）
     - 更新 documents.status 与 chunkCount
  
  3. 语义检索（services/chat/src/document/search.service.ts）：
     - similaritySearch(query, userId, topK)：query 向量化 → pgvector <=> 余弦距离
     - JOIN documents 过滤 userId（用户隔离）→ 返回 topK（content + score）
  
  4. 新增路由：POST /api/search（@Controller('api/search')，经 JwtAuthGuard）
  ```

分块完成后，每个 chunk 仍只是普通文本。本节在此基础上生成向量，并用 pgvector 替换第四章中的 `MemoryVectorStore`，使向量数据能够持久化保存和检索。

### 5.7.1 向量化服务

向量生成沿用第四章：`@xenova/transformers` 本地 pipeline，mean pooling + L2 单位化，输出 384 维。

```tsx
// services/chat/src/document/embedding.service.ts（节选）
async embedTexts(texts: string[]): Promise<number[][]> {
  const embedder = await this.getEmbedder();
  const cleanTexts = texts.map((t) => t.replace(/\n/g, ' '));
  const rawOutput = (await embedder(cleanTexts)) as any;
  const inputs = embedder.tokenizer(cleanTexts, { padding: true, truncation: true });
  const pooled = mean_pooling(rawOutput, inputs.attention_mask);
  return pooled.normalize(2, -1).tolist(); // 384 维
}
```

### 5.7.2 完整的文档处理 Pipeline

`processDocument` 把解析、分块、向量化、落库串成一条链，并在关键节点推送 SSE（见 5.8）。Prisma 不原生写 `vector` 类型，用 raw SQL 写入：

```tsx
// services/chat/src/document/chunk.service.ts（节选）
const text = await extractText(doc.filePath, doc.mimeType);
const chunks = await this.splitter.splitText(text);
await this.prisma.document_chunks.deleteMany({ where: { documentId } });

const vectors = await this.embedding.embedTexts(chunks);
for (let i = 0; i < chunks.length; i++) {
  const created = await this.prisma.document_chunks.create({
    data: { documentId, content: chunks[i], chunkIndex: i },
  });
  const vector = `[${vectors[i].join(',')}]`;
  await this.prisma.$executeRaw`
    UPDATE document_chunks SET embedding = ${vector}::vector WHERE id = ${created.id}
  `;
}

await this.prisma.documents.update({
  where: { id: documentId },
  data: { status: 'done', chunkCount: chunks.length },
});
```

### 5.7.3 语义检索服务（带用户隔离）

这是与第四章最关键的差异之一：检索结果不再是全局的，而是只返回当前用户自己上传的文档（`JOIN documents ... WHERE d."userId" = ...`）。

```tsx
// services/chat/src/document/search.service.ts（节选）
async similaritySearch(query: string, userId: string, topK = 5): Promise<SearchResult[]> {
  const [vector] = await this.embedding.embedTexts([query]);
  if (!vector || vector.length === 0) throw new Error('EmbeddingService returned no vector for query');

  // vector 字面量内联为 SQL（无法用 $1::vector 绑定参数）；userId/topK 仍是参数化的，安全。
  const vecRaw = Prisma.raw(`'[${vector.join(',')}]'::vector`);

  const rows = await this.prisma.$queryRaw<Array<{
    chunk_id: string; document_id: string; content: string; score: string | number; chunk_index: number;
  }>>`
    SELECT dc.id AS chunk_id, dc."documentId" AS document_id, dc.content AS content,
           dc."chunkIndex" AS chunk_index, 1 - (dc.embedding <=> ${vecRaw}) AS score
    FROM document_chunks dc
    JOIN documents d ON d.id = dc."documentId"
    WHERE d."userId" = ${userId} AND dc.embedding IS NOT NULL
    ORDER BY dc.embedding <=> ${vecRaw}
    LIMIT ${topK}
  `;

  return rows.map((r) => ({
    chunkId: r.chunk_id, documentId: r.document_id, content: r.content,
    score: Number(r.score), chunkIndex: r.chunk_index,
  }));
}
```

⚠️ **关于 `<=>` 运算符** 这是 pgvector 提供的余弦距离运算符，值越小越相似。我们用 `1 - distance` 转换为相似度分数（值越大越相似）。pgvector 还支持 `<->`（L2 距离）和 `<#>`（内积）。

**🧪 验证步骤（对应 5.7）**

```bash
# 触发完整处理流程（解析 + 分块 + 向量化），异步返回 202
curl -X POST http://localhost:4001/api/documents/$DOC_ID/process \
  -H "Authorization: Bearer$TOKEN"

# 语义检索（只命中当前用户文档）
curl -X POST http://localhost:4001/api/search \
  -H "Authorization: Bearer$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "怎样判断一个需求是否完整", "topK": 3}'
```

**验收标准**：处理完成后 `document_chunks.embedding` 不再为 NULL，`documents.status` 变为 `done`；语义检索返回与查询语义相关的需求文档片段，且只包含当前用户的文档。

![img](https://p9-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/f06d681ee16e4da3a0a00315845523fc~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=2238&h=1594&s=510714&e=png&b=fefefe)配图仅为示例参考，具体内容以文章说明及实际代码为准。

------

## 5.8 异步任务通知：SSE 推送机制

- 🤖 用 AI 生成本节代码（对应 5.8）

  将以下 Prompt 粘贴到 Claude CLI 中执行：

  ```scss
  在 services/chat 中实现 SSE 任务推送机制，严格按以下要求执行：
  
  1. SseService（services/chat/src/sse/sse.service.ts）：
     - 维护 Map<userId, Set<Response>>（一个用户多 Tab 共用）
     - addConnection(userId, res) / removeConnection(userId, res)
     - emit(userId, event)：先持久化到 task_events 表，再实时推送给在线连接
     - 用 @nestjs/schedule 定期清理离线 entry 与 30 天前的 task_events
  
  2. SseController（@Controller('api/sse')，经 JwtAuthGuard）：
     - GET /tasks：text/event-stream，注册连接 + 心跳，断开时清理
  
  3. TaskEventController（@Controller('api/tasks')）：
     - GET /history：分页查询任务历史；GET /:taskId；PATCH /:taskId/read
  
  4. ChunkService.processDocument 在开始/完成/失败时 emit 对应状态事件
  ```

完成 5.7 后，文档处理 Pipeline 已经具备完整能力。但向量化任务耗时不可固定：`POST /api/documents/:id/process` 会立即返回 **202 Accepted**，实际解析、分块和向量化在后台执行。前端需要一种机制感知任务进度、完成状态和失败原因，因此需要引入**实时通知机制**。

### 5.8.1 为什么选 SSE 而不是 WebSocket

| **维度** | **SSE**                 | **WebSocket**        |
| -------- | ----------------------- | -------------------- |
| 通信方向 | 服务端 → 客户端（单向） | 双向                 |
| 协议     | 标准 HTTP，自动重连     | 独立协议，需手动重连 |
| 复杂度   | 低                      | 高，需额外网关配置   |
| 适用场景 | 任务进度、状态通知      | 聊天、实时协作       |



本章的场景主要是服务端向客户端推送任务状态，属于典型的单向通知，因此 SSE 已能满足需求。

### 5.8.2 SseService：连接管理 + 事件持久化

仓库实现采用直接持有 Express `Response` 的连接管理方式（一个用户一个 `Set<Response>`，多 Tab 共用），`emit` 时**先写库再推送**：

```tsx
// services/chat/src/sse/sse.service.ts（节选）
async emit(userId: string, event: TaskEventPayload): Promise<void> {
  // 1. 持久化到 task_events（失败不影响实时推送）
  try {
    await this.prisma.task_events.create({
      data: {
        id: event.id, userId, taskType: event.taskType, taskId: event.taskId,
        status: event.status, message: event.message ?? undefined,
        metadata: (event.metadata as any) ?? undefined, createdAt: new Date(event.createdAt),
      },
    });
  } catch (err) {
    console.error('[SseService] failed to persist task event:', err);
  }

  // 2. 实时推送给该用户所有在线 Tab
  const set = this.connections.get(userId);
  if (set) {
    const payload = JSON.stringify(event);
    for (const res of set) res.write(`event: task\ndata: ${payload}\n\n`);
  }
}
```

配合 `@nestjs/schedule`：`@Interval` 定期清理离线 entry，`@Cron` 每天清理 30 天前的 `task_events`（需要在 `AppModule` 中 `ScheduleModule.forRoot()`）。

### 5.8.3 SseController：SSE 端点

```tsx
// services/chat/src/sse/sse.controller.ts（节选）
@Get('tasks')
streamTasks(@Req() req: Request, @Res() res: Response) {
  const userId = (req.user as any).userId;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write(`event: connected\ndata: ${JSON.stringify({ userId })}\n\n`);

  this.sseService.addConnection(userId, res);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 30000);
  req.on('close', () => {
    clearInterval(heartbeat);
    this.sseService.removeConnection(userId, res);
  });
}
```

### 5.8.4 接入 ChunkService

`processDocument` 在开始/完成/失败时 emit 事件（`taskType: 'document_vectorize'`，状态 `processing` / `done` / `error`），前端据此更新进度。由于事件已落库，离线期间产生的事件也能通过 `GET /api/tasks/history` 补查。

📌 **关于单实例的局限性** `SseService` 用内存 Map 维护连接，只在单进程内有效。多实例部署时，可把推送层换成 Redis Pub/Sub，让任意实例都能推送到正确的连接。事件本身已落库，历史不受影响。

**🧪 验证步骤（对应 5.8）**

```bash
# 终端 1：建立 SSE 连接（保持打开）
curl -N -H "Authorization: Bearer$TOKEN" http://localhost:4001/api/sse/tasks

# 终端 2：触发文档处理
curl -X POST http://localhost:4001/api/documents/$DOC_ID/process \
  -H "Authorization: Bearer$TOKEN"

# 查询任务历史
curl "http://localhost:4001/api/tasks/history" -H "Authorization: Bearer$TOKEN"
```

**验收标准**：终端 1 先收到 `status: processing`，处理结束后收到 `status: done`（含 `chunkCount`）；失败则收到 `status: error`；`task_events` 表中能查到这些事件。

![img](https://p6-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/27241cd19a0a423498c98be5b3c053d1~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=2944&h=1696&s=190333&e=png&b=040505)配图仅为示例参考，具体内容以文章说明及实际代码为准。

------

## 5.9 完整调用链路：从登录到智能分析

- 🤖 用 AI 生成本节代码（对应 5.9）

  将以下 Prompt 粘贴到 Claude CLI 中执行：

  ```markdown
  把前面所有能力整合为统一的分析入口，严格按以下要求执行：
  
  1. 统一分析服务（services/chat/src/llm/advanced-analysis.service.ts）：
     - analyze(userId, conversationId, input)：
       1. DbChatHistory 读取会话历史
       2. SearchService 语义检索当前用户文档（topK=3）
       3. 拼接历史 + 检索上下文 + 当前输入
       4. OrchestratorService.orchestrate(input, retrievedContext) 执行多 Agent 分析
       5. 把用户输入与分析结论写入 messages 表
       6. 返回 report、usedAgents、retrievedDocuments
  
  2. POST /api/conversations/:id/chat 接入该服务（非流式 JSON，第六章再升级流式 UI）
  ```

到这里，数据库、会话、文档、向量检索与任务通知都已经具备独立能力。最后一步，是将这些模块串联为一条端到端的需求分析链路。

### 5.9.1 调用链路全貌

用户JWT GuardConversationControllerDbChatHistorySearchServiceOrchestratorServicePostgreSQLPOST /conversations/:id/chat（Bearer Token）userId + conversationId + input读取会话历史SELECT messages语义检索（query=input, userId）pgvector 余弦距离查询相关文档片段历史 + 检索上下文 + 当前输入Multi-Agent（抽取→澄清→分析+风控→汇总）分析报告写入 USER + ASSISTANT message返回报告 + 引用文档用户JWT GuardConversationControllerDbChatHistorySearchServiceOrchestratorServicePostgreSQL

![image.png](https://p3-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/143d191c5424437ab3f8225d88f5d8fa~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=3781&h=1618&s=289279&e=png&b=020817)

### 5.9.2 统一分析服务（整合版）

```tsx
// services/chat/src/llm/advanced-analysis.service.ts（节选）
async analyze(userId: string, conversationId: string, input: string) {
  const history = new DbChatHistory(conversationId, this.messageService);
  const messages = await history.getMessages();

  let retrievedDocs: Awaited<ReturnType<SearchService['similaritySearch']>> = [];
  try {
    retrievedDocs = await this.searchService.similaritySearch(input, userId, 3);
  } catch {
    // 无文档或检索失败时，继续无文档上下文分析
  }

  const retrievedContext = retrievedDocs.length > 0
    ? retrievedDocs.map((d, i) => `[文档片段 ${i + 1}]（相关度：${d.score.toFixed(3)}）\n${d.content}`).join('\n\n')
    : '无相关参考文档';

  const enrichedInput = [
    messages.length ? `历史对话：\n${messages.map((m) => `${m.getType()}: ${m.content}`).join('\n')}` : '',
    `当前输入：${input}`,
  ].filter(Boolean).join('\n\n');

  const result = await this.orchestrator.orchestrate(enrichedInput, retrievedContext);

  await this.messageService.addMessage(conversationId, MessageRole.USER, input);
  if (result.status !== 'need_clarification') {
    await this.messageService.addMessage(conversationId, MessageRole.ASSISTANT, result.report ?? '分析未完成',
      { usedAgents: result.usedAgents, retrievedDocuments: retrievedDocs.length });
  }

  return {
    ...result,
    retrievedDocuments: retrievedDocs.map((d) => ({ documentId: d.documentId, content: d.content.slice(0, 200), score: d.score })),
  };
}
```

检索到的文档片段会作为 `retrievedContext` 注入第四章 `summaryAgent` 预留的 `{retrievedContext}` 变量。第四章中该位置仍是占位符，本章开始传入真实召回结果。

### 5.9.3 与第四章的关键差异对照

| **环节**   | **第四章（Mock）**                       | **第五章（生产）**                        |
| ---------- | ---------------------------------------- | ----------------------------------------- |
| 会话历史   | `InMemoryChatMessageHistory`（内存 Map） | `DbChatHistory` + PostgreSQL 持久化       |
| 文档检索   | 手动灌库到 MemoryVectorStore             | 用户上传 → 自动向量化 → pgvector 语义检索 |
| 用户隔离   | 无，全局共享                             | JWT 鉴权 + userId 过滤                    |
| 结果持久化 | `writeReport('reports/...')` 本地文件    | messages 表（关联会话与用户）             |
| 重启后状态 | 全部丢失                                 | 完整保留                                  |



**🧪 验证步骤（对应 5.9 · 完整链路）**

```bash
# Step 1: 登录获取 Token（user-system，端口 4002）
curl -X POST http://localhost:4002/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"Admin@123456"}'

# Step 2: 上传需求规范文档
curl -X POST http://localhost:4001/api/documents/upload \
  -H "Authorization: Bearer$TOKEN" \
  -F "file=@requirement-spec.md;type=text/markdown" -F "filename=requirement-spec.md"

# Step 3: 处理文档（解析 + 分块 + 向量化）
curl -X POST http://localhost:4001/api/documents/$DOC_ID/process \
  -H "Authorization: Bearer$TOKEN"

# Step 4: 创建会话
curl -X POST http://localhost:4001/api/conversations \
  -H "Authorization: Bearer$TOKEN" -H "Content-Type: application/json" \
  -d '{"title": "需求分析"}'

# Step 5: 发起分析（带知识库上下文）
curl -X POST http://localhost:4001/api/conversations/$CONV_ID/chat \
  -H "Authorization: Bearer$TOKEN" -H "Content-Type: application/json" \
  -d '{"input": "帮我判断这个需求是否完整，并产出一份需求分析报告：开发一个面向需求分析师的会话记忆系统"}'

# Step 6: 重启服务后验证历史保留
bun run dev:chat
curl http://localhost:4001/api/conversations/$CONV_ID/messages \
  -H "Authorization: Bearer$TOKEN"
```

**最终验收标准：**

- ✅ 分析结果包含 `retrievedDocuments`，引用了上传的需求规范文档
- ✅ `usedAgents` 包含全部 5 个 Agent（信息充分时）
- ✅ 重启服务后，会话历史完整保留
- ✅ 不同用户之间的会话和文档完全隔离
- ✅ 未登录用户（无 Token）返回 401

![img](https://p1-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/fdd63e3782a24d62bc35e153f567c419~tplv-k3u1fbpfcp-jj-mark:1890:0:0:0:q75.awebp#?w=1554&h=820&s=85287&e=png&b=050606)

📎 **说明**示例项目以需求分析作为入口，本章起后续内容都以需求分析为主线。第六章会在本章 schema 之上叠加 artifacts（产物）与 UI 协议，并把这条非流式 `chat` 升级为流式输出。

------

## 5.10 本章小结

本章围绕 **从 Mock 到生产** 这一主线，对第四章的核心能力完成了工程化升级：

- **数据库设计（5.3）**：用 Prisma 7 + PostgreSQL 建立了 conversations、messages、documents、document_chunks、task_events 五张核心表（User 由 user-system 微服务维护），pgvector 扩展为向量存储提供原生支持。
- **会话持久化（5.4）**：用自定义的 `DbChatHistory` 替换 `InMemoryChatMessageHistory`，会话历史不再随进程消失，且按用户完全隔离。
- **文件上传（5.5）**：实现真实的文件上传接口，支持 PDF/TXT/MD/DOCX，元数据入库，文件按用户目录隔离存储。
- **文件解析与分块（5.6）**：建立从原始文件到可向量化文本块的 Pipeline，用 `RecursiveCharacterTextSplitter` 控制块大小和重叠。
- **向量化落库（5.7）**：用 pgvector 替换 `MemoryVectorStore`，向量持久化到数据库，语义检索结果按用户隔离。
- **异步任务通知（5.8）**：引入 SSE 推送机制，实时通知向量化任务进度，并把任务事件持久化到 `task_events`。
- **完整调用链路（5.9）**：把登录、会话、文档、检索、Multi-Agent 分析串成一条端到端的生产级链路。

➡️ **后续章节预告** 数据已经落库，文件可以上传和检索，会话也完成了用户级隔离。但当前交互仍以 curl 命令行为主，缺少面向用户的界面、实时反馈和结构化展示。下一章将进一步讨论前后端协议设计、流式响应、结构化 UI 渲染，以及如何把 AI 分析结果转化为更适合产品使用的交互体验。