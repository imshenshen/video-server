# video-server

ComfyUI 的受控异步任务服务，同时提供 REST 和 MCP Streamable HTTP 接口。模型只能选择已注册的工作流和允许修改的参数，不能提交任意 Workflow JSON。

## 准备工作流

1. 在 ComfyUI 中确认工作流可以正常运行。
2. 使用 **Export (API Format)** 导出 JSON，放入 `WORKFLOW_DIR`。
3. 参考 `example-image-to-video.manifest.json` 新建对应的 `.manifest.json`。
4. 设置 `enabled: true`。
5. 将 `nodeId` 和 `input` 映射到实际工作流节点。

manifest 可以放在 `WORKFLOW_DIR`，也可以通过 `MANIFEST_DIR` 放到独立目录。无论 manifest
位于哪里，其中的 `workflowFile` 都相对 `WORKFLOW_DIR` 解析。完整格式、映射原理和安全边界见
[`docs/workflow-manifests.md`](docs/workflow-manifests.md)。

服务启动时会校验所有启用的 manifest；生产环境建议重启服务来发布工作流新版本。

需要从 API Workflow 交互式生成或修复 manifest 时，可让支持 Agent Skills 的 Agent 使用仓库内
[`skills/comfyui-manifest-builder/SKILL.md`](skills/comfyui-manifest-builder/SKILL.md)。技能会列出
候选节点、要求确认映射，并在写入前验证每个 `nodeId` 和 `input`。

## 运行

```bash
cp .env.example .env
npm run dev
```

生产环境：

```bash
npm run build
pm2 start ecosystem.config.cjs
pm2 save
```

服务启动入口会自动读取当前目录的 `.env`。更新代码后执行 `npm ci && npm run build && pm2 restart video-server --update-env`。


## 家庭多用户 Token

少量固定用户无需注册系统。通过 JSON 对象把每个用户（Tenant）绑定到唯一 Token：

```env
VIDEO_SERVER_USERS={"dad":"replace-with-at-least-16-chars","mom":"another-private-token"}
```

设置后，服务端根据 Bearer Token 固定 Tenant，并忽略客户端传入的 `x-tenant-id`。每个 Token
只能查看、创建和取消自己的任务，输入及输出资产请求也使用该固定 Tenant。Token 必须唯一且至少 16 个字符。
此模式优先于兼容用的 `VIDEO_SERVER_API_KEY`；不要同时依赖旧 Token 访问。修改后重启服务。

## REST API

```text
GET  /healthz
GET  /workflows
POST /jobs
GET  /jobs
GET  /jobs/:id
GET  /jobs/:id/events
POST /jobs/:id/cancel
POST /mcp
```

创建任务：

```bash
curl -X POST http://spark:8090/jobs \
  -H 'Authorization: Bearer change-me' \
  -H 'x-tenant-id: user-123' \
  -H 'Content-Type: application/json' \
  -d '{
    "workflow_id": "wan-i2v-v1",
    "inputs": [{"media_ref":"runclave-resource://res_xxx","role":"start_frame"}],
    "prompt": "人物自然向前走",
    "parameters": {"seed": 123}
  }'
```

返回 HTTP 202 和 `job_id`。使用 `/jobs/:id/events` 接收 SSE 进度。

## MCP

MCP 地址：`http://spark:8090/mcp`，使用 Streamable HTTP、JSON response 模式。提供工具：

- `create_media_job`
- `get_media_job`
- `get_media_asset`（校验媒体引用并返回元数据；不会返回 Base64）
- `cancel_media_job`

MCP 请求同样需要 Bearer Token 和 `x-tenant-id`。

## Runclave Webhook 回调

`create_media_job` 支持 Runclave 注入的可选 `callback` 参数。任务完成、失败或取消后，
video-server 会在输出资源注册完成后主动 POST 最终结果，因此 ControlAgent 不需要持续轮询
`get_media_job`；轮询仍可作为回调不可用时的后备方案。

在 Runclave 的 Video Server 工具编辑器中配置：

- Webhook Base URL：填写 video-server 能访问的 Runclave HTTPS 地址。
- 创建工具：`create_media_job`
- 状态查询工具：`get_media_job`
- 回调参数路径：`callback`
- Operation ID 结果路径：`id`

Runclave 会注入以下对象，调用方不需要自行填写：

```json
{
  "protocol": "runclave.capability-callback.v1",
  "url": "https://runclave.example.com/api/capability-callbacks/callback_xxx",
  "token": "<one-time bearer token>",
  "subscriptionId": "callback_xxx",
  "invocationId": "call_xxx"
}
```

回调使用相同的 `eventId` 进行幂等重试，并携带 `operationId`、终态、完整 job 结果以及已经
注册完成的 `outputResourceIds`。回调 token 只写入权限为 `0600` 的私有 job 文件，对外的
REST、MCP、SSE 和日志均不会返回该 token。远程回调地址必须使用 HTTPS；仅 localhost
允许 HTTP。

可选重试配置：

```dotenv
WEBHOOK_TIMEOUT_MS=10000
WEBHOOK_MAX_ATTEMPTS=5
WEBHOOK_RETRY_BASE_MS=2000
```

失败使用指数退避，最大间隔 60 秒。服务重启时会继续发送尚未成功送达的终态回调。

## Runclave 资源后端（推荐）

当上传和对话资源由 Runclave 管理时：

```dotenv
MEDIA_RESOURCE_BACKEND=runclave
RUNCLAVE_RESOURCE_BASE_URL=http://macmini.shenshen:3001
RUNCLAVE_RESOURCE_API_TOKEN=
RUNCLAVE_SHARED_PROVIDER_ID=nas_main
RUNCLAVE_SHARED_ROOT=/Volumes/media/runclave
```

输入使用 `runclave-resource://res_xxx`。provider 与共享目录匹配时，video-server 直接从 NAS
读取；否则通过 Runclave API 下载。生成结果先写入同一共享目录的临时区，再调用 Runclave
注册接口归档为 `objects/<sha256 前缀>/<sha256>.<ext>`，注册完成即删除临时文件。相同内容会
复用同一个 Resource 和物理对象，video job、Control Session、消息分别通过绑定引用它。

Runclave 开启 Desktop token 鉴权时填写 `RUNCLAVE_RESOURCE_API_TOKEN`；否则可留空。

## llm-gateway 旧资产后端

设置 `MEDIA_RESOURCE_BACKEND=llm_gateway` 后，原有 `ASSET_SERVICE_URL`、
`ASSET_SERVICE_API_KEY`、`ASSET_INTERNAL_API_KEY` 与 `ASSET_IMPORT_ROOTS` 流程保持可用。
这用于尚未迁移到 Runclave ResourceRef 的独立客户端。

## Agent 媒体预览 URL

MCP 不内联图片 Base64。配置可被 Agent/浏览器访问的固定地址与独立签名密钥：

```dotenv
VIDEO_SERVER_PUBLIC_BASE_URL=https://video.example.com
ASSET_URL_SIGNING_SECRET=<至少 32 字符的独立随机密钥>
ASSET_URL_TTL_SECONDS=86400
```

该签名 URL 仅用于 `llm_gateway` 兼容模式。Runclave 模式返回持久
`runclave-resource://res_xxx`，由 Runclave 在当前消息上下文中绑定并提供受控预览地址。
