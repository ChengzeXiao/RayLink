import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readApprovedRuleSetResponse } from "../server/routing/rule-sets/approved-response.js";

function openResponse(chunks, { headers, status = 200 } = {}) {
  let cancellations = 0;
  const body = new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(Buffer.from(chunk)); },
    cancel() { cancellations++; }
  });
  return { response: new Response(body, { headers, status }), cancellations: () => cancellations };
}

test("approved artifact reader validates the actual stream with and without Content-Length", async () => {
  for (const headers of [{}, { "content-length": "8" }, { "content-length": "0008" }]) {
    const response = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from("SRS-")); controller.enqueue(Buffer.from("data")); controller.close();
    } }), { headers });
    assert.equal((await readApprovedRuleSetResponse(response, 8)).toString(), "SRS-data");
    assert.equal(response.body.locked, false);
  }
});

test("overlong streams are cancelled immediately even with a plausible Content-Length", async () => {
  for (const headers of [{}, { "content-length": "8" }]) {
    const fixture = openResponse(["SRS-data", "too much"], { headers });
    await assert.rejects(readApprovedRuleSetResponse(fixture.response, 8), /exceeds approved size/);
    assert.equal(fixture.cancellations(), 1);
    assert.equal(fixture.response.body.locked, false);
  }
});

test("truncated response is rejected after EOF even when its header claims the approved length", async () => {
  for (const headers of [{}, { "content-length": "8" }]) {
    await assert.rejects(readApprovedRuleSetResponse(new Response("short", { headers }), 8), /Truncated/);
  }
});

test("malformed, unsafe and mismatched Content-Length cancel without consuming the body", async () => {
  for (const length of ["-1", "1e3", "8.0", "garbage", "9007199254740992", "33554433", "7", "9"]) {
    const fixture = openResponse(["SRS-data"], { headers: { "content-length": length } });
    await assert.rejects(readApprovedRuleSetResponse(fixture.response, 8), /Content-Length/);
    assert.equal(fixture.cancellations(), 1, length);
  }
});

test("decoded Fetch bodies use the decoded budget while still validating wire Content-Length", async () => {
  const response = new Response("SRS-data", { headers: { "content-encoding": "gzip", "content-length": "4" } });
  assert.equal((await readApprovedRuleSetResponse(response, 8)).toString(), "SRS-data");
  const fixture = openResponse(["SRS-data-overlong"], { headers: { "content-encoding": "gzip", "content-length": "4" } });
  await assert.rejects(readApprovedRuleSetResponse(fixture.response, 8), /exceeds approved size/);
  assert.equal(fixture.cancellations(), 1);
});

test("HTTP failures and invalid approved sizes cancel unread bodies", async () => {
  const http = openResponse(["error"], { status: 503 });
  await assert.rejects(readApprovedRuleSetResponse(http.response, 8), /HTTP 503/);
  assert.equal(http.cancellations(), 1);
  for (const length of [0, -1, 1.5, Number.MAX_SAFE_INTEGER, 32 * 1024 * 1024 + 1]) {
    const fixture = openResponse(["SRS-data"]);
    await assert.rejects(readApprovedRuleSetResponse(fixture.response, length), /Invalid approved/);
    assert.equal(fixture.cancellations(), 1);
  }
});

test("transport read failures retain their cause without disguising them as checksum failures", async () => {
  const cause = new Error("fixture transport interrupted");
  const response = new Response(new ReadableStream({ start(controller) { controller.error(cause); } }));
  await assert.rejects(readApprovedRuleSetResponse(response, 8), error => error.message === "Approved rule-set response read failed" && error.cause === cause);
  assert.equal(response.body.locked, false);
});

test("maintainer updater cancels an oversized download and never publishes a candidate directory", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-approved-download-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile(new URL("../server/routing/rule-sets/manifest.json", import.meta.url)));
  const approved = join(directory, "approved.json"), output = join(directory, "candidate"), marker = join(directory, "cancelled");
  await writeFile(approved, JSON.stringify(manifest));
  const injection = join(directory, "fetch-fixture.mjs");
  await writeFile(injection, `import { writeFileSync } from "node:fs";
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(${manifest.rules[0].bytes + 1})); },
      cancel() { writeFileSync(${JSON.stringify(marker)}, "cancelled"); }
    }));\n`);
  const result = spawnSync(process.execPath, ["--import", injection,
    new URL("../server/routing/rule-sets/update.mjs", import.meta.url).pathname, approved, output], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.error, undefined, "The updater must reject before waiting for a transport timeout");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /response exceeds approved size/);
  assert.equal(await readFile(marker, "utf8"), "cancelled");
  assert.equal(await stat(output).catch(error => error.code === "ENOENT" ? null : Promise.reject(error)), null);
  assert.deepEqual((await readdir(directory)).filter(name => name.startsWith(".raylink-rules-")), []);
});
