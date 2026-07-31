import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../src/config.js";
import { JobManager } from "../src/job-manager.js";
import { JobStore } from "../src/job-store.js";
import type { GenerationJob } from "../src/types.js";
import type { AssetClient } from "../src/asset-client.js";
import type { ComfyClient } from "../src/comfy-client.js";
import type { WorkflowRegistry } from "../src/workflow-registry.js";
import {
  publicGenerationJob,
  webhookCallbackPayload,
  webhookCallbackSchema,
  WebhookCallbackClient
} from "../src/webhook-callback.js";

function callback() {
  return {
    protocol: "runclave.capability-callback.v1" as const,
    url: "https://runclave.example.test/api/capability-callbacks/callback_123",
    token: "secret-token-value",
    subscriptionId: "callback_123",
    invocationId: "call_123"
  };
}

function completedJob(): GenerationJob {
  return {
    id: "job_0123456789abcdef0123456789abcdef",
    tenantId: "default",
    workflowId: "krea2-text-to-image",
    request: {
      workflow_id: "krea2-text-to-image",
      inputs: [],
      prompt: "portrait"
    },
    status: "completed",
    progress: 1,
    outputs: [{
      resource_id: "res_output-1",
      uri: "runclave-resource://res_output-1",
      mime_type: "image/png",
      original_name: "output.png",
      size: 123
    }],
    webhookCallback: {
      ...callback(),
      eventId: "callback_event_123",
      deliveryStatus: "delivering",
      attempts: 1
    },
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:01:00.000Z",
    completedAt: "2026-07-30T00:01:00.000Z"
  };
}

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for webhook delivery");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("webhook callback schema accepts Runclave HTTPS and local HTTP URLs", () => {
  assert.equal(webhookCallbackSchema.parse(callback()).protocol, "runclave.capability-callback.v1");
  assert.equal(
    webhookCallbackSchema.parse({ ...callback(), url: "http://127.0.0.1:3001/callback" }).url,
    "http://127.0.0.1:3001/callback"
  );
  assert.equal(
    webhookCallbackSchema.parse({ ...callback(), url: "http://[::1]:3001/callback" }).url,
    "http://[::1]:3001/callback"
  );
  assert.throws(
    () => webhookCallbackSchema.parse({ ...callback(), url: "http://runclave.example.test/callback" }),
    /Remote webhook callback URLs must use HTTPS/
  );
});

test("job persistence keeps webhook credentials private and uses owner-only file permissions", async () => {
  const previousDataDir = config.jobDataDir;
  const dataDir = await mkdtemp(path.join(tmpdir(), "video-webhook-jobs-"));
  config.jobDataDir = dataDir;
  try {
    const store = new JobStore();
    await store.initialize();
    const job = await store.create({
      workflow_id: "krea2-text-to-image",
      inputs: [],
      prompt: "portrait",
      callback: callback()
    }, "default");

    assert.equal(job.request.callback, undefined);
    assert.equal(job.webhookCallback?.token, "secret-token-value");
    assert.match(job.webhookCallback?.eventId ?? "", /^callback_/);
    const storedPath = path.join(dataDir, `${job.id}.json`);
    assert.equal((await stat(storedPath)).mode & 0o777, 0o600);
    assert.match(await readFile(storedPath, "utf8"), /secret-token-value/);

    const publicJob = publicGenerationJob(job);
    assert.equal(publicJob.webhookCallback?.token, undefined);
    assert.equal(publicJob.webhookCallback?.url, undefined);
    assert.doesNotMatch(JSON.stringify(publicJob), /secret-token-value/);
  } finally {
    config.jobDataDir = previousDataDir;
  }
});

test("webhook delivery posts an idempotent Runclave terminal result", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(url);
    requestInit = init;
    return new Response(JSON.stringify({ accepted: true }), { status: 202 });
  }) as typeof fetch;
  const job = completedJob();

  await new WebhookCallbackClient(fetchImpl, 1_000).deliver(job);

  assert.equal(requestUrl, callback().url);
  assert.equal(new Headers(requestInit?.headers).get("authorization"), "Bearer secret-token-value");
  assert.equal(new Headers(requestInit?.headers).get("x-runclave-event-id"), "callback_event_123");
  const payload = JSON.parse(String(requestInit?.body));
  assert.equal(payload.eventId, "callback_event_123");
  assert.equal(payload.operationId, job.id);
  assert.equal(payload.status, "completed");
  assert.deepEqual(payload.outputResourceIds, ["res_output-1"]);
  assert.equal(payload.result.webhookCallback.token, undefined);
  assert.doesNotMatch(String(requestInit?.body), /secret-token-value/);
  assert.deepEqual(webhookCallbackPayload(job), payload);
});

test("job manager retries terminal callbacks and persists delivery state", async () => {
  const job = completedJob();
  if (!job.webhookCallback) throw new Error("Expected callback");
  job.webhookCallback.deliveryStatus = "pending";
  job.webhookCallback.attempts = 0;
  const saved: GenerationJob[] = [];
  const store = {
    async initialize() {},
    async list() { return [job]; },
    async save(value: GenerationJob) { saved.push(structuredClone(value)); }
  } as unknown as JobStore;
  let deliveries = 0;
  const webhooks = {
    async deliver() {
      deliveries += 1;
      if (deliveries === 1) throw new Error("temporary network failure");
    }
  } as unknown as WebhookCallbackClient;
  const previous = {
    tempDir: config.jobTempDir,
    retryBaseMs: config.webhookRetryBaseMs,
    maxAttempts: config.webhookMaxAttempts
  };
  config.jobTempDir = await mkdtemp(path.join(tmpdir(), "video-webhook-temp-"));
  config.webhookRetryBaseMs = 1;
  config.webhookMaxAttempts = 3;
  const manager = new JobManager(
    {} as WorkflowRegistry,
    store,
    {} as AssetClient,
    {} as ComfyClient,
    webhooks
  );

  try {
    await manager.initialize();
    await waitFor(() => manager.get(job.id, job.tenantId).webhookCallback?.deliveryStatus === "delivered");
    const result = manager.get(job.id, job.tenantId);
    assert.equal(deliveries, 2);
    assert.equal(result.webhookCallback?.attempts, 2);
    assert.equal(result.webhookCallback?.deliveryStatus, "delivered");
    assert.ok(result.webhookCallback?.deliveredAt);
    assert.equal(result.webhookCallback?.token, undefined);
    assert.ok(saved.some((entry) => entry.webhookCallback?.deliveryStatus === "retrying"));
  } finally {
    manager.stop();
    config.jobTempDir = previous.tempDir;
    config.webhookRetryBaseMs = previous.retryBaseMs;
    config.webhookMaxAttempts = previous.maxAttempts;
  }
});
