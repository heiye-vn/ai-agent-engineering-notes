# Chapter 02 · 搭建智能体的工程底座（pnpm 版）

> 来源：掘金小册《AI Agents 开发实践》第二章（作者：言萧凡 / CookieBoty）
> 原文基于 Bun workspaces，本笔记已全部转换为 **Node + pnpm** 工作流，可直接在本仓库技术栈上落地。
> 本章分支（原文参考）：[feat/foundation](https://github.com/Cookieboty/autix-demo/tree/feat/foundation)
> 落地工程：已抽为独立 git 仓库 [autix](https://github.com/heiye-vn/autix)，本笔记即其设计文档与演进记录。

---

## 一、本章解决什么问题

第一章解决的是"怎么把模型用起来"（模型调用、Prompt 设计、结构化输出）。
第二章把问题升级为：**能力如何落地为可持续演进的系统**。

- 这些能力放在前端还是后端？前后端如何分工、如何对齐接口？
- 共享的类型、schema、DTO 应该沉淀在哪里？
- 后续加入工具调用、RAG、MCP、多 Agent 编排时，结构还能不能顺滑扩展而不推倒重来？

核心方法论：**先搭一个能跑、能验证、能复用的底座，再往上加能力。**

---

## 二、为什么从一开始就选 monorepo

### 2.1 跨层接口约定会一起变

类型、schema、DTO、工具参数往往同时出现在客户端、服务端和共享层。拆多仓库意味着一次字段调整要：

- 在多个仓库分别改代码
- 分别发版与升级依赖
- 处理版本不一致带来的兼容窗口

monorepo 里一次提交搞定，接口约定更容易保持一致。

### 2.2 共享代码更"自然"

多仓库的共享包（shared / utils / sdk / prompts）必须走"发布 → 安装"链路，会持续产生成本：升级滞后、重复实现、为兼容旧版本维护分支。

monorepo 用 workspace 直连，消除重复与漂移。

### 2.3 系统扩张不需要二次迁移

现在可能只有 web + api，将来会有 worker、agent-runtime、prompt 包、sdk 包。多仓库会膨胀成网状依赖；monorepo 能承接扩展。

**选择 monorepo 是为了三件事：共享代码更自然、跨项目改动更原子化、依赖与接口定义更一致。**

代价客观存在：仓库规则、边界约束、任务编排变得更重要——这不是缺点，是**把复杂度提前显式化**。

---

## 三、技术栈选择：pnpm + Next + Nest + Turbo + Compose

原文选 Bun 的理由是"runtime + 包管理 + workspaces 一条链路"，但也明确说了：
> 如果是公司级、追求稳定的项目，使用传统的 pnpm 或 yarn 作为基座会更稳妥。

pnpm 版的选型逻辑：

| 工具 | 解决什么问题 | 关键点 |
|------|------------|--------|
| **pnpm** | workspaces + 依赖管理 | 严格的 symlink 结构 node_modules，**天然就是 isolated installs**，monorepo 里隐性依赖比 npm/yarn 更少；`workspace:*` 协议直连本地包；`catalog` 统一版本 |
| **Next.js** | 客户端交付 | React 生态成熟；直接消费共享包编译产物；开发到部署闭环；shadcn + Tailwind 在模型训练语料中常见，AI 辅助开发体感更好 |
| **NestJS** | 服务端承载 | 模块化 + 依赖注入，适合承载持续增长的复杂度（模型调用、工具、RAG、运行时） |
| **Turbo** | 任务编排与缓存 | `turbo.json` 定义任务依赖图，`build` 依赖 `^build`，增量构建 |
| **Docker Compose** | 多服务启动编排 | healthcheck + depends_on 控制启动顺序 |
| **YAML** | 应用配置与环境覆盖 | 配置文件驱动，而不是散落的 .env |

选型标准只有三条：以 TS + monorepo 为前提；优先"能稳定跑起来"而不是最潮；给后续 Agent 能力扩展留空间。

---

## 四、工程结构与目录约定

```
ai-agent-playground/
├── clients/            # 客户端应用
│   └── chat-web/       # Next.js（端口 3002）
├── services/           # 服务进程
│   └── chat/           # NestJS（端口 4001）
├── packages/           # 共享子包
│   └── contracts/      # 常量 / 类型 / DTO / schema
├── infra/
│   └── compose/        # compose.yaml + Dockerfile
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
└── package.json
```

三层职责：

- `clients/`：面向用户的界面，只做展示与交互
- `services/`：智能体复杂度累积的地方（模型调用、工具、RAG、运行时）
- `packages/`：跨端共享的唯一事实来源（single source of truth）

---

## 五、从 0 搭到跑通（pnpm 实操）

### 5.1 仓库底座

**1）`pnpm-workspace.yaml`**（pnpm 的 workspace 定义，不写在 package.json 里）：

```yaml
packages:
  - clients/*
  - services/*
  - packages/*

# 可选：pnpm >= 9.5 支持 catalog，统一收敛依赖版本（对应 Bun 的 catalogs）
# catalog:
#   typescript: ^5.7.0
```

**2）根 `package.json`**：

```json
{
  "name": "autix",
  "version": "0.0.0",
  "private": true,
  "packageManager": "pnpm@10.0.0",
  "scripts": {
    "dev": "turbo run dev",
    "dev:chat-web": "pnpm --filter @autix/chat-web dev",
    "dev:chat": "pnpm --filter @autix/chat dev",
    "build": "turbo run build",
    "typecheck": "turbo run typecheck"
  },
  "devDependencies": {
    "turbo": "^2.3.0"
  }
}
```

要点：
- `packageManager` 字段让 Turbo / corepack 自动识别 pnpm
- 单包操作用 `pnpm --filter <pkg> <script>`，比 turbo 更轻量；跨包任务图交给 turbo

**3）`turbo.json`**：

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**", "!.next/cache/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "typecheck": {}
  }
}
```

要点：`dev` 不缓存且 persistent；`build` 依赖上游先构建，产物目录要声明才能命中缓存。

**4）根 `tsconfig.base.json`**（TS 基线收敛在根目录，子项目只做最小差异化）：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  }
}
```

> ⚠️ **基线只放「不冲突」的公共项**：`module` / `moduleResolution` 不能写进 base——Next 要 `esnext`+`bundler`，Nest 要 `commonjs`，两者互斥，只能由各子包自定。
>
> ⚠️ **base 里不要写 `paths` 指向共享包源码**：在「编译产物」模式下，`@autix/contracts` 应通过 `node_modules` 链接解析到 `dist/`。若 base 里用 `paths` 指向 `src/index.ts`，Nest 编译时会把 contracts 源码一起拉进输入，`rootDir` 被推断成仓库根，产物错误地输出到 `dist/services/chat/src/main.js`（而非 `dist/main.js`）。这也是「编译产物模式」比「源码直连 + paths」更省心的原因之一。

> pnpm 说明：Bun 需要 `bunfig.toml` 开 `linker="isolated"` 来隔离依赖；**pnpm 默认就是严格的 symlink 结构**，天然防止子项目引用未声明的依赖，无需额外配置。

**5）安装依赖**：

```bash
pnpm install
```

### 5.2 共享包 `packages/contracts`

**`packages/contracts/package.json`**：

```json
{
  "name": "@autix/contracts",
  "version": "0.1.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.7.0"
  }
}
```

**`packages/contracts/tsconfig.json`**：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "commonjs",
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

**`packages/contracts/src/index.ts`**：

```ts
export const APP_NAME = "llm";
```

为什么最先建共享包：一旦前后端能在编译期依赖同一份定义，后续 API 调用、表单校验、DTO、工具参数都持续复用，避免两端各自复制粘贴、越走越分叉。

> ⚠️ **共享包用「编译产物」模式，而非源码直连**（`main`/`types` 指向 `dist/`）：因为消费方是异质的——Next 是 ESM/bundler，Nest 是 CommonJS。若 `main` 指向 `src/index.ts`，Nest 编译后的 `node dist/main.js` 在运行时无法 `require` 一个 `.ts` 文件。输出 CommonJS + `.d.ts` 对双方都友好。代价是：改 contracts 后要手动 `pnpm --filter @autix/contracts build`，且 Turbo 的 `build.dependsOn ["^build"]` 要保证它先构建。既然走编译产物，Next 端就**不需要** `transpilePackages` 了（那只用于转译 TS 源码包）。

### 5.3 前端 `clients/chat-web`（Next.js）

**初始化**（对应原文的 `bun create next-app`）：

```bash
pnpm create next-app clients/chat-web --yes
```

**`clients/chat-web/package.json`**（关键点：包名统一、依赖 `workspace:*` 直连共享包）：

```json
{
  "name": "@autix/chat-web",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "dev": "wait-on tcp:4001 && next dev --port 3002",
    "build": "next build",
    "start": "next start --port 3002",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@autix/contracts": "workspace:*",
    "next": "^16.2.3",
    "react": "^19.2.4",
    "react-dom": "^19.2.4"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4.0.0",
    "@types/node": "^22",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.7.0",
    "wait-on": "^9.0.5"
  }
}
```

**`clients/chat-web/tsconfig.json`**：extends 根基线，按 Next 项目需要补 `jsx`、`plugins` 等。

**`clients/chat-web/next.config.ts`**（monorepo 必配项）：

```ts
import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../../"),
  env: {
    NEXT_PUBLIC_API_BASE_URL:
      process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4001",
  },
};

export default nextConfig;
```

> ⚠️ **必须设置 `outputFileTracingRoot`**：否则 standalone 构建时，仓库外层的共享包不会进入 tracing 范围——典型症状是 dev 能跑、build 产物缺文件。

**最小页面 `clients/chat-web/app/page.tsx`**：

```tsx
"use client";
import { useState } from "react";
import { APP_NAME } from "@autix/contracts";

export default function Home() {
  const [result, setResult] = useState<string>("");

  async function callApi() {
    const res = await fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL}/hello`);
    const data = await res.json();
    setResult(data.message);
  }

  return (
    <main style={{ padding: 24 }}>
      <h1>{APP_NAME}</h1>
      <button onClick={callApi}>调用 API</button>
      <pre style={{ marginTop: 16 }}>{result}</pre>
    </main>
  );
}
```

新增 workspace 依赖后重新安装并启动：

```bash
pnpm install
pnpm dev   # 根脚本会同时启动 chat 与 chat-web
```

> ⚠️ 浏览器端只能读到 `NEXT_PUBLIC_` 前缀的环境变量。

### 5.4 服务端 `services/chat`（NestJS）

**初始化**（对应原文的 `bunx @nestjs/cli new`）：

```bash
pnpm dlx @nestjs/cli new services/chat --skip-install
pnpm install
```

> `--skip-install` 让 nest CLI 跳过它自带的 npm 安装，统一交给 pnpm 处理 workspace 依赖。

**`services/chat/package.json`**（关键点：运行入口用 node 而非 bun）：

```json
{
  "name": "@autix/chat",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "dev": "nest start --watch",
    "build": "rimraf dist tsconfig.tsbuildinfo && nest build",
    "start": "node dist/main.js",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@autix/contracts": "workspace:*",
    "@nestjs/common": "^11.0.0",
    "@nestjs/core": "^11.0.0",
    "@nestjs/platform-express": "^11.0.0",
    "reflect-metadata": "^0.2.0",
    "rxjs": "^7.8.0"
  },
  "devDependencies": {
    "@nestjs/cli": "^11.0.0",
    "@nestjs/schematics": "^11.0.0",
    "@types/express": "^5.0.0",
    "@types/node": "^22.0.0",
    "rimraf": "^6.0.0",
    "typescript": "^5.7.0"
  }
}
```

**两个最小路由**（各司其职）：

- `GET /health`：给 Compose / 监控提供稳定探针
- `GET /hello`：验证"共享包 + API 返回 + 前端消费"的最小闭环

`services/chat/src/app.controller.ts`：

```ts
import { Controller, Get } from "@nestjs/common";
import { AppService } from "./app.service";

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get("health")
  getHealth() {
    return this.appService.getHealth();
  }

  @Get("hello")
  getHello() {
    return this.appService.getHello();
  }
}
```

`services/chat/src/app.service.ts`：

```ts
import { Injectable } from "@nestjs/common";
import { APP_NAME } from "@autix/contracts";

@Injectable()
export class AppService {
  getHello(): { message: string } {
    return { message: `Hello from Chat, shared APP_NAME=${APP_NAME}` };
  }

  getHealth(): { ok: boolean } {
    return { ok: true };
  }
}
```

**端口改为 4001 + 放行跨域**，`services/chat/src/main.ts`：

```ts
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: process.env.CORS_ORIGIN || "http://localhost:3002",
    credentials: true,
  });
  const port = process.env.PORT ?? 4001;
  await app.listen(port);
  console.log(`Chat service running on http://localhost:${port}`);
}
bootstrap();
```

验证：

```bash
curl http://localhost:4001/hello   # Hello from Chat...
curl http://localhost:4001/health  # { "ok": true }
```

先不接模型是**刻意的**：这一步只要"服务能跑、路由能通、共享包能引用、前端能调到后端"。接什么模型都是在这条链路上加能力。

### 5.5 前后端联通

跨域两种方案，任选其一：

**方案 A：Nest 开 CORS**（见 5.4 的 `enableCors`，最简单）

**方案 B：Next 反向代理**（浏览器看到同域，不触发 CORS）：

```ts
// clients/chat-web/next.config.ts
async rewrites() {
  return [
    { source: "/api/:path*", destination: "http://localhost:4001/:path*" },
  ];
},
```

前端请求改为 `await fetch("/api/hello")`。

根目录一条命令启动整条链路：

```bash
pnpm dev
```

**验收标准**：打开 `http://localhost:3002` → 点"调用 API"按钮 → 页面显示 Chat 服务返回的 message。
"联通"不是一句话——必须在浏览器里看到**请求发出、响应回来、页面更新**才算跑通。

### 5.6 Docker Compose 系统化启动

**`infra/compose/compose.yaml`**：

```yaml
services:
  chat:
    build:
      context: ../..
      dockerfile: infra/compose/Dockerfile.chat
    ports:
      - "4001:4001"
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:4001/health"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 10s

  chat-web:
    build:
      context: ../..
      dockerfile: infra/compose/Dockerfile.web
    ports:
      - "3002:3002"
    depends_on:
      chat:
        condition: service_healthy
```

**开发覆盖文件 `infra/compose/compose.dev.yaml`**（挂载源码热更新）：

```yaml
services:
  chat:
    command: pnpm run dev
    volumes:
      - ../../services/chat/src:/app/services/chat/src
      - ../../packages/contracts:/app/packages/contracts
  chat-web:
    command: pnpm run dev
    volumes:
      - ../../clients/chat-web:/app/clients/chat-web
      - ../../packages/contracts:/app/packages/contracts
```

**`Dockerfile.chat`**（node 镜像 + corepack 启用 pnpm）：

```dockerfile
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=base /app/services/chat/dist ./dist
EXPOSE 4001
CMD ["node", "dist/main.js"]
```

**`Dockerfile.web`**（Next 已开 standalone，最终镜像不需要全量 node_modules）：

```dockerfile
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=base /app/clients/chat-web/.next/standalone ./
COPY --from=base /app/clients/chat-web/.next/static ./clients/chat-web/.next/static
COPY --from=base /app/clients/chat-web/public ./clients/chat-web/public
EXPOSE 3002
CMD ["node", "clients/chat-web/server.js"]
```

启动：

```bash
docker compose -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml up --build
```

> 注：standalone 产物中 `server.js` 的相对位置与 tracing root 有关，若启动报路径错误，以 `ls .next/standalone` 实际结构为准调整 COPY 与 CMD。

---

## 六、用 AI 代理复现整个流程（Prompt 已换为 pnpm 版）

原文 2.9 的核心观点：**手动搭建的价值在于理解边界与关键配置；当规则固定后，重复劳动交给代理。**

### 写"可控 Prompt"的六段结构

1. **角色与工作方式**：指定身份 + 强制过程化（按步骤执行、每步汇报、报错先贴日志）
2. **目标**：1–3 句话写清交付形态，用可验证目标（端口/命令/页面效果）替代泛目标
3. **约束**：目录结构、命名、端口、脚本入口、必须/禁止使用的工具链
4. **分步计划**：4–8 步，每步含前置条件、产物、验收方式；顺序符合依赖关系
5. **交付格式**：变更清单 + 运行命令序列
6. **失败处理**：保留报错原文、不跳步、最小修复再继续

> 经验法则：Prompt 里最值钱的不是"描述想要什么"，而是把**边界、顺序、验收**写清楚。

### 完整 Prompt（pnpm 版，可直接粘贴给 Claude CLI / 其他代理）

```markdown
请在当前仓库从零搭建一个 pnpm workspaces monorepo，结构与要求如下，
并严格按顺序完成（先底座，再共享包，再 chat-web，再 chat 服务，再联通，再 compose）。

要求：

1. 根目录：
   - 目录：clients/ services/ packages/contracts/src infra/compose
   - pnpm-workspace.yaml：packages 包含 clients/*、services/*、packages/*
   - package.json：packageManager=pnpm@<你的版本>；scripts 包含
     dev/dev:chat-web/dev:chat/build/typecheck，跨包任务通过 turbo 驱动，
     单包操作用 pnpm --filter <包名> <脚本>
   - turbo.json：dev 不缓存且 persistent；build dependsOn ["^build"] 且
     outputs 包含 dist/** 和 .next/**
   - tsconfig.base.json：配置 paths，@autix/contracts 指向
     packages/contracts/src/index.ts

2. packages/contracts：
   - package.json（name=@autix/contracts，private）+ tsconfig.json + src/index.ts
   - 导出常量 APP_NAME="llm"

3. clients/chat-web（Next.js，app router）：
   - 使用 pnpm create next-app 初始化
   - package.json name=@autix/chat-web，依赖引用
     "@autix/contracts":"workspace:*"
   - next.config.ts 必须设置 output="standalone"、outputFileTracingRoot 指向仓库根，
     并设置 NEXT_PUBLIC_API_BASE_URL 默认指向 http://localhost:4001
     （共享包走编译产物，无需 transpilePackages）
   - app/page.tsx 显示 APP_NAME，并提供按钮调用 Chat 服务

4. services/chat（NestJS）：
   - 使用 pnpm dlx @nestjs/cli new 初始化（--skip-install，依赖统一由 pnpm 安装）
   - package.json name=@autix/chat，依赖引用
     "@autix/contracts":"workspace:*"
   - 监听端口 4001（Nest 默认 3000，需显式修改）
   - GET /health 返回 { "ok": true }
   - GET /hello 返回 { "message": "Hello from Chat, shared APP_NAME=" + APP_NAME }

5. Web 调用 Chat 服务：
   - Web 页面点击按钮后 fetch /hello 并展示返回的 message
   - 处理跨域（二选一）：Nest 只放行 http://localhost:3002；
     或 Next rewrites 把 /api/* 转发到 http://localhost:4001，
     前端请求写成 fetch("/api/hello")

6. Compose：
   - infra/compose/compose.yaml：chat-web 暴露 3002，chat 暴露 4001；
     chat 的 healthcheck 访问 /health；chat-web depends_on chat 且
     condition 为 service_healthy
   - 提供开发覆盖文件 compose.dev.yaml（挂载源码）
   - Dockerfile 基于 node:22-alpine，通过 corepack enable 使用 pnpm，
     安装使用 pnpm install --frozen-lockfile

交付要求：

- 生成所有必要文件
- 根目录 pnpm install、pnpm dev 可运行
- 打开 http://localhost:3002，点击按钮能展示 Chat 服务返回的 message
- 每一步完成后，输出你修改/新增了哪些文件（按步骤 1→6 汇报）
- 遇到报错：保留报错原文，先最小修复再继续，不要跳步
```

使用方式：新建空目录，把 Prompt 存为 `PROMPT.md`，在代理 CLI 中作为任务说明执行。

### 进一步沉淀为可复用步骤

- 第一次：用 Prompt 跑通
- 第二次：拆成可复用步骤（初始化底座 / 加 Next / 加 Nest / 加 Compose）
- 第三次起：直接调用对应 skill，让代理按同样规则扩展工程

---

## 七、Bun → pnpm 转换速查表

| 原文（Bun） | pnpm 版 | 说明 |
|------------|---------|------|
| `package.json` 的 `workspaces` 字段 | `pnpm-workspace.yaml` | pnpm 的 workspace 定义文件 |
| `bunfig.toml` 开 `linker="isolated"` | 无需配置 | pnpm 默认就是严格 symlink 结构 |
| `catalog` / `catalogs` | `pnpm-workspace.yaml` 的 `catalog:` | pnpm ≥ 9.5，子包用 `"typescript": "catalog:"` 引用 |
| `packageManager: "bun@x"` | `packageManager: "pnpm@x"` | corepack / turbo 识别用 |
| `bun install` | `pnpm install` | |
| `bun create next-app <dir>` | `pnpm create next-app <dir>` | |
| `bunx @nestjs/cli new <dir>` | `pnpm dlx @nestjs/cli new <dir> --skip-install` | 统一交给 pnpm 装依赖 |
| `bun run dev` | `pnpm dev` / `pnpm --filter <pkg> dev` | 根脚本内部走 turbo |
| `bun run dist/main.js` | `node dist/main.js` | 运行编译产物 |
| `FROM oven/bun:1-alpine` | `FROM node:22-alpine` + `RUN corepack enable` | 镜像内启用 pnpm |
| `workspace:*` | `workspace:*` | 协议相同 |

---

## 八、本章总结

把本章的递进理解为三层：

1. **第一层：把结构搭对**——目录、边界、依赖（monorepo 三层：clients / services / packages）
2. **第二层：把链路跑通**——Web ↔ Chat 服务 ↔ 共享包 ↔ Compose，每层都有可见的验证点
3. **第三层：把流程固化**——写成 Prompt，让代理可重复执行

> 下一章开始，模型调用、工具调用、记忆、RAG、多智能体流程都沿用同样的方式递进：
> **先落在正确的层，再跑通最小闭环，再把流程固化。**
