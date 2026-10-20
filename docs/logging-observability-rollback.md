# 日志与追踪：运维配置、启停与回退

更新：2026-10-20  
对应执行票：`.scratch/logging-observability-tickets/`（LO-01–20）

## 1. 三条链路各自负责什么

| 链路 | 出口 | 故障时的影响 | 能否单独关闭 |
|---|---|---|---|
| 运行日志 | 中性 Logger → Pino → stdout | 接受背压；写错显式报告；不影响响应 | 能：`LOG_LEVEL=off` |
| 产品事件 | `AnswerRunEvent` → 现有 SQLite 仓储 | 沿用既有失败契约；与追踪无关 | 否（产品功能） |
| 追踪 | 中性 Operation/Model 契约 → OTel → OTLP → Langfuse | 队列满丢新 span；导出失败只记诊断；业务不等待 | 能：`TRACING_ENABLED=0` |

追踪只写 Trace / Span / Generation；不接 OTel Logs/Metrics，不承担审计、LLM 调试文件、产品存储或评测。

## 2. 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `TRACING_ENABLED` | 关闭 | 只接受 `1` / `true` |
| `LANGFUSE_BASE_URL` | 空 | 例如 `http://localhost:3000` |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | 空 | 缺一即关闭追踪 |
| `LANGFUSE_SAMPLE_RATE` | `1` | 0–1；非法值或 0 直接关闭并给 warning |
| `OTEL_SERVICE_NAME` | `kefu-rag` | 资源属性 |
| `LOG_LEVEL` | `info` | `off` 时不输出运行日志 |

追踪默认关闭；只有四项都合法才启用。根采样只掷一次，子操作继承。

## 3. 启用（三阶段，可独立）

1. **日志**：默认已启用。确认 stdout 可消费即可；慢消费会被背压而不是丢日志。
2. **追踪基础**：部署 Langfuse v3（需要 worker），设置上述 4 个变量，`TRACING_ENABLED=1`。重启后访问任一白名单接口，响应头出现 `x-trace-id`。
3. **模型内容**：随追踪一起生效；Generation 内容上限 1 MiB/字段，8 KiB 只约束运行日志。

本地栈（开发用）：

```bash
docker compose -f docker-compose.op-stack.yml up -d langfuse langfuse-worker
```

## 4. 关闭与回退

| 目标 | 操作 | 需要迁移/重写数据吗 |
|---|---|---|
| 只关追踪 | `TRACING_ENABLED=0`（或删掉任一凭据）并重启 | 不需要。历史任务里的 `trace` 字段停留在旧行，新执行按根策略 |
| 只关运行日志 | `LOG_LEVEL=off` 并重启 | 不需要 |
| 完全回退到接入前 | 上述两项同时设置 | 不需要。SQLite 只增加了可空列：`task_pending_ops.payload.trace`（JSON 内字段）、`sync_runs.trace_*`、`wiki_jobs.trace_*` |

关闭后：

- 业务答案、引用、产品 SQLite 事件、任务状态、预算与取消语义保持不变；
- 不产生新 span，不补开根，不再重试导出；
- 已入队未导出的 span 在关闭预算内 flush，超时后丢弃并计数（`diagnostics().droppedPending`）。

## 5. 验证清单

```bash
# 关闭状态：不应出现 x-trace-id，业务正常
curl -i -X POST http://127.0.0.1:3001/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"rollback-check"}'

# 开启状态：应有 x-trace-id / x-request-id，且终端日志恰好一条
```

- `runtime.diagnostics()`：`state`、`dropped`、`exportErrors`、`queued`、`warnings`。
- 真实后端读回：`node --import tsx scripts/lo19-readback.ts`（退出码 0 表示全部检查通过）。

## 6. 已知边界

- 追踪故障不会重试整条链路，也不会阻塞请求；因此**不能**把 Langfuse 当作审计或计费凭据。
- 受测组合：Langfuse `3.225.11` + OTel SDK `2.12.0` + `exporter-trace-otlp-proto` `0.223.0`，OTLP/HTTP+protobuf。
- 真实 provider 未配置时，模型观测只能验证适配器与传输，不验证计费字段的真实性。
- 前端 `npm run build:web` 在本机当前环境被 esbuild 的 `winapi error #5`（读取 `package.json` 被拒）阻塞；`npm run typecheck:web` 通过。这是环境问题，与本次接入无关。
