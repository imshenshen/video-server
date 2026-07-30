# ComfyUI Workflow Manifest

`*.manifest.json` 是 video-server 的工作流适配与能力白名单，不是 ComfyUI 官方格式。
ComfyUI 的 API Format Workflow 保存完整节点图；manifest 只描述聊天 Agent 可以选择的工作流、
可提供的媒体角色、可修改的参数，以及它们在节点图中的写入位置。

## 目录规则

- `WORKFLOW_DIR`：保存 ComfyUI **Export (API Format)** 导出的 JSON。
- `MANIFEST_DIR`：保存 `*.manifest.json`；未配置时默认等于 `WORKFLOW_DIR`。
- `workflowFile`：始终相对 `WORKFLOW_DIR` 解析，不相对 manifest 文件所在目录解析。
- 服务只扫描 `MANIFEST_DIR` 第一层中以 `.manifest.json` 结尾的文件。
- 普通 ComfyUI UI Format JSON 不会被注册，也不能提交到 `/prompt`。

例如：

```text
/srv/comfy-workflows/api/flux-img2img.api.json
/srv/video-server-manifests/flux-img2img.manifest.json
```

```dotenv
WORKFLOW_DIR=/srv/comfy-workflows/api
MANIFEST_DIR=/srv/video-server-manifests
```

## 完整示例

```json
{
  "id": "flux-img2img",
  "name": "Flux 图生图",
  "description": "使用一张图片进行编辑",
  "kind": "image_to_image",
  "enabled": true,
  "allowedTenants": ["default"],
  "workflowFile": "flux-img2img.api.json",
  "bindings": {
    "prompt": { "nodeId": "25", "input": "text" },
    "assets": {
      "source_image": { "nodeId": "12", "input": "image", "required": true }
    },
    "randomSeeds": [
      { "nodeId": "30", "input": "seed" }
    ],
    "parameters": {}
  }
}
```

## 字段

- `bindings.randomSeeds`：不向 Agent 暴露；每次构建时由服务端写入随机安全整数。
- `bindings.parameters`：允许调用者修改的显式白名单，默认应为空。
- API workflow 是 sampler、steps、CFG、denoise、尺寸、batch 等调优值的唯一默认来源。
- 未传入的公开参数不会修改 API workflow；未声明参数会被拒绝。
- 只有用户明确批准时才开放语义化 preset，禁止默认公开 seed 或底层采样参数。

每个绑定使用 `nodeId` 与 `input` 定位 API workflow 节点输入。

## 运行过程

1. 服务启动时扫描并校验所有启用的 manifest，拒绝重复 ID 和越出 `WORKFLOW_DIR` 的路径。
2. `/workflows` 只发布工作流 ID、媒体角色和参数约束，不发布内部节点图。
3. 创建任务时校验必需媒体、角色唯一性和参数白名单。
4. video-server 读取原始 API Workflow，在内存中写入提示词、ComfyUI 输入文件名和参数。
5. 修改后的节点图发送到 ComfyUI `/prompt`；磁盘上的原始 Workflow 不会被改写。

具体节点与输入目前在创建任务、组装节点图时验证。新增或修改 manifest 后，应使用真实输入执行一次
测试任务，再将其用于生产调用。

## 查找节点映射

用下面的命令列出 API Workflow 的节点 ID、类型、标题和输入字段：

```bash
jq -r '
  to_entries[]
  | [
      .key,
      .value.class_type,
      (.value._meta.title // ""),
      ((.value.inputs // {}) | keys | join(","))
    ]
  | @tsv
' workflow.api.json
```

重点检查提示词编码、`LoadImage`、采样器以及保存图片/视频的节点。自定义节点的输入名称不一定
遵循通用规则，因此生成 manifest 时应让使用者确认候选映射，而不是仅凭节点类型自动启用。

## 安全边界

客户端不能提交任意 Workflow JSON，只能选择已注册的 manifest，并修改 manifest 明确开放的字段。
这样可以避免 Agent 任意选择模型、调用危险自定义节点或读写未授权路径。manifest 应由可信部署者
审核和发布，不应允许普通聊天用户上传。

## Workflow 访问权限

每个启用的 manifest 必须设置非空的 `allowedTenants` 白名单：

```json
{
  "id": "klein-edit-1",
  "enabled": true,
  "allowedTenants": ["default", "ariel", "joy", "ming"]
}
```

只有名单内的 Tenant 才能在 REST `/workflows` 或 MCP `tools/list` 返回的 `create_media_job` 工作流目录中看到它，
也只有名单内的 Tenant 能创建和执行对应任务。未授权访问统一返回未知工作流，避免泄露 ID。
修改权限后，运行 manifest skill 的 `validate`，再重启 `video-server`。

注意：使用 `VIDEO_SERVER_USERS` 时，这里填写服务端映射后的 Tenant ID。当前 shenshen 为了继承
旧数据映射到 `default`，因此应填写 `default`；其他用户使用 `ariel`、`joy`、`ming`。
