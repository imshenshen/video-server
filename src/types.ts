export type WorkflowKind = "text_to_image" | "image_to_image" | "image_to_video";
export type JobStatus =
  | "queued"
  | "preparing"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface NodeBinding {
  nodeId: string;
  input: string;
}

export interface AssetBinding extends NodeBinding {
  required?: boolean;
}

export interface ParameterBinding extends NodeBinding {
  type: "integer" | "number" | "string" | "boolean";
  default?: string | number | boolean;
  minimum?: number;
  maximum?: number;
  enum?: Array<string | number | boolean>;
}

export interface PresetOverride extends NodeBinding {
  value: string | number | boolean;
}

export interface PresetOption {
  label?: string;
  description?: string;
  promptPrefix?: string;
  promptSuffix?: string;
  overrides: PresetOverride[];
}

export interface PresetBinding {
  default?: string;
  options: Record<string, PresetOption>;
}

export interface WorkflowManifest {
  id: string;
  name: string;
  description?: string;
  kind: WorkflowKind;
  enabled: boolean;
  allowedTenants: string[];
  workflowFile: string;
  bindings: {
    prompt?: NodeBinding;
    negativePrompt?: NodeBinding;
    assets: Record<string, AssetBinding>;
    randomSeeds: NodeBinding[];
    parameters: Record<string, ParameterBinding>;
  };
  presets: Record<string, PresetBinding>;
}

export interface JobInput {
  asset_id?: string;
  media_ref?: string;
  role: string;
}

export interface WebhookCallbackRequest {
  protocol: "runclave.capability-callback.v1";
  url: string;
  token: string;
  subscriptionId: string;
  invocationId: string;
}

export interface CreateJobRequest {
  workflow_id: string;
  inputs: JobInput[];
  prompt: string;
  negative_prompt?: string;
  parameters?: Record<string, unknown>;
  callback?: WebhookCallbackRequest;
}

export interface OutputAsset {
  asset_id?: string;
  resource_id?: string;
  uri: string;
  mime_type: string;
  original_name: string;
  size: number;
  sha256?: string;
  content_url?: string;
}

export interface ResolvedWorkflowSettings {
  effectivePrompt: string;
  presets: Record<string, string>;
  parameters: Record<string, unknown>;
  randomSeeds: Array<NodeBinding & { value: number }>;
  presetOverrides: Array<PresetOverride & { preset: string; option: string }>;
}

export interface GenerationJob {
  id: string;
  tenantId: string;
  workflowId: string;
  request: CreateJobRequest;
  status: JobStatus;
  progress: number;
  currentNode?: string;
  comfyPromptId?: string;
  resolvedSettings?: ResolvedWorkflowSettings;
  outputs: OutputAsset[];
  error?: string;
  webhookCallback?: JobWebhookCallback;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface JobWebhookCallback {
  protocol: "runclave.capability-callback.v1";
  url?: string;
  token?: string;
  subscriptionId: string;
  invocationId: string;
  eventId: string;
  deliveryStatus: "pending" | "delivering" | "retrying" | "delivered" | "failed";
  attempts: number;
  nextAttemptAt?: string;
  deliveredAt?: string;
  lastError?: string;
}

export interface ComfyOutputFile {
  filename: string;
  subfolder: string;
  type: string;
  mediaKind: string;
}
