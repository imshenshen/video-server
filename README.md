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
    "inputs": [{"asset_id":"asset_xxx","role":"start_frame"}],
    "prompt": "人物自然向前走",
    "parameters": {"seed": 123}
  }'
```

返回 HTTP 202 和 `job_id`。使用 `/jobs/:id/events` 接收 SSE 进度。

## MCP

MCP 地址：`http://spark:8090/mcp`，使用 Streamable HTTP、JSON response 模式。提供工具：

- `list_media_workflows`
- `create_media_job`
- `get_media_job`
- `cancel_media_job`

MCP 请求同样需要 Bearer Token 和 `x-tenant-id`。

## NAS 快路径

同时配置：

- `llm-gateway`: `INTERNAL_API_KEY`、`ASSET_IMPORT_ROOTS`
- `video-server`: `ASSET_INTERNAL_API_KEY`、`COMFY_INPUT_ROOT`、`COMFY_OUTPUT_ROOT`

输入资产会优先通过内部接口解析为 NAS 路径，并硬链接/复制到 ComfyUI input；输出会直接从 ComfyUI output 导入资产服务。如果没有配置共享目录，则自动通过 HTTP 下载、上传。

注意：`ASSET_IMPORT_ROOTS` 必须包含 `COMFY_OUTPUT_ROOT`，否则输出导入会被拒绝。
