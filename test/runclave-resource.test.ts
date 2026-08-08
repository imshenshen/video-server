import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import axios from "axios";
import { AssetClient } from "../src/asset-client.js";
import { config } from "../src/config.js";

test("Runclave backend materializes shared inputs and registers generated outputs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "video-runclave-"));
  const inputKey = "objects/aa/bb/input.png";
  const inputPath = path.join(root, inputKey);
  await mkdir(path.dirname(inputPath), { recursive: true });
  await writeFile(inputPath, Buffer.from("input"));
  const generatedPath = path.join(root, "comfy-output.png");
  await writeFile(generatedPath, Buffer.from("generated"));

  let registeredBody: Record<string, unknown> | null = null;
  let stagedBytes: Buffer | null = null;
  let metadataAuthorization = "";
  let registrationAuthorization = "";
  const originalGet = axios.get;
  const originalPost = axios.post;
  axios.get = (async (url: string, requestConfig?: { headers?: Record<string, string> }) => {
    metadataAuthorization = String(requestConfig?.headers?.authorization ?? "");
    if (url.endsWith("/api/resources/res_input")) {
      return {
        data: {
        id: "res_input",
        uri: "runclave-resource://res_input",
        storageProvider: "nas_test",
        storageKey: inputKey,
        mimeType: "image/png",
        originalName: "input.png",
        size: 5
        },
        headers: {}
      };
    }
    throw new Error(`Unexpected GET ${url}`);
  }) as typeof axios.get;
  axios.post = (async (url: string, body: Record<string, unknown>, requestConfig?: { headers?: Record<string, string> }) => {
    if (url.endsWith("/api/resources/register")) {
      registrationAuthorization = String(requestConfig?.headers?.authorization ?? "");
      registeredBody = body;
      stagedBytes = await readFile(path.join(root, String(registeredBody?.storageKey)));
      return {
        data: {
        id: "res_output",
        uri: "runclave-resource://res_output",
        storageProvider: "nas_test",
        storageKey: "objects/cc/dd/output.png",
        mimeType: "image/png",
        originalName: "output.png",
        size: stagedBytes.length,
        sha256: "c".repeat(64),
        contentUrl: "/api/resources/res_output/content"
        },
        headers: {}
      };
    }
    throw new Error(`Unexpected POST ${url}`);
  }) as typeof axios.post;

  const previous = {
    backend: config.mediaResourceBackend,
    baseUrl: config.runclaveResourceBaseUrl,
    providerId: config.runclaveSharedProviderId,
    sharedRoot: config.runclaveSharedRoot,
    token: config.runclaveResourceApiToken
  };
  config.mediaResourceBackend = "runclave";
  config.runclaveResourceBaseUrl = "http://runclave.test";
  config.runclaveSharedProviderId = "nas_test";
  config.runclaveSharedRoot = root;
  config.runclaveResourceApiToken = "rcr_test_resource_token";

  try {
    const client = new AssetClient();
    assert.equal(
      await client.materialize("runclave-resource://res_input", "tenant", path.join(root, "tmp")),
      inputPath
    );
    const output = await client.importLocal(generatedPath, "output.png", "tenant", "job_test");
    assert.equal(output.resource_id, "res_output");
    assert.equal(output.uri, "runclave-resource://res_output");
    assert.equal(metadataAuthorization, "Bearer rcr_test_resource_token");
    assert.equal(registrationAuthorization, "Bearer rcr_test_resource_token");
    assert.equal(registeredBody?.subjectType, "external_job");
    assert.equal(registeredBody?.subjectId, "job_test");
    assert.match(String(registeredBody?.storageKey), /^\.incoming\/video-server\//);
    assert.deepEqual(stagedBytes, Buffer.from("generated"));
    await assert.rejects(
      readFile(path.join(root, String(registeredBody?.storageKey))),
      /ENOENT/
    );
  } finally {
    config.mediaResourceBackend = previous.backend;
    config.runclaveResourceBaseUrl = previous.baseUrl;
    config.runclaveSharedProviderId = previous.providerId;
    config.runclaveSharedRoot = previous.sharedRoot;
    config.runclaveResourceApiToken = previous.token;
    axios.get = originalGet;
    axios.post = originalPost;
  }
});

test("Runclave registration retries transient failures and retains staging after final failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "video-runclave-retry-"));
  const generatedPath = path.join(root, "generated.png");
  await writeFile(generatedPath, Buffer.from("keep-me"));
  const originalPost = axios.post;
  let storageKey = "";
  let attempts = 0;
  axios.post = (async (_url: string, body: Record<string, unknown>) => {
    attempts += 1;
    storageKey = String(body.storageKey ?? "");
    throw new axios.AxiosError("socket reset", "ECONNRESET");
  }) as typeof axios.post;
  const previous = {
    backend: config.mediaResourceBackend,
    sharedRoot: config.runclaveSharedRoot,
    maxAttempts: config.runclaveRegisterMaxAttempts,
    retryBaseMs: config.runclaveRegisterRetryBaseMs
  };
  config.mediaResourceBackend = "runclave";
  config.runclaveSharedRoot = root;
  config.runclaveRegisterMaxAttempts = 2;
  config.runclaveRegisterRetryBaseMs = 1;
  try {
    await assert.rejects(
      new AssetClient().importLocal(generatedPath, "generated.png", "tenant", "job_retry"),
      /ECONNRESET/
    );
    assert.equal(attempts, 2);
    assert.equal(await readFile(path.join(root, storageKey), "utf8"), "keep-me");
  } finally {
    config.mediaResourceBackend = previous.backend;
    config.runclaveSharedRoot = previous.sharedRoot;
    config.runclaveRegisterMaxAttempts = previous.maxAttempts;
    config.runclaveRegisterRetryBaseMs = previous.retryBaseMs;
    axios.post = originalPost;
  }
});
