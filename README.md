<div align="center">
<h1>NexusWiki</h1>

<p><strong>多租户知识库与智能问答平台</strong><br/>让文档成为可检索、可推理、可追踪的智能助手</p>

[![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat&logo=docker&logoColor=ffffff)](docker-compose.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=ffffff)](package.json)
[![React](https://img.shields.io/badge/React-20232A?style=flat&logo=react&logoColor=61DAFB)](package.json)

[[快速开始]](#快速开始) · [[技术栈]](#技术栈) · [[配置示例]](.env.example)

</div>

## 简介

NexusWiki 是一个基于大模型的 RAG 知识助手平台。它将 **向量检索**、**BM25 全文检索**、**Neo4j 知识图谱**与 **PageIndex 章节树** 整合到同一条检索链路，并通过 **Mastra Agent** 编排问答、澄清和补充检索，生成带引用来源的回答。

平台提供文档导入与管理、多知识库统筹、助手配置与会话管理，支持按租户和用户组隔离知识访问范围。用户在 Web 工作台提问、查看引用、上传附件；开发者可通过 MCP 集成专用工具，并按需启用网络搜索和 Langfuse 追踪。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | React 19 · Vite · Tailwind CSS · Radix UI |
| 后端 | Node.js · TypeScript · Express · Mastra · MCP |
| 检索 | 向量 · BM25 · RRF 融合排序 · Rerank · PageIndex |
| 存储 | Elasticsearch · Neo4j · SQLite |
| 文档解析 | WeKnora DocReader · PyMuPDF · MarkItDown · 火山引擎 OCR（可选） |
| 可观测 | OpenTelemetry · Langfuse（可选）· Pino |
| 部署 | Docker Compose · Nginx |

## 快速开始

**前置要求**：已安装 Docker 与 Docker Compose ≥ 2.24，并准备可用的对话模型和 Embedding 服务。默认容器镜像使用 Node.js 24，文档转换依赖随镜像安装。

以下命令均在项目根目录执行。

**1. 初始化配置**

首次运行时复制环境文件；已有 `.env` 请保留原配置。

```bash
# Linux / macOS
cp .env.example .env
```

```powershell
# Windows PowerShell
Copy-Item .env.example .env
```

编辑 `.env`，填写模型服务信息：

| 配置 | 环境变量 | 说明 |
| --- | --- | --- |
| 对话模型 | `OPENAI_API_KEY` · `OPENAI_BASE_URL` · `OPENAI_CHAT_MODEL` | 使用兼容 OpenAI 接口的模型服务 |
| 向量模型 | `EMBEDDING_API_KEY` · `EMBEDDING_BASE_URL` · `EMBEDDING_MODEL` · `EMBEDDING_DIMENSIONS` | 密钥和地址留空时沿用对话服务；向量维度需与模型一致 |
| 专用重排（可选） | `RERANK_API_KEY` · `RERANK_BASE_URL` · `RERANK_MODEL` | 未配置时使用融合排序，并报告重排未启用 |
| 决策模型（可选） | `DECISION_API_KEY` · `DECISION_BASE_URL` · `DECISION_MODEL` | 用于澄清与补充检索决策；未配置时使用对话模型 |
| 本地登录（可选） | `DEMO_OIDC=1` · `ADMIN_LOGIN_ID` · `ADMIN_LOGIN_PASSWORD` | 启用本地账号登录并设置管理员凭据 |

示例配置使用 `MASTRA_RUNTIME_MODE=limited` 进行本地运行。Compose 会设置容器内的数据库地址与解析器路径，无需填写宿主机地址。

**2. 使用 Docker 启动**

> **已有数据请先迁移**：旧配置中的 Elasticsearch 数据位于容器可写层，Neo4j 使用匿名卷；新命名卷不会自动接管旧数据。已有知识库应先导出 ES 数据、备份并迁移 Neo4j 卷，再重建对应服务。

```bash
docker compose config --quiet
docker compose up -d --build
```

默认启动应用、前端、Elasticsearch、Neo4j 和 DocReader，应用会等待依赖通过健康检查。首次构建 DocReader 时会下载固定版本的 WeKnora 源码；已有同标签镜像可复用。

**3. 访问平台**

等待启动完成后，浏览器打开 **http://localhost:8080**。启用本地登录后，使用配置的管理员账号登录；其他用户可在登录页面注册。

> 💡 Langfuse 默认不启动。需要追踪时，可执行 `docker compose --profile observability up -d`，填写匹配的 Langfuse 项目密钥并设置 `TRACING_ENABLED=1`。修改 `.env` 后，执行 `docker compose up -d --force-recreate app` 重新注入配置。

<details>
<summary>数据持久化与部署说明</summary>

- SQLite、附件、图片、本地登录签名密钥与页面保存的模型配置保存在 `app-data` 卷，应用日志保存在 `app-logs` 卷。ES、Neo4j 和可观测存储使用各自的数据卷。
- 页面保存的模型配置写入数据卷内的 `model-settings.env`，重启后优先于初始 `.env` 中的同名配置。已有保存值时，可在页面修改；本机 `.env` 不会随页面保存而改变。
- `MASTRA_RUNTIME_MODE=default` 保留发布门禁，需将真实通过的 V2 发布凭据放到 `.release-artifacts/promotion.json`。凭据以只读方式挂载，缺失或无效时应用拒绝启动。
- 核心服务内存上限合计约 7.125 GiB，属于上限而非预留；可选 Langfuse 栈会增加资源消耗。应用后端以非 root 用户运行，Nginx 提供静态文件与 API 代理，并关闭 SSE 缓冲。
- Web、API 和基础设施端口默认只绑定本机。需要其他机器访问时，设置 `WEB_BIND_ADDRESS=0.0.0.0`，并配置 HTTPS 与登录凭据。可观测栈默认账号用于本机演示。
- 宿主端口可通过 `.env` 的 `WEB_PORT`、`API_HOST_PORT`、`ES_HOST_PORT`、`NEO4J_HTTP_HOST_PORT`、`NEO4J_BOLT_HOST_PORT` 等变量调整。Langfuse 端口变更时，同时调整浏览器访问地址 `LANGFUSE_PUBLIC_URL` 和 `LANGFUSE_MEDIA_PUBLIC_URL`；外部 Langfuse 使用 `DOCKER_LANGFUSE_BASE_URL`。

```bash
# 查看应用日志
docker compose logs --tail=100 app web

# 停止服务并保留数据卷；保留数据时不要添加 -v
docker compose --profile observability down
```

</details>

<details>
<summary>本地开发</summary>

前置要求：Node.js ≥ 22.13、npm、Docker；本机 PDF 与 Office 转换还需 Python 3 及 [解析依赖](docker/requirements.txt)。

先按上方说明准备 `.env`，再启动基础设施：

```bash
docker compose -f docker-compose.op-stack.yml up -d elasticsearch neo4j
docker compose -f docker-compose.docreader.yml up -d --build
npm ci
```

在 `.env` 中设置 `ES_NODE=http://localhost:9201`、`NEO4J_URI=bolt://localhost:17687`、`NEO4J_USER=neo4j`，并填写与 Compose 一致的 `NEO4J_PASSWORD`（默认 `localpassword`）。使用 DocReader 时，`DOCREADER_ADDR` 为 `127.0.0.1:50051`。

本机使用 PyMuPDF 或 MarkItDown 时，先创建并激活 Python 虚拟环境，再执行 `python -m pip install -r docker/requirements.txt`；`PYTHON_COMMAND` 与 `MARKITDOWN_COMMAND` 应能找到该环境内的命令。

分别在两个终端运行：

```bash
# 终端 1：后端，默认 3001 端口
npm run dev
```

```bash
# 终端 2：前端，默认 3000 端口
npm run dev:web
```

前端端口被占用时，Vite 会选择其他端口，以终端输出为准。运行 `npm run build` 构建后端，`npm run build:web` 构建前端。

`GET /api/status` 提供服务与模型诊断，会探测外部依赖。运行日志默认输出单行 JSON，并在 `logs/` 写入按天轮转的 `system-YYYY-MM-DD.log` 和 `agent-YYYY-MM-DD.log`，保留最近 7 个自然日。设置 `LOG_FILE=off` 仅保留标准输出，`LOG_LEVEL=off` 关闭日志。

</details>

<details>
<summary>演示数据</summary>

```bash
# 播种确定性演示命名空间，可重复执行
npm run demo:seed

# 预览重置；追加 -- --confirm 后执行并重新播种
npm run demo:reset
```

演示文档均为明确标注的虚构内容，用于检索、权限隔离与拒答能力演示。

</details>

## 仓库内容

公开仓库保留前后端源码、构建配置、容器配置、运行维护脚本、`.env.example`，以及 `AGENTS.md` 和本文件。测试、验收探针、任务票据、本地交接记录、浏览器配置、日志与数据库不在上传范围内。

`.gitignore` 使用根目录白名单。新增顶层文件需要先明确是否属于运行主体，再调整白名单；不要强制添加被忽略的本地文件。真实环境配置只写入本机 `.env` 或运行环境，`.env.example` 仅用于配置模板。

安装后可执行以下检查，均不需要测试票据或本地开发记录：

```bash
npm run build
npm run typecheck:web
npm run build:web
```

`npm run docreader:check` 用于检查已启动的 DocReader；`npm run migrate:chunks -- --source OLD --target NEW --report .tmp/chunk-migration.json` 默认仅预览索引迁移。添加 `--apply` 才执行迁移。`npm run release:promotion-check -- ARTIFACT REVISION` 只校验已有发布凭据；生产启动门禁仍然保留。

## 致谢

感谢以下开源项目为本项目提供的框架、服务与工具：

- [Mastra](https://github.com/mastra-ai/mastra) — Agent 编排与 MCP 集成
- [Elasticsearch](https://github.com/elastic/elasticsearch) — 向量与全文检索
- [Neo4j](https://github.com/neo4j/neo4j) — 知识图谱存储
- [WeKnora](https://github.com/Tencent/WeKnora) — DocReader 文档解析服务
- [MarkItDown](https://github.com/microsoft/markitdown) — Office 文档转换
- [PyMuPDF](https://github.com/pymupdf/PyMuPDF) — PDF 提取与页面预览

---

<div align="center">

**如果这个项目对您有帮助，欢迎给我们一个 ⭐️**

</div>
