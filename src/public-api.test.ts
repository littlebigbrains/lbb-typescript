import { test } from "node:test";
import assert from "node:assert/strict";
import * as sdk from "./index.js";

test("the runtime entrypoint exposes only the supported public values", () => {
  assert.deepEqual(Object.keys(sdk).sort(), [
    "ENTITY_ID_KEY_SENTINEL",
    "ENTITY_IRI_NAMESPACE",
    "LbbCapabilityError",
    "LbbClient",
    "LbbError",
    "WorkflowError",
    "WorkflowHandle",
    "WorkflowNamespace",
    "WorkflowWorker",
    "entityIdFromIri",
    "entityRef",
    "googleDrive",
    "isActivityRefused",
    "lbbActivities",
    "parseSparqlResults",
    "parseTriggerMessage",
    "splitInHalves",
    "starters",
    "triggeredWorkflow",
    "workflow",
    "writeOwned",
  ]);
});

test("the public client can be constructed through the package entrypoint", () => {
  const client = new sdk.LbbClient({
    baseUrl: "http://example.test",
    fetch: async () => ({ ok: true, status: 200, text: async () => "{}" }),
  });

  assert.ok(client instanceof sdk.LbbClient);
  assert.ok(new sdk.LbbError(400, "bad request") instanceof Error);
});
