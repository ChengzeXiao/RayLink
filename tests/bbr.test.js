import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BbrManager } from "../server/bbr.js";

test("BBR initialization persists fq and bbr before verifying the live kernel", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-bbr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "99-raylink-bbr.conf");
  const commands = [];
  let applied = false;
  const manager = new BbrManager({
    mode: "systemd",
    platform: "linux",
    configPath,
    async runCommand(command, args) {
      commands.push([command, ...args]);
      if (command === "modprobe") return { stdout: "", stderr: "" };
      if (args[0] === "-p") {
        applied = true;
        return { stdout: "", stderr: "" };
      }
      const key = args[1];
      if (key === "net.ipv4.tcp_available_congestion_control") {
        return { stdout: "reno cubic bbr\n", stderr: "" };
      }
      if (key === "net.ipv4.tcp_congestion_control") {
        return { stdout: applied ? "bbr\n" : "cubic\n", stderr: "" };
      }
      if (key === "net.core.default_qdisc") {
        return { stdout: applied ? "fq\n" : "fq_codel\n", stderr: "" };
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    }
  });

  assert.deepEqual(await manager.inspect(), {
    status: "available",
    congestionControl: "cubic",
    qdisc: "fq_codel"
  });
  assert.deepEqual(await manager.configure(), {
    status: "enabled",
    congestionControl: "bbr",
    qdisc: "fq"
  });
  assert.equal(
    await readFile(configPath, "utf8"),
    [
      "# Managed by RayLink. Changes may be replaced during initialization.",
      "net.core.default_qdisc = fq",
      "net.ipv4.tcp_congestion_control = bbr",
      ""
    ].join("\n")
  );
  assert.ok(commands.some((command) => command.join(" ") === "modprobe tcp_bbr"));
  assert.ok(commands.some((command) => command.join(" ") === `sysctl -p ${configPath}`));
});

test("BBR initialization rejects an unsupported kernel without writing configuration", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-bbr-unsupported-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "99-raylink-bbr.conf");
  const manager = new BbrManager({
    mode: "systemd",
    platform: "linux",
    configPath,
    async runCommand(command, args) {
      if (command === "modprobe") throw new Error("module not found");
      const key = args[1];
      if (key === "net.ipv4.tcp_available_congestion_control") {
        return { stdout: "reno cubic\n", stderr: "" };
      }
      if (key === "net.ipv4.tcp_congestion_control") {
        return { stdout: "cubic\n", stderr: "" };
      }
      if (key === "net.core.default_qdisc") {
        return { stdout: "fq_codel\n", stderr: "" };
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    }
  });

  await assert.rejects(
    () => manager.configure(),
    (error) => error.code === "BBR_UNAVAILABLE"
      && error.statusCode === 409
      && /内核不支持 BBR/.test(error.message)
  );
  await assert.rejects(() => readFile(configPath, "utf8"), /ENOENT/);
});

test("BBR reports unsupported on non-Linux hosts without invoking privileged commands", async () => {
  const manager = new BbrManager({
    mode: "systemd", platform: "darwin",
    runCommand() { throw new Error("must not execute a Linux command on macOS"); }
  });
  assert.equal((await manager.inspect()).status, "unsupported");
  await assert.rejects(manager.configure(), { code: "BBR_UNAVAILABLE" });
});

test("BBR never reports enabled when applying kernel parameters is denied", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-bbr-denied-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new BbrManager({
    mode: "systemd", platform: "linux", configPath: join(directory, "bbr.conf"),
    async runCommand(command, args) {
      if (command === "modprobe") return { stdout: "" };
      if (args[0] === "-p") throw new Error("permission denied");
      return { stdout: args[1].includes("available") ? "cubic bbr" : args[1].includes("qdisc") ? "fq_codel" : "cubic" };
    }
  });
  await assert.rejects(manager.configure(), { code: "BBR_APPLY_FAILED" });
  assert.deepEqual(await manager.inspect(), {
    status: "failed", congestionControl: "cubic", qdisc: "fq_codel", error: "BBR 内核参数应用失败"
  });
});
