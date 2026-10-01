import assert from "node:assert/strict";
import test from "node:test";
import { V2RayStatsCollector } from "../server/usage/v2ray-stats.js";

test("a Runtime restart during collection never labels new counters with the old instance", async () => {
  let instance = "runtime-a";
  const collector = new V2RayStatsCollector({
    runtimeInstanceProvider: async () => instance,
    query: async () => {
      instance = "runtime-b";
      return [{ name: "user>>>usage@example.com>>>traffic>>>uplink", value: 150 }];
    }
  });
  await assert.rejects(collector.collect(), /Runtime.*(?:变化|重启)/);
  const stable = await collector.collect();
  assert.equal(stable.runtimeInstanceId, "runtime-b");
  assert.equal(stable.users[0].uplinkBytes, 150);
});
