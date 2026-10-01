import { RayLinkStore } from "../../server/database.js";
import { NodeProvisioning } from "../../server/node-provisioning.js";

const store = new RayLinkStore({ dbPath: process.env.PROVISIONING_TEST_DB, adminUsername: "admin", adminPassword: "restart-test-password", seedDemoData: false });
const manager = new NodeProvisioning({ store, publicOrigin: () => "https://panel.example.com", sshBootstrap: {
  async connect() {
    return { fingerprint: `SHA256:${"a".repeat(43)}`, close() {}, async preflight() { return { existing: null }; },
      async install(input) {
        // This boundary represents the remote installer having persisted its
        // original enrollment environment before the controller loses power.
        process.send({ type: "installer-bound", hostId: input.hostId, enrollmentToken: input.enrollmentToken });
        await new Promise(() => {});
      }
    };
  }
} });
const job = manager.start({ requestId: "restart-boundary", host: "203.0.113.42", username: "root", password: "ephemeral-ssh-secret" }, store.listAdmins()[0].id);
process.send({ type: "job", jobId: job.id });
