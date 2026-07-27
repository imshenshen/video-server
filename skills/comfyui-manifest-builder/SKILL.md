---
name: comfyui-manifest-builder
description: Convert ComfyUI UI workflows to API Format when needed, inspect API workflows, and create or repair validated video-server *.manifest.json files with tenant ACLs, locked tuned settings, and private runtime-random seeds. Use when registering image-to-image, text-to-image, or image-to-video workflows; mapping prompts or assets; preserving tuned ComfyUI parameters; configuring random seeds; or diagnosing missing workflows.
---

# ComfyUI Manifest Builder

Create a reviewed API workflow and video-server manifest. Treat automatic matches as candidates only;
custom nodes and duplicated encoders require review. Treat the API workflow as the source of truth for tuned settings.

## Convert UI Format

Run the inspector first:

```bash
node "<skill-dir>/scripts/manifest-tool.mjs" inspect "<workflow.json>"
```

When `format` is `ui`, automatically convert to a temporary API file using the running ComfyUI schemas:

```bash
node "<skill-dir>/scripts/ui-to-api.mjs" \
  "<workflow.json>" "/tmp/<id>.api.json" \
  --comfy-url "${COMFYUI_BASE_URL:-http://127.0.0.1:8188}"
```

Never overwrite the UI workflow. Review every warning and the draft API graph. The converter removes
muted/bypassed nodes, reroutes unambiguous bypass connections, and refuses ambiguous connected nodes.
If a warning reports a `randomize` seed control, map that API seed input under `bindings.randomSeeds`.

## Preserve tuned settings

Keep sampler, scheduler, steps, CFG, denoise/strength, batch size, dimensions, frame count/rate, and
model settings in the API workflow. Do not copy them into public `bindings.parameters` by default.
Inspector candidates marked `locked` are internal settings, not an invitation to expose them.

Use these rules:

- Make `bindings.parameters` empty unless the user explicitly approves a semantic override.
- Never expose `seed` or `noise_seed`. Put randomized seed inputs in `bindings.randomSeeds`.
- Prefer named semantic presets over raw width/height or sampler controls when an override is explicitly approved.
- Omit parameter `default` values. An omitted request must leave the API workflow unchanged.
- Reject agent convenience as approval. “The model may want to tune it” is not user approval.

## Inspect API Format

Run:

```bash
node "<skill-dir>/scripts/manifest-tool.mjs" inspect "<workflow.api.json>"
```

Verify prompt polarity, every asset role, output nodes, model/CLIP/LoRA connections, tuned settings,
and each random seed node. API format cannot serialize the UI `control_after_generate=randomize` behavior;
`bindings.randomSeeds` restores it at video-server runtime.

## Confirm

Before writing, present:

1. Stable ID, name, kind, and `workflowFile` relative to `WORKFLOW_DIR`.
2. Prompt and optional negative-prompt bindings.
3. Asset roles and required flags.
4. Private randomized seed bindings.
5. Public parameters, normally empty; explain every exception.
6. Non-empty `allowedTenants`, enabled state, and API destination.

Read [references/manifest-schema.md](references/manifest-schema.md) while constructing JSON.

## Validate and write

Create drafts in `/tmp`, then validate the exact pair:

```bash
node "<skill-dir>/scripts/manifest-tool.mjs" validate \
  "<workflow.api.json>" "<draft.manifest.json>"
```

After confirmation, write with:

```bash
node "<skill-dir>/scripts/manifest-tool.mjs" write \
  "<workflow.api.json>" "<draft.manifest.json>" "<MANIFEST_DIR>/<id>.manifest.json"
```

The command refuses overwrite. Use `--force` only after explicit overwrite confirmation. Restart
video-server and verify REST `/workflows` plus MCP `list_media_workflows`; confirm locked settings are
absent and run two builds to confirm seeds differ without changing the API file.
