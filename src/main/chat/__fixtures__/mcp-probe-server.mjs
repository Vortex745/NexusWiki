// 探针 stdio MCP server：换行分隔 JSON-RPC 2.0（MCP stdio 传输），只实现握手与 echo 工具。
// 协议版本回显客户端请求值（pi-mcp 只接受它支持的版本集），echo 回显 `ECHO:<text>` 供测试断言。
import { createInterface } from 'node:readline'

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params.protocolVersion,
        // 必须声明 tools 能力：pi 只对声明了 tools 的 server 发 tools/list
        capabilities: { tools: {} },
        serverInfo: { name: 'probe', version: '1.0.0' }
      }
    })
    return
  }
  if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          {
            name: 'echo',
            description: '把输入文本原样回显（带 ECHO: 前缀）',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string', description: '要回显的文本' } },
              required: ['text']
            }
          }
        ]
      }
    })
    return
  }
  if (message.method === 'tools/call') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: `ECHO:${message.params.arguments?.text ?? ''}` }] }
    })
    return
  }
  if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } })
  }
})
