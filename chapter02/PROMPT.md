请在当前仓库从零搭建一个 pnpm workspaces monorepo，结构与要求如下，并严格按顺序完成（先底座，再共享包，再 chat-web，再 chat 服务，再联通，再 compose）。

要求：

1. 根目录：
   - 目录结构：clients/、services/、packages/contracts/src、infra/compose
   - pnpm-workspace.yaml：packages 包含 ["clients/*", "services/*", "packages/*"]
   - package.json：packageManager="pnpm@10.0.0"（或当前最新版本）；scripts 包含 dev, dev:chat-web, dev:chat, build, typecheck；跨包任务由 turbo 驱动，单包操作使用 `pnpm --filter <包名> <脚本>`
   - turbo.json：dev 任务配置 "cache": false, "persistent": true；build 任务配置 "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**", "!.next/cache/**"]；声明 typecheck 任务
   - tsconfig.base.json：配置 paths，@autix/contracts 指向 packages/contracts/src/index.ts

2. packages/contracts（共享包，采用编译产物模式）：
   - package.json：name="@autix/contracts", private=true, main="dist/index.js", types="dist/index.d.ts"，scripts 包含 "build": "tsc" 和 "typecheck": "tsc --noEmit"
   - tsconfig.json：extends 根 tsconfig.base.json，module="commonjs", outDir="dist", rootDir="src", declaration=true
   - src/index.ts：导出常量 APP_NAME = "llm"

3. clients/chat-web（Next.js，App Router）：
   - 使用 `pnpm create next-app clients/chat-web --yes` 初始化
   - package.json：name="@autix/chat-web"，依赖引用 "@autix/contracts": "workspace:*"，scripts dev 设置为 "next dev --port 3002"
   - next.config.ts：设置 output: "standalone", outputFileTracingRoot 指向仓库根目录（`path.join(__dirname, "../../")`），设置 NEXT_PUBLIC_API_BASE_URL 默认指向 http://localhost:4001
   - app/page.tsx：展示 APP_NAME，并提供按钮调用 Chat 服务

4. services/chat（NestJS）：
   - 使用 `pnpm dlx @nestjs/cli new services/chat --skip-install` 初始化，依赖统一交给 pnpm 处理
   - package.json：name="@autix/chat"，依赖引用 "@autix/contracts": "workspace:*"
   - 监听端口 4001（Nest 默认 3000，需显式修改）
   - main.ts 启用 CORS，放行 http://localhost:3002
   - app.controller.ts / app.service.ts：
     - GET /health 返回 { ok: true }
     - GET /hello 返回 { message: `Hello from Chat, shared APP_NAME=${APP_NAME}` }

5. Web 调用 Chat 服务：
   - Web 页面点击按钮 fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL}/hello`) 并展示返回的 message
   - 处理跨域（二选一）：Nest 开启 CORS；或 Next rewrites 把 /api/* 转发到 http://localhost:4001，前端请求写成 fetch("/api/hello")

6. Compose 与 Dockerfile：
   - infra/compose/Dockerfile.chat 与 Dockerfile.web：基于 `node:22-alpine`，通过 `RUN corepack enable` 使用 pnpm，构建时执行 `pnpm install --frozen-lockfile` 和 `pnpm run build`
   - infra/compose/compose.yaml：chat-web 映射 3002，chat 映射 4001；chat 配置访问 /health 的 healthcheck；chat-web 配置 depends_on: chat (condition: service_healthy)
   - infra/compose/compose.dev.yaml：挂载源码卷实现本地热更新

交付要求：

- 生成所有必要文件与配置
- 根目录执行 `pnpm install`、`pnpm dev` 可正常编译并启动
- 打开 http://localhost:3002，点击按钮能成功渲染 Chat 服务返回的数据
- 每完成一步，输出你修改/新增了哪些文件（按步骤 1→6 汇报）
- 遇到报错：保留原始错误信息，优先进行最小化修复，严禁跳步

