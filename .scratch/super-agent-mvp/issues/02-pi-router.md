# 02: pi Router 接入

**What to build:** 主进程把聊天消息交给常驻 pi AgentSession（Router）。提供两种模型模式：脚本化假模型（注入，确定性回复，零成本，作为后续票据的测试桩）与真实模型（pi models.json 配 OpenAI 兼容 API，key 存本地，唯一出网=LLM API）。流式增量经事件通道回 UI。无 key 时应用正常启动并明确提示。

**Blocked by:** 01 (聊天骨架)

**Status:** done

- [x] 假模型模式：发送消息得到确定性流式回复，可作为自动化测试桩
- [x] 真实模型模式：配置 key 后收到真实流式回复；未配置时启动不崩溃且有提示（真实流式回复需手动冒烟：settings 表设 `router.modelMode=real` 并在 `userData/pi-agent/` 放 models.json + auth.json）
- [x] Router session 常驻且上下文连续（第二轮对话能引用第一轮内容）
- [x] pi 依赖从主进程 externalize 加载（不打入 bundle），`npm run typecheck` 通过
