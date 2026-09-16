---
theme: channing-cyan
---

![generated-image-1782652231776.png](https://p1-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/b77a737b8fdf4725936cd175eddf8cb2~tplv-k3u1fbpfcp-jj-mark:0:0:0:0:q75.image#?w=1376&h=768&s=534781&e=jpg&b=0e2052)

到第十八章为止，我们的系统已经能看见（可观测）、能评估（eval）、守得住（安全）。但目前它还主要停留在本地开发环境。

如果你现在把这个项目交给一个新同事，让对方跑起来，大概率会经历这样的过程：`git clone` → `bun install` → `bun run dev` → 能跑。然后再要求部署到线上，对方很可能会卡住。因为从「本地能跑」到「线上能用」之间，隔着一整条工程化链路。

这条链路在传统 Web 应用里已经有成熟的模式。但 AI 应用不一样——实际落地时会发现，照搬 Spring Boot 的 CI/CD 模板，有些地方会失效。

本章的故事线是这样的：

```mermaid
flowchart LR
  A["本地能跑"] --> B["能自动测试?"]
  B --> C["能打包成镜像?"]
  C --> D["能自动构建?"]
  D --> E["部署去哪?"]
  E --> F["怎么安全上线?"]
  F --> G["上线后怎么办?"]
  G --> H["出问题怎么回滚?"]
```

![image.png](https://p6-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/16b95b6fc6ba4b07b0d07f37013ff59b~tplv-k3u1fbpfcp-jj-mark:0:0:0:0:q75.image#?w=3150&h=140&s=47078&e=png&b=1f2020)

每一步都会遇到问题，每个问题的解决都自然引出下一步。整体顺序也按真实交付路径展开：先解释为什么 AI 应用需要不同的 CI/CD，再补齐测试、Docker、Compose 和 CI，随后讨论部署平台、发布策略、三态版本管理、监控与上线检查。

> 学习目标
> *   理解 AI 应用的 CI/CD 比传统应用多了什么（模型/数据/prompt 三态、非确定性、成本），以及这些差异如何影响流水线和部署策略
> *   能把 `bun:test` + typecheck + lint 接进 turbo pipeline 和 GitHub Actions
> *   能把一个跑不起来的 Dockerfile 重写成 monorepo-aware 的多阶段构建
> *   能设计双库 Prisma 的生产迁移策略（`migrate deploy`）和回滚思路
> *   能把第十七章的 eval gate 接进 CI，理解「为什么它不该进每次 PR」的成本取舍
> *   **能设计 AI 应用的部署策略**：蓝绿（两套环境切换）、金丝雀（小比例逐步放量）、回滚，以及为什么 AI 的回滚不只是代码回滚
> *   **能管理 AI 应用的三态版本**：Prompt Version、Model Version、Knowledge Version，即影响系统行为的提示词、模型和知识库版本
> *   **能选择合适的部署平台**，并知道什么时候该换
> *   **能定义 AI 应用的 SLO**（Service Level Objective，服务等级目标）：不只有 Availability 和 Latency，还有 Eval Score 和 Cost per Request
> *   **能用 Production Checklist 做上线前的最后把关**

**本章demo地址**：[feat/cicd](https://github.com/Cookieboty/autix-demo/tree/feat/ch19-cicd)

***

## 19.1 为什么 AI 应用不能照搬传统 CI/CD

![image.png](https://p9-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/f6b1732522a940e98d5de5ba55d44a8e~tplv-k3u1fbpfcp-jj-mark:0:0:0:0:q75.image#?w=1672&h=941&s=1653170&e=png&b=070447)

如果之前部署过 Spring Boot 或 Next.js 项目，常见的心智模型大概是：代码是唯一的变量，编译通过 + 测试通过 = 可交付。

AI 应用打破了这个模型。

这个问题在一次「代码未变但线上质量变差」的排查中暴露得很清楚：业务代码没有变化，但模型别名背后的实际版本、推理参数或供应商侧行为发生变化后，用户看到的输出质量仍可能下降。

这说明：**AI 应用有三个独立变化的「态」，任何一个变化，都可能改变系统行为。**

```mermaid
flowchart TB
  subgraph traditional ["传统应用 — 一个变量"]
    Code1["代码"] --> Build1["编译"] --> Test1["测试\n100% 确定"] --> Ship1["交付"]
  end
  subgraph ai ["AI 应用 — 三个变量"]
    Code2["代码"] --> X["行为"]
    Model["模型\ngpt-4o → gpt-4.1"] --> X
    PromptData["Prompt / Skills / 知识库"] --> X
    X --> Test2["Layer 1 确定测试\n+ Layer 2 概率评估"] --> Gate["Quality Gate\n+ Cost Gate"] --> Ship2["交付"]
  end
```

![image.png](https://p3-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/fd12a3713d214899aa938add5e739985~tplv-k3u1fbpfcp-jj-mark:0:0:0:0:q75.image#?w=3819&h=744&s=125667&e=png&b=404242)

这三个态带来三个传统 CI/CD 没有的难题，也是本章所有设计决策的底层依据：

### 难题一：行为不只由代码决定

改了一个 `SKILL.md`（第十三章的能力模板），或者调了 `eval/rubrics/requirement-analysis.yaml` 里的一个阈值（第十七章的评分规约）——代码 diff 可能为零，但系统行为已经变了。反过来，模型供应商更新了版本，即使业务代码没有变化，输出质量也可能发生变化。

这意味着 CI/CD 必须把「模型版本、prompt、数据」也纳入回归变量。代码测试只能覆盖「代码变了」的回归，其余要靠 LLM 评测——这是后面 19.6 为什么要把 eval gate 单独拎出来的原因。

### 难题二：测试不全是确定的

传统测试是确定的：输入 X → 输出必须 Y。AI 应用的测试天然分两层：

| 层级              | 性质                 | 本仓库对应                                    | 成本      | 适合频率         |
| --------------- | ------------------ | ---------------------------------------- | ------- | ------------ |
| **Layer 1 确定层** | DTO 校验、纯函数、mock 链路 | `services/chat/test/*.spec.ts`（233 pass） | 零       | 每次 PR        |
| **Layer 2 概率层** | 真实 LLM 输出质量评估      | `scripts/run-eval.ts`（第十七章）              | 烧 token | nightly / 手动 |

这两层**不能混在一起跑**。这个分层决定了本章 CI 的核心架构：便宜的每次跑，贵的定时跑。

### 难题三：每次「测试」都可能花钱

传统 CI 跑一万次单元测试几乎没有边际成本。AI 评测则不同，每跑一次真实模型调用都会产生 token 成本。以一个包含多条真实分析和 LLM judge 评分的 eval 为例，单次成本可能从几美分到几十美分不等；如果每个 PR 都跑，成本会随着 PR 数量线性增长。这里的重点不是具体金额，而是：AI 评测必须被纳入成本设计。

这不是说 eval 不重要，而是说需要设计「分层门禁」——哪些每次跑，哪些定时跑，哪些手动触发。这是工程经济学，不是偷懒。

***

## 19.2 起点：我们的 monorepo 能做什么

在动手改之前，先看清项目现状。

根 `package.json` 用 Bun workspaces 管理三层目录（`clients/*`、`services/*`、`packages/*`），turbo 负责编排构建。`bunfig.toml` 配置了 `linker = "isolated"`，表示每个 workspace 的 `node_modules` 只软链自己声明的包，用来避免幽灵依赖。`turbo.json` 配了 `^build` 依赖链，让基础包（`@autix/types`、`@autix/contracts`）先编译。

当前项目的本地开发编排已经具备基础能力，但从「本地能跑」到「能自动交付」之间，仍有几个缺口需要补：

| 缺口                                        | 本章修复 |
| ----------------------------------------- | ---- |
| turbo 无 `test`/`lint` task，测试无法纳入统一流水线    | 19.3 |
| Docker 与 monorepo 不匹配，`docker build` 跑不起来 | 19.4 |
| compose 缺 postgres/qdrant，新人起不了完整环境       | 19.5 |
| 无任何 CI 配置，改动合并零自动把关                       | 19.6 |
| 无 `migrate deploy`，生产迁移靠手动                | 19.5 |

这些不是抽象设计问题，而是工程交付缺口：项目只要还停留在本地开发阶段，就很容易出现这些断点。接下来按交付链路一步一步补上。

***

## 19.3 第一步：让测试跑起来

### 19.3.1 turbo 原来长什么样

改动前的 `turbo.json`：

```json
{
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**"] },
    "dev": { "dependsOn": ["^build"], "cache": false, "persistent": true },
    "typecheck": { "dependsOn": ["^typecheck"] }
  }
}
```

没有 `test`，没有 `lint`。测试只能 `cd services/chat && bun test` 手动跑。

### 19.3.2 改了什么，为什么这样改

改动后的 `turbo.json`：

```json
{
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**"] },
    "dev": { "dependsOn": ["^build"], "cache": false, "persistent": true },
    "typecheck": { "dependsOn": ["^build"] },
    "test": { "dependsOn": ["^build"], "outputs": [] },
    "lint": { "outputs": [] }
  }
}
```

三个设计决策值得展开说：

**决策一：让 `test` 依赖 `^build`。** 被测 workspace 的依赖包要先编译，否则 import 不到 `@autix/types` 的类型声明。

**决策二：把 `typecheck` 从 `^typecheck` 改为 `^build`。** 这是一个真实问题，值得展开说明。

第一次把 typecheck 接进 turbo，本地全绿。推到 CI 上——全红。`Cannot find module '@autix/types'`。排查了半天才发现：本地的 `packages/types/dist/` 有上次 build 的残留，所以 typecheck 能找到 `.d.ts` 文件。CI 的 checkout 是干净的——`^typecheck` 只 typecheck 上游但不产出 `.d.ts`，下游根本找不到类型声明。

改成 `^build` 后立刻解决。**教训：永远在干净环境验证流水线。** 你本地机器上的残留文件会掩盖很多问题。

**决策三：为 test/lint 配置 `outputs: []`。** test/lint 没有产物文件，但 turbo 仍能基于输入文件的 hash 做增量缓存——同样的代码不会被重复测试。

### 19.3.3 根脚本和包脚本

根 `package.json` 补了两个脚本：

```json
"test": "turbo run test",
"lint": "turbo run lint --filter=!@autix/user"
```

`lint` 排除 `@autix/user`（admin-web）——它有 38 个历史 eslint 报错。这是一个取舍：技术债标记在案，但不放进门禁阻塞其他人，留作独立整改。在真实项目里你经常需要做这种决定。

`services/chat/package.json` 补了三个脚本：

```json
"test": "bun test",
"lint": "tsc --noEmit",
"db:deploy": "prisma migrate deploy"
```

### 19.3.4 「从没被流水线跑过的代码」的五个坑

把 typecheck/lint/test 接进统一入口后，五处预存问题浮出水面：MCP SDK 类型未收窄、DeepAgent 返回类型推断不可移植、admin-web 缺依赖声明、vitest 引用错误、孤儿测试。

这件事验证了一个朴素的道理：**从未被流水线验证过的代码，往往会隐藏问题。** 这不是开发者不认真，而是本地环境太宽容——残留的 `dist`、自动加载的 `.env`、全局安装的工具，都会掩盖问题。

全部修掉后本地验证全绿：

```bash
bun run typecheck   # 6/6 包通过
bun run lint        # 3/3 包通过
bun run test        # chat 233 pass / 19 skip
bun run build       # 5/5 包通过
```

### 19.3.5 Layer 分层为什么在 CI 里天然生效

chat 的 `bun test` 扫 `test/` 下所有 spec。Layer 2 用例需要 `OPENAI_API_KEY` + 显式 flag，CI 默认不设这些，Layer 2 自动跳过。

这是第十三/十四/十五章一直坚持的 Layer 1/Layer 2 分层结构的收益——到这里才真正兑现。CI 不用任何特殊处理，天然只跑便宜的确定测试。

> **注意一个反直觉的行为**：本地跑 `bun run test` 可能花 2 分钟还烧 token——因为 Bun 会自动加载 `.env`，本地的真 key 让 Layer 2 全跑了。CI 没有 `.env`，反而是正确行为。要在本地模拟 CI：`OPENAI_API_KEY= bun test`。

***

测试能跑了。但要把它部署到线上，第一步是打包成容器镜像。而在这一步，项目暴露出了第一个阻塞问题。

## 19.4 第二步：让 Docker 跑起来

![generated-image-1782652224361.png](https://p6-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/322621608cec4c6a8e3dff4e8c395110~tplv-k3u1fbpfcp-jj-mark:0:0:0:0:q75.image#?w=1376&h=768&s=374464&e=jpg&b=33383e)

### 19.4.1 问题现场

执行 `docker build -f infra/compose/Dockerfile.chat .`，直接报错：`bun.lockb: no such file`。

打开旧的 Dockerfile 一看——`COPY bun.lockb ./`。但仓库实际的 lock 文件是 `bun.lock`（Bun 1.x 改了命名），而且 `.gitignore` 忽略 `*.lockb`。这个文件根本不存在。

继续看下去，其实问题还挺多。根因只有一个：**旧 Dockerfile 把整个仓库当成单包项目处理，没有 monorepo 意识。**

| # | 错误                    | 实际情况                                 |
| - | --------------------- | ------------------------------------ |
| ① | `COPY bun.lockb`      | 仓库是 `bun.lock`                       |
| ② | `CMD dist/main.js`    | chat 产物在 `services/chat/dist/`       |
| ③ | compose 映射 3001       | chat 实际端口 4001                       |
| ④ | 复制 `.next/standalone` | `chat-web` 没配 `output: 'standalone'` |
| ⑤ | 挂载 `clients/web`      | 实际目录 `clients/chat-web`              |

五个错误，每一个都足以让 build 或运行失败。

### 19.4.2 重写：monorepo-aware 的多阶段 Dockerfile

为什么选多阶段构建？单阶段当然更简单，但在 monorepo 里问题很多：改一行代码就要重装全部依赖（缓存失效）、镜像带着源码和 devDeps（体积大、攻击面大）、全量构建（包括不相关的包）。

重写后的 `infra/compose/Dockerfile.chat`，三阶段：

```docker
# ── Stage 1: deps — 安装依赖（代码变了不重装）──
FROM oven/bun:1.3.11 AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY packages/types/package.json ./packages/types/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/database/package.json ./packages/database/
COPY services/chat/package.json ./services/chat/
COPY services/user-system/package.json ./services/user-system/
COPY clients/chat-web/package.json ./clients/chat-web/
COPY clients/admin-web/package.json ./clients/admin-web/
RUN bun install --frozen-lockfile

# ── Stage 2: build — turbo 只构建 chat 及其依赖包 ──
FROM deps AS build
COPY . .
RUN bun run build --filter=@autix/chat
RUN cd services/chat && bunx prisma generate

# ── Stage 3: runtime — 只带产物，镜像更小 ──
FROM oven/bun:1.3.11-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/services/chat/node_modules ./services/chat/node_modules
COPY --from=build /app/services/chat/dist ./services/chat/dist
COPY --from=build /app/services/chat/config ./services/chat/config
COPY --from=build /app/services/chat/prisma ./services/chat/prisma
EXPOSE 4001
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD bun -e "fetch('http://localhost:4001/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "run", "services/chat/dist/main.js"]
```

逐层解释设计决策：

**Stage 1 只 COPY manifest 文件**（各包的 `package.json` + `bun.lock`）。Docker 的缓存机制是按层计算的——只要 manifest 没变，`bun install` 那一层就命中缓存，不会因为一行业务代码改动而重装 2000 个依赖包。这在 CI 环境下能节省几分钟。

**Stage 2 使用 `--filter=@autix/chat`。** turbo 自动解析依赖图，只构建 `@autix/chat` 和它的上游包（`@autix/types`、`@autix/contracts`），不碰无关的 `admin-web`。构建范围越小，速度越快，出错面越小。

**Stage 3 使用 `bun:1.3.11-slim`。** 运行时镜像不带源码、不带 devDeps、不带构建工具，只保留运行所需的产物。这不只是体积问题——第十八章讲过，镜像内容越少，攻击面越小。

**HEALTHCHECK 指向 `/ready` 而不是 `/health`。** 这是第十六章设计的就绪检查——它会实际探测 DB 连接，而不是只返回 200。这个细节决定了 compose 的依赖链能不能正确工作。

***

Docker 能 build 了。但单独一个容器跑不了——它需要数据库。而这就引出了下一步。

## 19.5 第三步：一键拉起完整环境

![image 1.png](https://p6-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/82f6ec4562264b0abef0b24a34c4e80c~tplv-k3u1fbpfcp-jj-mark:0:0:0:0:q75.image#?w=1672&h=941&s=1765963&e=png&b=010f36)

### 19.5.1 从「README 与实际不一致」到「一键可跑」

一个新同事拉下代码，看 README 说 `docker compose up` 能启动 PostgreSQL + Qdrant + 应用。实际执行后却发现，compose 文件里根本没有 PostgreSQL 服务。**文档描述与实际能力不一致，比没有文档更容易误导使用者。**

重写后的 `infra/compose/compose.yaml`：

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_DB: autix_chat
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5

  qdrant:
    image: qdrant/qdrant
    ports: ["6333:6333"]

  ragas:                           # 第十七章的本地 RAGAS 评测服务
    build: { context: ./ragas }
    ports: ["7860:7860"]

  migrate:                         # 一次性容器：跑完退出，不常驻
    build:
      context: ../..
      dockerfile: infra/compose/Dockerfile.chat
    command: sh -c "cd /app/services/chat && bunx prisma migrate deploy"
    depends_on:
      postgres: { condition: service_healthy }
    environment:
      DATABASE_URL: "postgresql://postgres:${POSTGRES_PASSWORD}@postgres:5432/autix_chat"
    restart: "no"

  chat:
    build:
      context: ../..
      dockerfile: infra/compose/Dockerfile.chat
    ports: ["4001:4001"]
    depends_on:
      postgres: { condition: service_healthy }
      migrate: { condition: service_completed_successfully }
    environment:
      DATABASE_URL: "postgresql://postgres:${POSTGRES_PASSWORD}@postgres:5432/autix_chat"
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      OPENAI_BASE_URL: ${OPENAI_BASE_URL:-}
    healthcheck:
      test: ["CMD", "bun", "-e", "fetch('http://localhost:4001/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s

  web:
    build:
      context: ../..
      dockerfile: infra/compose/Dockerfile.web
    ports: ["3002:3002"]
    depends_on:
      chat: { condition: service_healthy }

volumes:
  pgdata: {}
```

这份 compose 有三个值得说的编排决策：

**healthcheck 串联依赖顺序。** 启动顺序是：postgres 健康 → migrate 执行 → migrate 完成 → chat 启动 → chat 健康 → web 启动。任何一环失败，后续都不会起。这比 `depends_on` 的默认行为（只等容器启动，不等就绪）可靠得多。

**migrate 是一次性 init 容器。** `restart: "no"` + `service_completed_successfully`——它的唯一任务是跑 `prisma migrate deploy`，跑完退出。这个模式来自 Kubernetes 的 initContainer 概念，在 compose 里用 `service_completed_successfully` 实现。

**但要注意：Docker Compose 不是通用的生产标准。** 它非常适合单机部署、小团队、内部系统和第一个 AI 项目的验证环境；如果系统开始需要高可用、多实例、自动扩缩容、跨可用区容灾，通常就应该迁移到 Kubernetes、Nomad，或者 Cloud Run、ECS、Azure Container Apps 这类云厂商托管容器服务。换句话说：Compose 解决的是「先稳定跑起来」，不是「无限扩展」。

**一个常见问题：** 有人 `docker compose up` 成功了，本地开发一切正常。然后把 `.env` 文件 commit 到了 GitHub（或者忘了在服务器上创建 `.env`）。结果线上 `compose up` 时 postgres 的密码是空的，chat 服务连不上数据库。**缺少 `.env` 的 compose 很难稳定运行。** 所以 `.env.example` 文件很重要——它告诉部署者需要配置哪些变量。

### 19.5.2 Prisma 的生产迁移：为什么不能用 `migrate dev`

很多开发者在本地用惯了 `prisma migrate dev`，部署时也沿用同一条命令。这个习惯在生产环境中风险很高。

|        | `migrate dev`            | `migrate deploy`    |
| ------ | ------------------------ | ------------------- |
| **用途** | 本地开发                     | 生产部署                |
| **行为** | 生成 + 应用 migration，可能提示重置 | **只应用**已有 migration |
| **交互** | 可能弹出确认框                  | 非交互，失败即退出           |
| **安全** | 可能删表重建                   | **只前滚，绝不重置**        |

生产迁移的四条纪律：

1.  **顺序**：基础库（`packages/database`）先迁，业务库（`services/chat`）后迁
2.  **向后兼容**：先加列再改代码，不删列——保证旧版本代码也能跑在新 schema 上
3.  **回滚靠兼容**：回滚 = 部署旧版本代码（它能跑在新 schema 上），不是回滚 migration
4.  **失败即停**：`migrate deploy` 遇到错误立即非零退出，compose 的 `service_completed_successfully` 会阻止 chat 启动

***

到这里，测试、镜像和本地完整环境都能跑起来了。但它们仍然依赖人工执行：改了代码，要自己跑 `bun run test`，自己 `docker build`。交付链路的下一步，是把这些检查变成每次 push 和 PR 都会自动触发的门禁。

## 19.6 第四步：把闸门立起来

![image 2.png](https://p6-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/70c67b1c61e64e7f9c94fa96867d59a1~tplv-k3u1fbpfcp-jj-mark:0:0:0:0:q75.image#?w=1672&h=941&s=1621139&e=png&b=020a2f)

### 19.6.1 CI 的完整设计

`.github/workflows/ci.yml` 分两个 job：`ci`（每次 PR / push）和 `eval`（nightly / 手动）。这个拆分不是随意的——它直接回应 19.1 的两层测试分流。

本书选择 GitHub Actions 作为示例，是因为它和 GitHub 仓库集成度高、学习成本低，适合作为读者的统一起点。但它不是唯一推荐。实际企业环境中，也大量使用 GitLab CI/CD、Jenkins、Azure DevOps、CircleCI 等方案。这里真正要掌握的不是某个工具的 YAML 语法，而是「便宜检查每次跑，昂贵评测定时跑，失败尽早停止」这套流水线分层原则。

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: "0 18 * * *"          # 北京时间每天 10:00
  workflow_dispatch:

jobs:
  ci:
    if: github.event_name == 'push' || github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env:
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: autix_chat
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 10s --health-timeout 5s --health-retries 5
    env:
      DATABASE_URL: postgresql://postgres:postgres@localhost:5432/autix_chat
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 1.3.11 }
      - run: bun install --frozen-lockfile
      - name: Typecheck
        run: bun run typecheck
      - name: Lint
        run: bun run lint
      - name: Migrate
        run: bunx prisma migrate deploy
        working-directory: services/chat
      - name: Test
        run: bun run test
      - name: Build
        run: bun run build

  eval:
    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    env:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      OPENAI_BASE_URL: ${{ secrets.OPENAI_BASE_URL }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 1.3.11 }
      - run: bun install --frozen-lockfile
      - name: Run eval gate
        run: bun run scripts/run-eval.ts
        working-directory: services/chat
      - name: Upload eval report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: eval-report
          path: services/chat/eval/reports/
```

`ci` job 的步骤顺序是刻意设计的：**便宜的先跑，贵的后跑，失败早退。** typecheck 秒级，lint 秒级，migrate 几秒——这些都是不花钱、不依赖外部服务的检查。test 要几十秒（233 个用例），build 最慢。前面挂了就不跑后面，节省 CI 时间。

> **一个 CI 调试经验**：GitHub Actions 第一次跑，`Migrate` 步骤失败了。报错是 `Connection refused`。原因是 postgres service container 的 healthcheck 还没通过，步骤就开始跑了。解决方案是在 service 定义里加 `options: --health-*`——这样 Actions 会等 healthcheck 通过后才执行 steps。这个问题只在 CI 上出现，本地 compose 有 `depends_on` 不会遇到。

### 19.6.2 为什么 eval 不放进每次 PR

第十七章的 `run-eval.ts` 产出 0/1 退出码，天然适合作为 CI 闸门。但这里不建议把它放进每次 PR 的 `ci` job。主要有三个原因：

1.  **成本**：每次 PR 跑 eval 都会消耗 token。一天 20 个 PR，一个月 \$50+。
2.  **速度**：一个改了 README 的 PR，不应该等 5 分钟 LLM 评测。
3.  **波动**：LLM 有噪声。同一个 prompt 跑两次，分数可能差 5%。你不想因为噪声 fail 一个无辜的 PR。

所以 eval 单独一个 job，`schedule` + `workflow_dispatch`——nightly 自动跑，需要时手动触发。secrets 走 GitHub Secrets，不进代码仓库。

### 19.6.3 Quality Gate + Cost Gate

但 eval gate 只管质量，不管成本。这在 AI 应用里是不够的。

一个常见场景：你改了 prompt，eval 分数从 0.85 涨到 0.92——看起来是好事。但新 prompt 让模型输出变长了 3 倍，token 成本上涨 40%。只看质量，这个改动会被放行；但上线后成本可能快速上升。

所以完整的门禁应该是 **Quality Gate + Cost Gate** 双重检查：

```mermaid
flowchart TB
  PR["每次 PR"] --> Layer1["Layer 1 确定测试\ntypecheck / lint / test / build\n秒级 · 不花钱 · 必须过"]
  Layer1 --> Merge["允许合并"]
  
  Schedule["nightly / 手动"] --> Eval["Layer 2 LLM 评测"]
  Eval --> QG{"Quality Gate\nEval Score ≥ 阈值?"}
  Eval --> CG{"Cost Gate\n单请求 Token 成本 ≤ 预算?"}
  QG -->|Fail| Block1["❌ 质量退化"]
  CG -->|Fail| Block2["❌ 成本超标"]
  QG -->|Pass| CG
  CG -->|Pass| Ship["✅ 可上线"]
```

![image.png](https://p6-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/41f9d7212a7d4f47894803d9d2dd74f7~tplv-k3u1fbpfcp-jj-mark:0:0:0:0:q75.image#?w=1365&h=1940&s=163000&e=png&b=020817)

Cost Gate 的数据来自第十六章的 `withTokenUsage`——它记录了每次请求的 token 消耗。eval runner 跑完后，除了质量分数，还统计总 token 消耗并与历史 baseline 对比。成本上涨超过阈值，退出码非 0。

***

## 19.7 配置与密钥的分层

到这里，代码能自动测试、打包、构建了。但在真正部署之前，还有一个容易忽略的问题：**配置管理**。

系统已有合理分层：业务参数走 `config/langchain.yaml`（进版本库），密钥走环境变量（`.gitignore` 忽略所有 `.env`）。

但 AI 应用有一个传统应用没有的维度：**模型配置也是环境差异**。

```yaml
# services/chat/config/langchain.yaml
llm:
  provider: openai
  model: gpt-5.4          # ← 这行决定了系统行为的大部分
  temperature: 0.7
  maxTokens: 2048
```

dev 环境可以用便宜的小模型快速迭代，staging 用正式模型验证质量，prod 用正式模型服务用户。但这里有一个容易踩的坑：**如果 staging 用的模型和 prod 不一致，staging 的 eval 结果就不能代表 prod 的质量。** 传统应用 staging 和 prod 代码一致就够了；AI 应用还得保证模型、prompt、rubric 都一致。

配置和密钥解决的是「能不能部署」；部署策略要解决的是「怎么安全地把新版本交给用户」。

***

## 19.8 部署策略：为什么不能直接滚动更新

![image 3.png](https://p9-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/ded9ac3e2ed84209a3e8214b59943867~tplv-k3u1fbpfcp-jj-mark:0:0:0:0:q75.image#?w=1672&h=941&s=1566727&e=png&b=01122b)

CI 全绿，镜像打好了。下一个问题：**怎么上线？**

很多人的第一反应是滚动更新——拉新镜像、替换旧容器、逐个替换。传统 Web 应用这样做通常没问题。但 AI 应用有一个特点：**出问题的方式往往不是崩溃，而是输出质量的微妙退化。**

服务崩溃通常很快就能发现——500 错误率飙升，告警触发。但如果新版本的 prompt 让报告质量从 0.85 降到 0.72，用户可能需要几天才会感受到「最近质量变差了」。而滚动更新是「边替换边服务」——在替换过程中，已经有部分用户使用了有问题的新版本。

所以 AI 应用更适合「先验证再切流量」的策略。

这里还要补一个 AI 工程里的关键判断：传统 Web 应用部署的核心对象通常是**代码版本**；AI 应用部署的对象则是：

```mermaid
flowchart LR
  Code["Code<br>代码"] --> Eval["Eval<br>评估"]
  Prompt["Prompt<br>提示词 / Skills / rubric"] --> Eval
  Model["Model<br>模型版本 / 参数"] --> Eval
  Knowledge["Knowledge<br>知识库 / Embedding 索引"] --> Eval
  Eval --> Deploy["Deploy<br>部署"]
  Deploy --> Monitor["Monitor<br>监控"]
  Monitor --> Rollback["Rollback<br>回滚"]
```

![image.png](https://p9-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/b1b36109f5b64798b1bb8af06273d126~tplv-k3u1fbpfcp-jj-mark:0:0:0:0:q75.image#?w=1785&h=956&s=98218&e=png&b=020817)

也就是说，AI 应用的部署不是「把一个镜像推上去」这么简单，而是代码、Prompt、模型和知识库四者共同演进。只回滚代码，不一定能解决线上质量问题。下面先看两种上线策略：蓝绿部署用于「先验证再切换」，金丝雀发布用于「先小流量试运行」。

### 19.8.1 蓝绿部署

蓝绿部署指同时保留两套环境：蓝（当前生产）和绿（新版本）。新版本先部署到绿环境，并且**先在绿环境跑一遍 eval**——第十七章的 `run-eval.ts` 在这里又一次发挥作用。eval 通过后再切流量；如果不通过，直接丢弃绿环境，不影响线上用户。

```mermaid
flowchart LR
  Build["CI 构建镜像"] --> Green["部署到绿环境"]
  Green --> Smoke["Smoke Test\n基本可用?"]
  Smoke --> Eval["Eval Gate\n质量达标?"]
  Eval -->|通过| Switch["切换流量\n蓝→绿"]
  Eval -->|未通过| Discard["丢弃绿环境\n零影响"]
  Switch --> Monitor["监控 15 分钟"]
  Monitor -->|异常| Rollback["切回蓝环境\n< 30 秒"]
  Monitor -->|正常| Done["绿成为新蓝"]
```

![image.png](https://p1-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/fbdcc222a56c4f8cb05fdac28616b6f5~tplv-k3u1fbpfcp-jj-mark:0:0:0:0:q75.image#?w=2789&h=560&s=102895&e=png&b=020817)

### 19.8.2 金丝雀发布

eval 在离线数据集上通过了，不代表线上真实流量一定没有问题。用户请求的分布更复杂，eval 测试集也无法覆盖所有 case。金丝雀发布的作用，就是先让一小部分流量使用新版本，再逐步放量：5% → 20% → 50% → 100%。

```mermaid
flowchart LR
  Deploy["新版本"] --> P5["5% 流量\n观察 1h"]
  P5 -->|正常| P20["20% 流量\n观察 2h"]
  P20 -->|正常| P50["50% 流量\n观察 4h"]
  P50 -->|正常| P100["100%"]
  P5 -->|异常| RB["回滚"]
  P20 -->|异常| RB
  P50 -->|异常| RB
```

![image.png](https://p1-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/556cd9fbaa2747888aa6cdbb9d4a872b~tplv-k3u1fbpfcp-jj-mark:0:0:0:0:q75.image#?w=1751&h=450&s=62630&e=png&b=020817)

每个阶段观察什么？四个指标，全部回扣前面章节的能力：

| 指标          | 数据来源                    | 告警阈值（示例）  |
| ----------- | ----------------------- | --------- |
| P95 Latency | 第十六章 Prometheus metrics | \> 5s     |
| 错误率         | 第十六章 pino 结构化日志         | \> 2%     |
| Token 成本/请求 | 第十六章 `withTokenUsage`   | \> \$0.08 |
| 用户负反馈率      | 前端埋点                    | \> 10%    |

### 19.8.3 AI 应用的回滚不只是代码回滚

这是很多做过传统 DevOps 的人容易忽略的。传统应用回滚 = 部署上一个镜像。AI 应用的回滚则更像一个组合动作：

```mermaid
flowchart TB
  RB["Rollback"] --> Code["代码版本"]
  RB --> Prompt["Prompt / Skills"]
  RB --> Model["Model"]
  RB --> Knowledge["Knowledge"]
  RB --> Embedding["Embedding 索引"]
```

![image.png](https://p3-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/f670545d4a7541a2ad2b0d482d74456c~tplv-k3u1fbpfcp-jj-mark:0:0:0:0:q75.image#?w=1841&h=348&s=41950&e=png&b=020817)

因此，AI 应用可能需要同时回滚多个东西：

| 回滚对象                | 触发场景              | 回滚方式                   |
| ------------------- | ----------------- | ---------------------- |
| **代码**              | 新功能 bug           | 部署上一版本镜像               |
| **Prompt / Skills** | `SKILL.md` 引入错误指令 | git revert prompt 文件   |
| **模型**              | 切换模型效果下降          | `langchain.yaml` 切回旧模型 |
| **知识库**             | Embedding 重建出错    | 回退向量库索引到上一个快照          |
| **数据库 Schema**      | migration 破坏性变更   | 部署旧镜像（靠向后兼容）           |

**上线前必须问自己：如果出问题了，我需要回滚哪些东西？每一个都有回滚方案吗？**

***

## 19.9 部署到哪：部署平台选择建议

讲完怎么构建、怎么上线，下一个问题是：**部署到哪个平台？**

这一节不做云厂商百科。市面上的选择很多，而且大多数平台都会强调「支持 Docker」。这里更关注**决策建议**：什么阶段用什么、为什么这样选、什么时候应该切换平台。

### 19.9.1 我的推荐路线

**如果你在做第一个 AI Side Project**，我建议优先考虑 Railway。

原因很简单：GitHub Push 自动部署、PostgreSQL 一键创建、环境变量管理开箱即用。从本章的 compose 迁过去也比较直接——每个 compose service 对应一个 Railway service。月费大约 \$5–50。在 Side Project 阶段，VPC、安全组、IAM 等复杂配置通常还不是主要矛盾。

但 Railway 不是生产环境的万能方案。它非常适合作为 MVP、个人项目和小团队产品的部署平台；当业务规模扩大，开始需要更强的网络隔离、权限体系、可观测性、自动扩缩容和合规能力时，就应该逐步迁移到 Cloud Run、ECS、GKE、EKS 或 Kubernetes 等平台。

一句话判断：

*   ✅ 推荐：MVP、个人项目、小团队产品、低到中等流量的 AI API
*   ❌ 不推荐：每天百万级请求、强合规、多区域容灾、复杂企业网络

```mermaid
flowchart LR
  GH["GitHub Push"] --> Railway["Railway\n自动 Docker Build"]
  Railway --> PG["Railway PostgreSQL\n(带 pgvector)"]
  Railway --> App["chat + chat-web"]
```

![image.png](https://p6-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/396e08e2682e490fb97ae170e8aac3e4~tplv-k3u1fbpfcp-jj-mark:0:0:0:0:q75.image#?w=1299&h=396&s=42760&e=png&b=020817)

**当团队超过 3–5 人，或者你需要更多控制**（固定 IP、自定义网络、合规要求），我建议迁移到 Cloud Run（Google Cloud）或 ECS Fargate（AWS）。

为什么 AI API 特别适合 Cloud Run？不是因为它「支持容器」或「支持 HTTPS」，而是因为它的计费和伸缩模型很契合很多 AI API 的流量形态：

*   请求具有明显波峰波谷，不一定 24 小时持续高 QPS
*   LLM 调用耗时长，但应用层 CPU 负载未必一直很高
*   空闲时自动缩容，能减少低流量阶段的固定成本
*   用容器交付，迁移成本比绑定某个 Serverless 函数框架更低

但 Cloud Run 更适合事件驱动、弹性伸缩的 API 服务，不等于适合所有 AI 推理场景。如果是长期运行的大模型推理服务，例如 vLLM、Ollama、70B 模型或持续占用 GPU 的推理集群，通常更适合 RunPod、GKE、EKS、Kubernetes 或专门的 GPU 平台。Cloud Run 已经支持 GPU，可以覆盖一部分推理场景，但不要把它理解成长期 GPU 服务的默认答案。

**不建议一开始就上 Kubernetes。** 大多数团队真正的问题不是扩容，而是 Prompt 质量、模型选择、缓存策略和评测体系。K8s 是一个强大但复杂的系统，运维它本身就需要持续投入。等你的服务数量超过十几个、需要跨可用区容灾、统一服务治理、多团队协作和精细权限控制时，再考虑 K8s 不迟。

我的经验判断是：如果一个 AI 应用每天只有几百次请求，一套 Docker Compose + PostgreSQL + GitHub Actions 的组合，往往比复杂的 Kubernetes 更容易维护。很多团队会把大量精力投入容器编排，但真正影响用户体验的，往往是 Prompt 质量、模型选择、缓存策略和回滚能力。

### 19.9.2 平台选择速查

| 平台                     | 为什么推荐                             | 什么时候用                    | 什么时候不用                   |
| ---------------------- | --------------------------------- | ------------------------ | ------------------------ |
| Railway                | 上手快、GitHub 直连、数据库和环境变量管理简单        | MVP、Side Project、小团队早期产品 | 百万级请求、强合规、多区域容灾          |
| Cloud Run              | 按请求计费、自动缩容、适合波峰波谷明显的 AI API       | 低到中等 QPS、请求耗时较长、希望降低空闲成本 | 长期占用 GPU、复杂服务网格、极低冷启动容忍度 |
| ECS Fargate            | 和 AWS 生态集成好，适合 VPC、IAM、日志、监控等企业能力 | 企业生产、AWS 体系内、多服务后端       | 极早期项目、预算和运维经验不足          |
| 阿里云 ECS / 腾讯云 CVM      | 国内访问、备案、合规和网络延迟更可控                | 国内业务、单机或小规模部署            | 需要强自动扩缩容和多区域托管能力         |
| Kubernetes / GKE / EKS | 服务治理、弹性、可观测性和多团队协作能力强             | 服务数量多、跨可用区、GPU 集群、复杂流量治理 | 第一个 AI 项目、低流量单服务应用       |

平台迁移的信号也很明确：当 AI 服务开始出现多实例部署、自动扩缩容、VPC/IAM 等企业能力需求，或者需要稳定管理 GPU、队列、缓存、批处理和在线服务时，AWS、Google Cloud、Azure 或 Kubernetes 会比单台 VPS 更合适。

### 19.9.3 一个容易踩的坑：GPU

很多人第一次部署 AI 应用，就直接买了一台 8C16G 带 GPU 的云服务器。实际上，**大部分 Agent 项目并不需要 GPU**。

本书全程调用 OpenAI API——模型推理在 OpenAI 的 GPU 上跑，你的服务器只需要处理网络请求和业务逻辑，一台普通 CPU 服务器完全够用。只有当你自托管开源大模型（Llama、Mistral 等）时才需要 GPU。

如果你确实需要 GPU，要先区分两类场景：

*   **弹性推理 / 间歇性推理**：可以考虑 Cloud Run GPU、RunPod Serverless 或类似平台，重点是按需启动、按量付费。
*   **长期运行的大模型推理**：例如 vLLM、Ollama、70B 模型、多副本在线服务，更适合 RunPod、Lambda Labs、GKE、EKS 或 Kubernetes 这类能长期稳定占用 GPU 的平台。

不要因为「平台支持 GPU」就默认它适合所有推理场景。GPU 部署真正要看的是：是否长期占用、是否需要多副本、是否需要队列调度、是否要做模型热加载和资源隔离。

平台选择解决的是「部署到哪里」；但 AI 应用还有一个更容易被低估的问题：部署对象本身不只有代码，还包括 Prompt、模型和知识库。

***

## 19.10 AI 应用独有的挑战：三态版本管理

![image 4.png](https://p3-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/83289b64b58f4afd86cce0cfd1ce9592~tplv-k3u1fbpfcp-jj-mark:0:0:0:0:q75.image#?w=1672&h=941&s=1610766&e=png&b=070d40)

到这里，CI/CD 和部署都讲完了。如果这是一本传统 DevOps 的书，故事到这里基本可以结束了。

但 AI 应用还有一个传统应用没有的挑战：**除了代码，还有三个东西需要版本管理。** 而且这三个东西的变更，可能比代码改动的影响还大。

```mermaid
flowchart TB
  subgraph 三态版本管理
    P["Prompt Version\nSKILL.md / rubric / langchain.yaml"]
    M["Model Version\ngpt-4o → gpt-4.1"]
    K["Knowledge Version\nRAG 索引 / 文档库"]
  end
  P --> Impact["影响系统行为"]
  M --> Impact
  K --> Impact
  Impact --> Need["需要：版本追踪 + 变更验证 + 回滚能力"]
```

![image.png](https://p1-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/113e681c4471450a850b1153fcee6a7c~tplv-k3u1fbpfcp-jj-mark:0:0:0:0:q75.image#?w=1646&h=800&s=94459&e=png&b=020817)

### 19.10.1 Prompt Version

改一行 prompt 可能比改十行代码影响还大。但很多团队对 prompt 的版本管理是零——改了就改了，没有 diff，没有回滚点。

本仓库用 Git 管理所有影响 LLM 行为的文件：

    services/chat/config/langchain.yaml              ← 模型参数
    services/chat/src/skills/definitions/*/SKILL.md  ← Skills 能力模板（第十三章）
    services/chat/eval/rubrics/*.yaml                ← 评分规约（第十七章）

全部进版本库——每次修改有 git diff、能 revert。这是最简单但最有效的 prompt 版本管理。

```mermaid
flowchart LR
  Dev["修改 prompt"] --> PR["PR Review\n含 prompt diff"]
  PR --> Merge["合并"]
  Merge --> Eval["nightly eval\n质量退化?"]
  Eval -->|退化| Revert["git revert"]
  Eval -->|通过| Deploy["部署"]
```

![image.png](https://p3-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/78d1a53f02be4f82a7f1e604dc747d35~tplv-k3u1fbpfcp-jj-mark:0:0:0:0:q75.image#?w=1847&h=348&s=47423&e=png&b=020817)

**关键原则：prompt 的修改走和代码一样的流程**——PR review、CI 检查、eval 验证。因为 prompt 改动的影响经常比代码改动更大、更难预测。

更成熟的做法是 Prompt Registry——一个专门管理 prompt 版本的服务，支持 A/B 测试、灰度发布、即时回滚。但对大多数团队来说，Git 管理 + nightly eval 已经够用了。

### 19.10.2 Model Version

`config/langchain.yaml` 里改一行 `model: gpt-5.4`，一行代码没改但行为就变了。模型切换本质上是一次「部署」。

**永远不要在生产直接切模型。** 正确的流程：

```mermaid
flowchart TB
  New["新模型候选"] --> Shadow["影子模式\n新模型并行运行\n只记录不服务"]
  Shadow --> Eval["eval 对比\n新 vs 旧\n质量 + 成本"]
  Eval --> Compare{"质量 ≥ 旧?\n成本 ≤ 预算?"}
  Compare -->|是| Canary["金丝雀放量\n5% → 20% → 100%"]
  Compare -->|否| Keep["保持旧模型"]
```

![image.png](https://p3-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/61a7599a487e4cf8b833255e33b9af38~tplv-k3u1fbpfcp-jj-mark:0:0:0:0:q75.image#?w=792&h=1483&s=91186&e=png&b=020817)

影子模式（Shadow Mode）指：新模型和旧模型同时运行，但只有旧模型的结果返回给用户，新模型的结果只用于对比评估。这样可以在不影响用户体验的前提下评估新模型的质量和成本。确认不退化后，再通过金丝雀逐步放量。

### 19.10.3 Knowledge Version

知识库更新（重建 Embedding 索引、更新文档）也是一次「部署」。关键是**索引快照**——重建前保存旧索引快照，切换失败秒回旧索引。pgvector 可以通过数据库快照实现；Qdrant 提供 collection snapshot 能力。

### 19.10.4 Feature Flag：不重新部署就切功能

Feature Flag（功能开关）不只是代码里的 `if (flag) { ... }`。它真正的价值是：**解耦部署（Deployment）和发布（Release）**。

部署是把代码放到生产环境；发布是让用户真正使用某个功能。没有 Feature Flag 时，两者通常绑在一起：代码一上线，功能就暴露给用户。有了 Feature Flag，新代码可以先部署但不开启，再按用户、比例、环境或租户逐步放开。本仓库的 `config/langchain.yaml` 已经有 Feature Flag 的雏形：

```yaml
features:
  enableStructuredOutput: false
  enableStreaming: true
```

成熟的 Feature Flag 系统（LaunchDarkly、Unleash、Flagsmith）还支持按用户百分比灰度、按属性灰度、即时开关。

**Feature Flag（控制可见性）+ 金丝雀（控制流量）+ eval（验证质量）= AI 应用灰度发布的三件套。**

当代码、Prompt、模型和知识库都有了版本管理，功能发布也能通过 Feature Flag 控制后，下一步就是回答一个更现实的问题：上线之后，怎么判断它真的还在健康运行？

***

## 19.11 上线之后怎么办：监控与 SLO

![image 5.png](https://p6-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/c3caaef78c514589bedf2821e1f7c646~tplv-k3u1fbpfcp-jj-mark:0:0:0:0:q75.image#?w=1672&h=941&s=1571660&e=png&b=040f1c)

部署成功不是终点。**上线后仍需要持续确认系统是否健康。**

### 19.11.1 AI 应用的监控比传统应用多了什么

第十六章建立的可观测性基础（结构化日志 + traceId + token 计量）在这里延伸到生产监控：

```mermaid
flowchart TB
  App["AI 应用运行中"]
  App --> Logs["日志\npino JSON → ELK / Loki"]
  App --> Metrics["指标\nPrometheus → Grafana"]
  App --> Traces["追踪\nOpenTelemetry → Jaeger"]
  App --> AI["AI 专属\nLangSmith / Phoenix"]
  
  Logs --> Alert["告警"]
  Metrics --> Alert
  AI --> Alert
  Alert --> Response["响应"]
```

![image.png](https://p1-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/a887596f9c6c4cbb8bd9d819760bb0a2~tplv-k3u1fbpfcp-jj-mark:0:0:0:0:q75.image#?w=2146&h=812&s=83370&e=png&b=020817)

| 层级        | 开源方案                 | SaaS 方案              | 监控什么                |
| --------- | -------------------- | -------------------- | ------------------- |
| **日志**    | Loki + Grafana       | Datadog              | 错误、请求、审计            |
| **指标**    | Prometheus + Grafana | Datadog              | QPS、延迟、错误率、token 成本 |
| **追踪**    | Jaeger / Tempo       | Datadog APM          | 请求全链路、节点耗时          |
| **AI 专属** | Phoenix (Arize)      | LangSmith / Helicone | LLM 调用详情、eval 分数趋势  |

**AI 专属监控是传统应用没有的。** 你需要看到每一次 LLM 调用的 prompt、response、token 数、延迟，以及 eval 分数的趋势。这不是可选的——当模型供应商悄悄更新了模型导致质量下降时，只有 AI 专属监控能让你第一时间发现。

### 19.11.2 AI 应用的 SLO：不只有 Availability

传统 SLO 只有 Availability 和 Latency。AI 应用需要**额外两个维度**：

| SLO 维度               | 目标（示例）           | 含义       | 告警阈值      |
| -------------------- | ---------------- | -------- | --------- |
| **Availability**     | 99.9%            | 服务可用率    | < 99.5%   |
| **Latency**          | P95 < 3s（不含 LLM） | 框架层延迟    | P95 \> 5s |
| **Eval Score**       | 周均 ≥ 0.82        | 输出质量不退化  | 周均 < 0.78 |
| **Cost per Request** | ≤ \$0.05         | 单次请求成本可控 | \> \$0.08 |

**Eval Score 作为 SLO**：第十七章的 eval runner 定时跑（nightly），分数趋势就是 SLO 的一部分。如果周均从 0.85 跌到 0.78，即使代码没变，也需要排查——模型供应商更新了？知识库被污染了？Prompt 被其他 PR 改坏了？这就是 19.1 讲的「行为不只由代码决定」的防线。

**Cost per Request 作为 SLO**：第十六章的 `withTokenUsage` 记录每次请求的 token 消耗，聚合成每请求成本。成本异常上涨可能说明 prompt 变长了、模型变贵了、或者有循环在烧 token（第十五章的 DeepAgent 如果没有正确的停止条件，可能跑很多轮）。

### 19.11.3 告警不是越多越好

告警太多会导致告警疲劳，最终等同于没有告警。这个问题和第十八章的 Approval Fatigue 是同一个道理。

| 严重程度      | 告警方式           | 示例                       |
| --------- | -------------- | ------------------------ |
| **P0 紧急** | 电话 / PagerDuty | 服务不可用、数据库连不上             |
| **P1 重要** | Slack / 飞书     | 错误率 \> 5%、P95 \> 10s     |
| **P2 关注** | 邮件 / Dashboard | eval 分数下降、token 成本上涨 20% |
| **P3 信息** | 仅 Dashboard    | 新模型版本可用                  |

***

## 19.12 上线前的最后一道关：Production Checklist

![image 6.png](https://p3-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/89997dc8c934410ebeda5d7ed90c3143~tplv-k3u1fbpfcp-jj-mark:0:0:0:0:q75.image#?w=1672&h=941&s=1626228&e=png&b=050c4f)

前面讲的是方法和策略，真正发版前还需要一个可执行的检查清单。它的作用不是替代工程判断，而是避免在上线前漏掉低级但致命的问题。

### 构建与测试

*   [ ] &#x20;`bun run typecheck` 全绿
*   [ ] &#x20;`bun run lint` 全绿
*   [ ] &#x20;`bun run test` 全绿（Layer 1 pass，Layer 2 skip 正常）
*   [ ] &#x20;`bun run build` 全绿
*   [ ] &#x20;`docker build` 成功
*   [ ] &#x20;`docker compose up` 服务可起

### 数据库与迁移

*   [ ] &#x20;`prisma migrate deploy` 在空库上能跑通
*   [ ] &#x20;migration 向后兼容（只加列、不删列）
*   [ ] &#x20;生产数据库已备份

### 密钥与配置

*   [ ] &#x20;所有 secrets 已配置到部署平台（不在代码里）
*   [ ] &#x20;`.env.example` 与实际需要的环境变量一致
*   [ ] &#x20;模型配置（`langchain.yaml`）staging 与 prod 一致

### 质量与成本

*   [ ] &#x20;eval gate 通过（nightly 或手动触发）
*   [ ] &#x20;token 成本在预算内（Cost Gate）
*   [ ] &#x20;新 prompt/model 变更已在 staging 验证

### 部署与回滚

*   [ ] &#x20;回滚计划已确认（代码 / prompt / 模型 / 知识库 各自怎么回滚）
*   [ ] &#x20;蓝绿环境就绪 或 金丝雀比例已规划
*   [ ] &#x20;Smoke test 脚本就绪

### 监控与告警

*   [ ] &#x20;healthcheck 端点正常（`/ready` 返回 200）
*   [ ] &#x20;日志可查询（结构化 JSON、带 traceId）
*   [ ] &#x20;告警规则已配置（P0/P1）
*   [ ] &#x20;上线后值班人已确认

***

## 19.13 全景图：完整的 AI CI/CD 链路

![image 7.png](https://p6-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/6253db72e5e64864b2825c727464a3ee~tplv-k3u1fbpfcp-jj-mark:0:0:0:0:q75.image#?w=1672&h=941&s=1890111&e=png&b=020e34)

最后回到全局视角。前面的章节分别解决了测试、镜像、CI、部署、版本、监控和检查清单；这里用两张图把它们重新串成一条闭环。

第一张图把从开发到上线的路径压缩成一个工程交付闭环：

```mermaid
flowchart LR
  Developer["Developer"] --> Push["Git Push"]
  Push --> CI["CI<br>typecheck / lint / test"]
  CI --> Eval["Eval<br>quality + cost"]
  Eval --> Docker["Docker Build"]
  Docker --> Registry["Registry"]
  Registry --> Cloud["Cloud Runtime"]
  Cloud --> Canary["Canary"]
  Canary --> Observe["Observe"]
  Observe --> Feedback["Feedback / Rollback"]
```

![image.png](https://p1-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/147963986c0e447fba59b928102d5f34~tplv-k3u1fbpfcp-jj-mark:0:0:0:0:q75.image#?w=3921&h=188&s=51301&e=png&b=020817)

第二张图把 AI 应用特有的质量门禁、成本门禁、灰度发布和回滚放进同一条链路：

```mermaid
flowchart TB
  subgraph dev ["开发阶段"]
    Code["改代码 / Prompt / Skills / rubric"]
    Code --> Push["git push"]
  end
  
  subgraph ci ["CI 阶段（每次 PR）"]
    Push --> TC["typecheck"]
    TC --> Lint["lint"]
    Lint --> Migrate["migrate deploy"]
    Migrate --> Test["Layer 1 测试\n233 pass · 不花钱"]
    Test --> Build["build"]
    Build --> Merge["✅ 允许合并"]
  end
  
  subgraph eval_stage ["评估阶段（nightly）"]
    Merge --> Eval["Layer 2 LLM 评测"]
    Eval --> QG["Quality Gate"]
    Eval --> CostG["Cost Gate"]
  end
  
  subgraph deploy ["部署阶段"]
    QG --> Docker["Docker Build\n多阶段 · monorepo-aware"]
    CostG --> Docker
    Docker --> Registry["镜像仓库"]
    Registry --> Green["部署到绿环境"]
    Green --> SmokeEval["Smoke + Eval"]
    SmokeEval --> Canary["金丝雀放量\n5% → 20% → 100%"]
  end
  
  subgraph ops ["运营阶段"]
    Canary --> Monitor["监控\n延迟 · 错误率 · Eval Score · Token 成本"]
    Monitor -->|异常| Rollback["回滚\n代码 / Prompt / 模型 / 知识库"]
    Monitor -->|正常| Stable["稳定运行"]
    Stable --> Nightly["nightly eval\n持续守护质量"]
    Nightly -->|退化| Alert["告警 → 排查"]
  end
```

![image.png](https://p3-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/a5571d0492a34ba19a151b36ed923f3b~tplv-k3u1fbpfcp-jj-mark:0:0:0:0:q75.image#?w=1124&h=4912&s=302557&e=png&b=3c3e3e)

这张图里的每一个节点，本章都给出了实现方式、设计原则或适用边界。从开发到运营，从代码到模型到 prompt，从质量到成本——这是一条完整的 AI 应用持续交付链路。

***

## 19.14 前后章节的能力联动

| 前序能力                                    | 第十九章的消费方式                                                       |
| --------------------------------------- | --------------------------------------------------------------- |
| `/ready` 端点（16.8）                       | Dockerfile HEALTHCHECK + compose depends\_on + SLO Availability |
| `withTokenUsage` token 计量（16.6）         | Cost Gate + Cost per Request SLO                                |
| 结构化日志 + traceId（16.2-16.4）              | 生产日志可查询、请求可追踪                                                   |
| `run-eval.ts` 退出码（17.10）                | eval gate nightly job + Eval Score SLO                          |
| `rubrics/requirement-analysis.yaml`（17） | prompt 版本管理的一部分                                                 |
| 密钥脱敏 + .env 纪律（18.16）                   | CI secrets 走 GitHub Secrets；日志不泄密                               |
| Layer 1/Layer 2 分层（13-15 章）             | CI 天然只跑 Layer 1                                                 |
| `SKILL.md` 能力模板（13 章）                   | Prompt Version 管理，git 跟踪变更                                      |

***

## 19.15 本地可跑 vs 外部基建

| 能力                        | 本章状态                   | 说明                                     |
| ------------------------- | ---------------------- | -------------------------------------- |
| turbo test/lint pipeline  | ✅ 本地已验证                | `bun run typecheck/lint/test/build` 全绿 |
| GitHub Actions workflow   | ✅ 文件就绪                 | 实跑需推到 GitHub                           |
| monorepo-aware Dockerfile | ✅ 文件就绪                 | `docker build` 需 docker 环境             |
| compose 基础设施              | ✅ 文件就绪                 | `docker compose up` 需 docker           |
| eval gate                 | ✅ 脚本/workflow 就绪       | 需 secrets                              |
| 部署策略（蓝绿/金丝雀）              | ⚠️ 架构设计                | 需部署平台支持                                |
| 三态版本管理                    | ✅ Git 管理 prompt/config | Prompt Registry 为进阶                    |
| 监控与 SLO                   | ⚠️ 架构设计                | 需 Prometheus/Grafana 或 SaaS            |
| Production Checklist      | ✅ 就绪                   | 可直接使用                                  |

***

## 19.16 常见问题（FAQ）

**Q1：为什么 eval gate 不放进每次 PR？**

成本（每个 PR 都会消耗 token）、速度（不应该让文案改动等待 5 分钟）、波动（LLM 噪声可能误 fail 无关 PR）。放 nightly 既能守住质量趋势，又不会阻塞日常开发。

**Q2：Cost Gate 怎么实现？**

eval runner 跑完后，除了质量分数还统计总 token 消耗。与历史 baseline 对比，如果单请求成本上涨超过阈值（如 30%），退出码非 0。第十六章的 `withTokenUsage` 提供数据，eval runner 做聚合判断。

**Q3：蓝绿部署需要两倍的服务器吗？**

是的。但在云平台上，绿环境可以按需启动——验证通过后切流量，旧蓝环境释放。用 Cloud Run / Fargate 这种 serverless 容器，闲置环境几乎不花钱。

**Q4：金丝雀发布需要什么基础设施？**

最简单的金丝雀用负载均衡器的权重路由（如 Nginx upstream weight、AWS ALB weighted target group）。更成熟的用 Istio / Linkerd。本章给的是策略设计，具体实现取决于部署平台。

**Q5：Prompt 改了一行，需要走完整个 CI/CD 吗？**

应该走。Prompt 修改的影响可能比代码还大——它直接改变 LLM 的行为。走 PR review + nightly eval 是最低限度的安全保障。如果 prompt 在代码仓库里（本仓库就是），改 prompt = 改代码 = 走 CI。

**Q6：模型供应商悄悄更新了模型怎么办？**

这正是 nightly eval 存在的意义。即使你什么都没改，nightly eval 每天跑一次——如果模型供应商更新导致质量退化，eval 分数下降会触发告警。这是 19.1「行为不只由代码决定」的防线。

**Q7：Feature Flag 和金丝雀发布的区别？**

金丝雀控制的是**版本**——5% 用户用新版本，95% 用旧版本。Feature Flag 控制的是**功能**——所有用户用同一个版本，但 10% 用户开启了新功能。两者可以叠加使用。

**Q8：为什么不直接上 K8s？**

大多数团队真正的问题不是扩容，而是 Prompt 质量和模型成本。K8s 解决的是运维编排问题——测试分层、eval gate、三态版本管理，用 compose 还是 K8s 都一样。先用简单工具把 AI 特有的问题解决了，再考虑运维升级。

**Q9：SLO 的 Eval Score 怎么定？**

先跑一轮 baseline eval（当前版本的分数），作为基准线。阈值设为 baseline × 0.95（允许 5% 波动）。随着系统改进，baseline 上调。不要一开始就追求 0.95——先有 SLO、持续度量，比追求完美数字重要。

**Q10：Production Checklist 每次上线都要全部过一遍吗？**

日常小改动过核心项（CI 全绿 + 回滚计划 + 监控正常）。涉及模型/prompt/知识库变更的上线必须全过。建议在 GitHub 上创建 Release Issue Template，每次发版自动创建。

***

## 19.17 小结

本章的主线，是把一个「本地能跑」的 AI 应用，推进到「可以被持续交付、持续评估、持续运营」的状态：

1.  **AI 的三态**（19.1）——代码、模型、Prompt/Data 是三个独立变化的变量，传统 CI/CD 只管第一个。
2.  **质量门禁**（19.3）——turbo test/lint + CI 分层：每次 PR 跑确定测试，nightly 跑 eval + Cost Gate。
3.  **Docker**（19.4）——monorepo-aware 多阶段构建，从「跑不起来」到「一条命令构建镜像」。
4.  **基础设施**（19.5）——compose 补齐全部服务，migrate deploy 四条纪律。
5.  **CI**（19.6）——便宜先跑、贵后跑、失败早退。Quality Gate + Cost Gate。
6.  **部署策略**（19.8）——蓝绿（先验证再切流量）、金丝雀（逐步放量）、回滚（三态都要能回滚）。
7.  **部署平台**（19.9）——MVP 和小团队可优先考虑 Railway，生产环境根据规模迁移到 Cloud Run / ECS / Kubernetes，不必一开始就上 K8s。
8.  **三态版本管理**（19.10）——Prompt 走 Git + eval，Model 走影子模式 + 金丝雀，Knowledge 走索引快照。
9.  **监控与 SLO**（19.11）——传统四件套 + Eval Score + Cost per Request。
10. **Production Checklist**（19.12）——上线前照着勾。

很多人认为 CI/CD 的目标是自动部署。但对于 AI 应用来说，自动部署只是手段，真正的目标是：**确保每一次代码、Prompt、模型和知识库的更新，都不会降低系统质量。**

CI/CD 并不是 AI 工程的终点，而是生产环境质量保障体系的起点。相比传统软件，AI 应用每一次发布都可能涉及代码、Prompt、模型和知识库的共同演进，因此持续交付的核心已经从 Continuous Deployment 转向了 Continuous Evaluation。

这就是为什么第十七章的 eval runner 会在本章被反复消费：CI 门禁用它、部署验证用它、SLO 监控用它、回滚决策用它。**可评估性是 AI 应用工程化的基石。**

下一章是终点站：把前面所有章节的能力——RAG、MCP、Skills、DeepAgent，连同这四章的工程能力——全部接进生产主链路，跑出完整版本的 MVP。

## 写在最后

> 这里是**言萧凡的 AI 编程实验室**。本系列持续记录 AI 工具、编程实践与可复用的工程方法，尽量同时覆盖概念、代码和验证路径，帮助读者在真实项目中完成探索、实践与沉淀。

**欢迎通过微信号【Cookieboty】交流。**
