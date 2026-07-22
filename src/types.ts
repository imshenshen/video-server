export type WorkflowKind = "image_to_image" | "image_to_video";
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

export interface WorkflowManifest {
  id: string;
  name: string;
  description?: string;
  kind: WorkflowKind;
  enabled: boolean;
  workflowFile: string;
  bindings: {
    prompt?: NodeBinding;
    negativePrompt?: NodeBinding;
    assets: Record<string, AssetBinding>;
    parameters: Record<string, ParameterBinding>;
  };
}

export interface JobInput {
  asset_id: string;
  role: string;
}

export interface CreateJobRequest {
  workflow_id: string;
  inputs: JobInput[];
  prompt: string;
  negative_prompt?: string;
  parameters?: Record<string, unknown>;
}

export interface OutputAsset {
  asset_id: string;
  uri: string;
  mime_type: string;
  original_name: string;
  size: number;
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
  outputs: OutputAsset[];
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface ComfyOutputFile {
  filename: string;
  subfolder: string;
  type: string;
  mediaKind: string;
}
