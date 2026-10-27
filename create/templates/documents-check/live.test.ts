// documents-check on a stack: the whole pipeline, with LBB's own parts. A
// graph is created, the pipeline is set up on it, the three sample PDFs are
// uploaded, and your worker's two workflows run in this process. The test waits
// for the three review items and checks their quotes against the answer key. It
// deletes the invoice, to see the items withdrawn, and removes the graph afterwards.
//
// It runs only with an explicit opt-in: LBB_LIVE_TEST=1, with LBB_URL and
// LBB_API_KEY naming a stack. It creates and deletes a graph there, so it never
// runs by accident on a stack that holds data. Its expectations hold for a stack
// whose model roles are mocks, which read `label: value` lines
// (`npm run dev:stack` prints the URL and the key):
//
//   LBB_LIVE_TEST=1 LBB_URL=http://127.0.0.1:7400 LBB_API_KEY=lbb_sk_test_local \
//     npx tsx --test src/live.test.ts
//
// The project's `npm test` runs workflow.test.ts only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { LbbClient, WorkflowWorker, lbbActivities } from "@littlebigbrain/client";
import { readJson, samplesDir } from "../_shared/testing.js";
import { checkPorts } from "./check.js";
import { loadSamples } from "./samples.js";
import { createWorkflows, setup } from "./workflow.js";

const SAMPLES = samplesDir(import.meta.url, "documents-check");
const KEY = readJson<{
  checks: { id: string; result: string; quotes?: { record: string; quote: string }[] }[];
}>(join(SAMPLES, "expected.json"));

const url = process.env.LBB_URL;
const apiKey = process.env.LBB_API_KEY;
const optedIn = process.env.LBB_LIVE_TEST === "1";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  "the pipeline files the three differences of the samples on a stack, and withdraws them when the invoice is deleted",
  {
    skip:
      !(optedIn && url && apiKey) &&
      "set LBB_LIVE_TEST=1, LBB_URL and LBB_API_KEY to run it on a stack",
    timeout: 240_000,
  },
  async () => {
    const graph = `documents-check-${Date.now().toString(36)}`;
    const client = new LbbClient({ baseUrl: url!, apiKey, graph });
    await client.graph(graph).create();
    const stop = new AbortController();
    let worker: Promise<void> | undefined;
    try {
      const lbb = lbbActivities(client);
      await setup(client, lbb);
      worker = new WorkflowWorker(client, createWorkflows(lbb, checkPorts(client)), {
        worker: "documents-check-live-test",
      }).run({ signal: stop.signal });
      await loadSamples(client, SAMPLES);

      const expected = KEY.checks.filter((c) => c.result === "violation");
      let items: Awaited<ReturnType<typeof client.reviews.list>>["data"] = [];
      for (let waited = 0; waited < 200_000; waited += 2_000) {
        items = (
          await client.reviews.list({
            originId: "starter:documents-check",
            status: "open",
            kind: "choice",
          })
        ).data;
        if (items.length >= expected.length) break;
        await sleep(2_000);
      }
      // One more look, to see that nothing is filed twice.
      await sleep(5_000);
      items = (
        await client.reviews.list({
          originId: "starter:documents-check",
          status: "open",
          kind: "choice",
        })
      ).data;
      assert.equal(items.length, expected.length, items.map((i) => i.title).join("\n"));

      for (const check of expected) {
        const found = items.find((item) => item.key.split(":")[2] === check.id);
        assert.ok(found, `no item for ${check.id}`);
        const item = await client.reviews.get(found.id);
        assert.deepEqual(
          item.evidence?.map((e) => e.quote),
          check.quotes!.map((q) => q.quote),
          `${check.id}: the quotes of both documents`,
        );
        assert.ok(
          item.evidence?.every((e) => /#page=1$/.test(e.source_id ?? "") && e.region),
          `${check.id}: each quote names its page and its box`,
        );
      }

      // Delete the invoice. Every difference was about it, so the check withdraws every item.
      const invoice = (await client.files.list()).files.find((f) => f.name === "invoice.pdf");
      assert.ok(invoice, "the invoice is a file of the graph");
      await client.files.delete(invoice.sha256);
      for (let waited = 0; waited < 120_000; waited += 2_000) {
        items = (
          await client.reviews.list({
            originId: "starter:documents-check",
            status: "open",
            kind: "choice",
          })
        ).data;
        if (items.length === 0) break;
        await sleep(2_000);
      }
      assert.deepEqual(
        items.map((item) => item.title),
        [],
        "a deleted file leaves no open item",
      );
    } finally {
      stop.abort();
      await worker?.catch(() => undefined);
      await client.graph(graph).delete({ confirm: graph });
    }
  },
);
