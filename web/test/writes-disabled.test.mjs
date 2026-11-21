import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function source(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

test("Salesforce write calls are gone from the merge path", () => {
  const executor = source("backend/merging/merge_executor.py");
  const routes = source("backend/api/routes_merge.py");
  const related = source("backend/merging/related_data.py");
  const combined = `${executor}\n${routes}\n${related}`;

  assert.equal(combined.includes("sf.Account"), false);
  assert.equal(combined.includes(".delete("), false);
  assert.equal(combined.includes("SOAPAction"), false);
  assert.equal(combined.includes("get_sf_client"), false);
  assert.equal(combined.includes("simple_salesforce"), false);
  assert.equal(combined.includes("http_requests.post"), false);
  assert.match(executor, /Read-only mode/);
  assert.match(routes, /status_code=403/);
});

test("the legacy UI cannot call merge or set-parent", () => {
  const api = source("frontend/js/api.js");
  const list = source("frontend/js/components/group-list.js");
  const detail = source("frontend/js/components/group-detail.js");
  const wizard = source("frontend/js/components/merge-wizard.js");

  assert.match(api, /Salesforce merge is disabled/);
  assert.match(api, /Salesforce parent updates are disabled/);
  assert.equal(api.includes("/merge/execute/"), false);
  assert.equal(api.includes("/merge/set-parent/"), false);
  assert.equal(list.includes("btn-merge-selected"), false);
  assert.equal(list.includes("btn-set-parent"), false);
  assert.equal(list.includes("quick-merge-btn"), false);
  assert.equal(detail.includes("btn-merge"), false);
  assert.equal(detail.includes("btn-set-parent"), false);
  assert.match(wizard, /Salesforce merges and parent updates are disabled/);
  assert.equal(wizard.includes("Api.executeMerge"), false);
  assert.equal(wizard.includes("Api.setParent"), false);
});
