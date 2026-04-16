# claude-channel

基于 **Bun + TypeScript** 的 `stdio MCP` 服务，作用是把外部 OpenAI Chat Completions 请求转发到 Claude Code 的 `channels`，再把 Claude Code 回复回写给 API 调用方。

## 功能

- MCP 服务通过 `stdio` 运行，可直接被 Claude Code 接入。
- 声明 `experimental["claude/channel"]`，支持 `notifications/claude/channel`。
- 提供 OpenAI 兼容 HTTP API：`POST /v1/chat/completions`。
- 外部请求进入后：
  1. 转成 channel 消息发给 Claude Code
  2. Claude Code 调用 `channel_reply` 返回内容
  3. MCP 服务把结果封装成 OpenAI Chat Completions 响应返回

## 安装

```bash
bun install
```

## 运行

```bash
bun run src/index.ts
```

这是一个 `stdio MCP` 进程，通常由 Claude Code 拉起。

## Claude Code 接入示例

`.mcp.json` 示例：

```json
{
  "mcpServers": {
    "claude-channel": {
      "command": "bun",
      "args": ["run", "/ABS/PATH/TO/claude-channel/src/index.ts"]
    }
  }
}
```

## 可用工具

- `http_server_start`：开启 OpenAI 兼容 HTTP 服务
- `http_server_stop`：停止 HTTP 服务
- `http_server_status`：查看服务状态
- `runtime_status`：查看 MCP 运行状态（含监听 host/port、listen_url、pending 请求数、OpenAI routes 和模型列表）
- `channel_reply`：Claude Code 用它回复某个 `request_id`
- `channel_publish`：手动发送测试 channel

## HTTP API

### 健康检查

```bash
curl http://127.0.0.1:8787/health
```

### Models

```bash
curl http://127.0.0.1:8787/v1/models
```

### Chat Completions

```bash
curl -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "claude-channel",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "你好，介绍一下你是谁"}
    ]
  }'
```

### 开启 API Key 校验

启动前设置：

```bash
export BRIDGE_API_KEY='your-token'
```

请求时：

```bash
-H 'Authorization: Bearer your-token'
```

## 环境变量

- `BRIDGE_HTTP_HOST`：默认 `127.0.0.1`
- `BRIDGE_HTTP_PORT`：默认 `8787`
- `BRIDGE_CHAT_TIMEOUT_MS`：默认 `180000`
- `BRIDGE_API_KEY`：可选，设置后启用 Bearer 校验
- `BRIDGE_HTTP_AUTO_START=1`：MCP 连接后自动启动 HTTP 服务

## 交互约定

当外部请求到达时，Claude Code 会收到形如：

```xml
<channel source="claude-channel" request_id="...">...</channel>
```

Claude Code 需要调用 `channel_reply`：

- `request_id`：来自 channel 属性
- `content`：要回给 API 客户端的文本
