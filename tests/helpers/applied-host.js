import { buildSingBoxConfig } from "../../server/singbox/config.js";

// Store metering tests use a completed real compilation as authorization
// evidence, matching the production Node task completion boundary.
export function applyRemoteRuntime(store, remote) {
  if (!store.getHost(remote.host.id).enrolledAt) store.enrollNode(remote.enrollmentToken);
  store.updateHostProtocolConfig(remote.host.id, "vmess", { enabled: true });
  store.queueNodeTask(remote.host.id, "publish-config", {
    configText: JSON.stringify(buildSingBoxConfig(store.runtimeSnapshot(remote.host.id)))
  });
  const task = store.nextNodeTask(remote.host.id);
  store.completeNodeTask(remote.host.id, task.id, { attempt: task.attempt, status: "succeeded" });
}
