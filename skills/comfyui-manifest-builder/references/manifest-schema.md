# Manifest generation contract

Generate this shape:

```json
{
  "id": "flux-img2img",
  "name": "Flux image editor",
  "description": "Edit one source image",
  "kind": "image_to_image",
  "enabled": false,
  "workflowFile": "flux-img2img.api.json",
  "bindings": {
    "prompt": { "nodeId": "25", "input": "text" },
    "negativePrompt": { "nodeId": "26", "input": "text" },
    "assets": {
      "source_image": {
        "nodeId": "12",
        "input": "image",
        "required": true
      }
    },
    "parameters": {
      "seed": {
        "nodeId": "30",
        "input": "seed",
        "type": "integer",
        "minimum": 0,
        "maximum": 2147483647,
        "default": 1
      }
    }
  }
}
```

Rules:

- Use only `image_to_image` or `image_to_video` for `kind`.
- Make `id` match `^[a-zA-Z0-9_.-]+$`.
- Make `workflowFile` a relative path inside `WORKFLOW_DIR`; it is not relative to `MANIFEST_DIR`.
- Use API Workflow object keys as string `nodeId` values.
- Make `input` exactly match a key in that node's `inputs` object.
- Define `assets` and `parameters` even when empty.
- Use only `integer`, `number`, `string`, or `boolean` for parameter `type`.
- Make `default` and every `enum` entry agree with `type`.
- Use numeric `minimum` and `maximum` only for numeric parameters.
- Default `enabled` to `false` unless the user explicitly requests immediate registration.
- Do not bind output nodes. video-server imports files reported by ComfyUI history.

The public `/workflows` response derives its asset roles and parameter contract from this file.
Unknown roles and parameters are rejected at job creation time.
