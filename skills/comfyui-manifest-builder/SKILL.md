---
name: comfyui-manifest-builder
description: Inspect a ComfyUI API Format workflow and interactively create or repair a validated video-server *.manifest.json. Use when registering image-to-image or image-to-video workflows, mapping prompts, input images, videos, seeds, dimensions, denoise values, or other approved parameters to ComfyUI node inputs, or diagnosing why a workflow is absent from video-server /workflows.
---

# ComfyUI Manifest Builder

Create a reviewed video-server manifest from a ComfyUI API Format JSON. Treat automatic matches as
candidates only; require confirmation before writing because custom nodes and duplicated text encoders
cannot always be distinguished reliably.

## Inspect

Resolve the skill directory from this `SKILL.md`, then run:

```bash
node "<skill-dir>/scripts/manifest-tool.mjs" inspect "<workflow.api.json>"
```

Use the JSON report to verify:

- `format` is `api`; stop and ask for **Export (API Format)** when it is `ui`.
- Prompt and negative-prompt nodes.
- Every input image/video node and a meaningful unique role for each one.
- Only parameters the chat Agent should be allowed to change.
- Output nodes exist. Outputs do not need manifest bindings because video-server collects them from
  ComfyUI history.

Do not infer positive versus negative prompt from two otherwise identical encoders. Prefer node titles,
connections visible to the user, or explicit confirmation.

## Confirm

Present a compact proposed mapping and ask the user to confirm or correct it. Collect:

1. Stable `id`, display `name`, `kind`, and `workflowFile` relative to `WORKFLOW_DIR`.
2. Optional prompt and negative-prompt bindings.
3. Asset roles and whether each is required.
4. Parameter types, bounds, enum values, and defaults.
5. Whether the manifest should be enabled.

For multiple images, use distinct roles such as `source_image`, `reference_image`, or `end_frame`.
Do not expose model paths, arbitrary filenames, or node inputs that the caller does not need.

Read [references/manifest-schema.md](references/manifest-schema.md) while constructing the JSON.

## Validate and write

Create the proposed manifest in a temporary file first. Validate it against the exact API Workflow:

```bash
node "<skill-dir>/scripts/manifest-tool.mjs" validate \
  "<workflow.api.json>" "<draft.manifest.json>"
```

Show the final mapping and destination. Write only after the user confirms:

```bash
node "<skill-dir>/scripts/manifest-tool.mjs" write \
  "<workflow.api.json>" "<draft.manifest.json>" "<MANIFEST_DIR>/<id>.manifest.json"
```

The command refuses to overwrite an existing file. Use `--force` only after explicit overwrite
confirmation. Never modify the ComfyUI API Workflow itself.

After writing, advise restarting video-server and checking registration:

```bash
pm2 restart video-server --update-env
curl "$VIDEO_URL/workflows" \
  -H "Authorization: Bearer $VIDEO_TOKEN" \
  -H "x-tenant-id: $TENANT_ID"
```

If startup or task creation fails, run `validate` again against the deployed files and report the exact
missing node or input.
