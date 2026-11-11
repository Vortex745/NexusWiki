import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// pi-subagents 扩展的接入辅助（spec: docs/spec/pi-subagents-adoption.md FR-1，双轨不改现有行为）：
// 环境守卫 + config 幂等种子 + 包入口解析，供 Router 创建时经 loadAppExtensions 的接缝注入

// 种子配置：eager 让 subagent 工具在加载期即注册（不赌模型中途调加载器激活）；
// asyncByDefault:false + maxActiveAsyncRunsPerSession:0 封死 detached runner——
// Electron 主进程没有独立 node 二进制保证，后台 async 子代理是 v2 议题（spec 钉死条件 2）
const SUBAGENT_CONFIG = JSON.stringify({
  toolActivation: 'eager',
  asyncByDefault: false,
  maxActiveAsyncRunsPerSession: 0
})

// 幂等种子：缺文件才写；已存在（含损坏 JSON）一律不覆盖，同 pi-seed 语义——
// 用户改过的扩展配置（async 策略等）不能被应用启动悄悄抹掉
export function ensureSubagentConfig(agentDir: string): void {
  const configDir = join(agentDir, 'extensions', 'subagent')
  const configFile = join(configDir, 'config.json')
  if (existsSync(configFile)) return
  mkdirSync(configDir, { recursive: true })
  writeFileSync(configFile, SUBAGENT_CONFIG, 'utf8')
}

// 解析 pi-subagents 扩展入口（发布版预打包 JS，exports "." 直指 bundle/index.js，无需 jiti）。
// PI_CODING_AGENT_DIR 每次调用无条件赋值：扩展的 getAgentDir() 读它定位 config/agent 定义/results，
// 不指向 agentDir 会落进真实 ~/.pi，违反项目隔离（spec 钉死条件 1）；生产 agentDir 恒定，幂等无害。
// 包未装/被构建剔除时 import.meta.resolve 抛错 → 返回 undefined，调用方降级为无委派工具的会话
export function resolveSubagentExtension(agentDir: string): string | undefined {
  process.env.PI_CODING_AGENT_DIR = agentDir
  ensureSubagentConfig(agentDir)
  try {
    return fileURLToPath(import.meta.resolve('pi-subagents'))
  } catch {
    return undefined
  }
}
