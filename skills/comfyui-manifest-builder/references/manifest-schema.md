# Manifest generation contract

Generate this shape:

```json
{
  "id": "flux-img2img",
  "name": "Flux image editor",
  "description": "Edit one source image",
  "kind": "image_to_image",
  "enabled": false,
  "allowedTenants": ["user-a"],
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

Rules:

- Use only `text_to_image`, `image_to_image`, or `image_to_video` for `kind`.
- Define a non-empty, duplicate-free `allowedTenants` list. Omitted tenants cannot list or execute it.
- Make `id` match `^[a-zA-Z0-9_.-]+$`.
- Make `workflowFile` a relative path inside `WORKFLOW_DIR`, not relative to `MANIFEST_DIR`.
- Use API Workflow object keys as string `nodeId` values and exact node input names.
- Define `assets`, `randomSeeds`, and `parameters` even when empty.
- Put UI seeds configured as `randomize` in `randomSeeds`; video-server replaces each with a private random safe integer for every build.
- Never put seed, steps, CFG, denoise/strength, sampler/scheduler, batch size, dimensions, frame count/rate, or model controls in public `parameters` by default. Their API values are the tuned source of truth.
- Add a public parameter only after explicit user approval. Prefer semantic enums/presets, omit `default`, and use only `integer`, `number`, `string`, or `boolean` with matching bounds/enums.
- Default `enabled` to `false` unless the user explicitly requests immediate registration.
- Do not bind output nodes. video-server imports files reported by ComfyUI history.

The public `/workflows` response derives its roles and parameter contract from this file. Unknown roles
and parameters are rejected. Omitted public parameters do not modify API workflow values.
