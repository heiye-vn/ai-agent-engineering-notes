# AI Agent Playground (智能体工程实战演练场)

> 本仓库用于系统化探索与实践 **AI Agent（人工智能体）** 的核心工程架构与演进路径。从底层的模型调用、受约束结构化输出，逐步演进到工具调用 (Tool Calling)、任务编排 (Orchestration)、检索增强生成 (RAG) 以及多智能体协同 (Multi-Agent System)。

---

## 仓库定位与关联

本仓库是「能力探索的演练场」，与产品工程「[autix](https://github.com/heiye-vn/autix)」分工明确：

| 仓库 | 定位 | 形态 | 依赖方式 |
|------|------|------|---------|
| **ai-agent-playground** | 练习场 | 平铺的独立小项目（chapter01/02/...），各自 `pnpm install` 独立运行 | 无 |
| **autix** | 产品工程 | pnpm workspace monorepo（clients / services / packages） | 独立 git 仓库 ([heiye-vn/autix](https://github.com/heiye-vn/autix)) |

规则：**「怎么把某个 Agent 能力跑通」的探索放 playground；「能力如何落地为可持续演进的产品骨架」放 autix。** 详见 [chapter02/note.md](./chapter02/note.md)。

## 章节内容 (Chapters)

### [Chapter 01: 把模型变成能力](./chapter01/)

- **描述**：聚焦大模型从“自由对话”到“工程能力”的转化。核心围绕五层受约束调用架构（system/task/context/format/post-process），实现严格的 JSON 结构化输出、TypeScript 运行时类型守卫（Type Guard）与容错重试闭环机制，将不确定的模型响应收束为稳定、可消费、可复用的软件模块。

### Chapter 02: 工程底座（独立仓库 → [heiye-vn/autix](https://github.com/heiye-vn/autix)）

- **描述**：用 pnpm workspaces + Turbo 搭建可扩展的 monorepo（clients / services / packages），跑通 Web ↔ Chat 服务 ↔ 共享包 ↔ Compose 的最小闭环。因其属于「产品工程」而非「能力练习」，已独立为专有开源项目仓库 [heiye-vn/autix](https://github.com/heiye-vn/autix) 持续演进，本目录保留完整设计笔记与落地思考 [note.md](./chapter02/note.md)。

### Chapter 03: 上下文与记忆机制 (Memory & Context)

- **描述**：探索短期对话窗口管理、长期向量检索记忆与上下文压缩摘要策略。

### Chapter 04: 智能体规划与反思 (Planning & Reflection)

- **描述**：探索 ReAct 范式、Plan-and-Solve、自我反思纠错与状态机流程控制。

### Chapter 05: 多智能体协同 (Multi-Agent Workflows)

- **描述**：探索角色分工、Agent Handoff、层级协作网络与多 Agent 冲突消解机制。

---

## 技术栈与基础设施

- **运行时环境**：Node.js >= 18
- **包管理工具**：[pnpm](https://pnpm.io/)
- **开发语言**：TypeScript + [tsx](https://github.com/privatenumber/tsx) (原生免编译即时执行)
- **模型接入**：[OpenAI SDK](https://github.com/openai/openai-node)（兼容阿里百炼 DashScope、OpenAI 及三方中转网关）

---

## 快速开始

### 1. 克隆与安装依赖

进入对应章节目录（例如 `chapter01`）安装依赖：

```bash
cd chapter01
pnpm install
```

### 2. 环境变量配置

复制环境变量示例文件并配置您的 API Key：

```bash
cp .env.example .env
```

编辑 `.env` 文件，填入模型服务凭证：

```env
# 阿里百炼模型配置
BAILIAN_API_KEY=sk-xxxxxx
BAILIAN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
```

### 3. 运行演练

以第一章为例，运行入口脚本测试需求分析智能体：

```bash
pnpm dev
```

---

## 工程规范与安全守则

1. **密钥保护**：所有 API Key 与私密配置必须通过 `.env` 管理，严禁提交至版本控制系统。
2. **契约先行**：所有涉及结构化交互的能力模块，必须具备明确的 TypeScript 接口契约与运行时校验。
3. **安全失败 (Fail-Safe)**：提示词与编排逻辑必须明确安全边界，遇到不确定输入时要求澄清而非幻觉臆测。
