import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type LoadedMcpConfig,
  type McpServerConfig,
  type McpServerEntry
} from '@earendil-works/pi-coding-agent'
import { errorMessageOf } from './pi-shared.ts'

// pi 1.4.0 的 validateMcpServerConfig 未从包根导出（core barrel 有、根 index 未转发），深路径又被 exports map
// 拦截（ERR_PACKAGE_PATH_NOT_EXPORTED，已实测）；经 import.meta.resolve 定位包目录后按文件 URL 动态加载。
// 运行时解析对 node --test 与打包产物（externalizeDepsPlugin 保留 bare import，node_modules 随应用分发）同一机制；
// 相对路径按 1.4.0 的包内布局（dist/core/mcp-servers.js），版本由 lockfile 锁定。
interface PiMcpServersModule {
  validateMcpServerConfig: (name: string, raw: unknown) => McpServerConfig | string
}
let piMcpServersModule: Promise<PiMcpServersModule> | undefined
function loadPiMcpServersModule(): Promise<PiMcpServersModule> {
  piMcpServersModule ??= import(
    new URL('core/mcp-servers.js', new URL('.', import.meta.resolve('@earendil-works/pi-coding-agent'))).href
  ) as Promise<PiMcpServersModule>
  return piMcpServersModule
}

// mcp.json 边界模块（parse-validate-default）：文件字节 → JSON → validateMcpServerConfig 逐条校验 →
// exposure 缺省 direct → LoadedMcpConfig。exposure 缺省偏离 pi 的 codemode：聊天产品要工具直接声明给模型，
// 拷入的 Claude Desktop / Cursor 配置行为符合直觉；条目显式写了 exposure（含 toolExposure 逐工具覆盖）则照用。
// 其余语义对齐 pi loadMcpConfig：文件缺失 = 零 server 不报错；坏条目进 errors 不中断其他条目；禁用条目保留。
export async function loadAppMcpConfig(agentDir: string): Promise<LoadedMcpConfig> {
  const path = join(agentDir, 'mcp.json')
  if (!existsSync(path)) return { servers: [], errors: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    return { servers: [], errors: [`${path}: ${errorMessageOf(err)}`] }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { servers: [], errors: [`${path}: expected an object with an "mcpServers" object`] }
  }
  const rawServers = (parsed as { mcpServers?: unknown }).mcpServers
  if (rawServers !== undefined && (typeof rawServers !== 'object' || rawServers === null || Array.isArray(rawServers))) {
    return { servers: [], errors: [`${path}: expected an object with an "mcpServers" object`] }
  }
  const { validateMcpServerConfig } = await loadPiMcpServersModule()
  const servers: McpServerEntry[] = []
  const errors: string[] = []
  for (const [name, value] of Object.entries((rawServers ?? {}) as Record<string, unknown>)) {
    const config = validateMcpServerConfig(name, value)
    if (typeof config === 'string') {
      errors.push(`${path}: ${config}`)
      continue
    }
    if (config.exposure === undefined) config.exposure = 'direct'
    servers.push({ name, config, source: path, scope: 'global' })
  }
  return { servers, errors }
}
