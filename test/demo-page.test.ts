import assert from "node:assert/strict";
import test from "node:test";
import { demoPage } from "../src/demo-page.js";

test("demo page exposes job and MCP controls without persisting credentials", () => {
  assert.match(demoPage, /id="token"/);
  assert.match(demoPage, /fetch\(url/);
  assert.match(demoPage, /list_media_workflows/);
  assert.match(demoPage, /get_media_job/);
  assert.match(demoPage, /create_media_job/);
  assert.match(demoPage, /id="workflow"/);
  assert.match(demoPage, /id="asset-fields"/);
  assert.match(demoPage, /class="asset-input"/);
  assert.match(demoPage, /\/jobs/);
  assert.match(demoPage, /\/mcp/);
  assert.doesNotMatch(demoPage, /localStorage|sessionStorage/);
});
