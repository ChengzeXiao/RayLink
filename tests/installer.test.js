import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SingBoxInstaller } from "../server/singbox/installer.js";

test("runtime inspection parses version, platform and build tags", async () => {
  const installer = new SingBoxInstaller({
    binaryPath: "sing-box",
    platform: "darwin",
    runner: async () => ({
      stdout: [
        "sing-box version 1.13.12",
        "",
        "Environment: go1.26.5 darwin/arm64",
        "Tags: with_quic,with_utls,with_acme"
      ].join("\n")
    })
  });

  assert.deepEqual(await installer.status(), {
    installed: true,
    version: "1.13.12",
    platform: "darwin",
    architecture: "arm64",
    tags: ["with_quic", "with_utls", "with_acme"],
    binaryPath: "sing-box"
  });
});

test("one-click installer uses the fixed official package command for macOS", async () => {
  const calls = [];
  const installer = new SingBoxInstaller({
    binaryPath: "sing-box",
    platform: "darwin",
    runner: async (file, args) => {
      calls.push([file, args]);
      if (file === "sing-box" && calls.length === 1) {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
      if (file === "sing-box") {
        return { stdout: "sing-box version 1.13.12\nEnvironment: go1.26.5 darwin/arm64\nTags: with_quic" };
      }
      return { stdout: "" };
    }
  });

  const result = await installer.install();
  assert.equal(result.installed, true);
  assert.deepEqual(calls[1], ["brew", ["install", "sing-box"]]);
});

test("Linux one-click installation uses only the approved metered builder", async () => {
  const calls = [];
  const binaryPath = "/usr/local/bin/raylink-sing-box";
  let built = false;
  const installer = new SingBoxInstaller({
    binaryPath,
    platform: "linux",
    runner: async (file, args) => {
      calls.push([file, args]);
      if (file === binaryPath && !built) {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
      if (file === "sh") {
        built = true;
        return { stdout: "" };
      }
      return {
        stdout: "sing-box version 1.14.2\nEnvironment: go1.24.7 linux/amd64\nTags: with_quic,with_v2ray_api"
      };
    }
  });

  assert.equal((await installer.install()).installed, true);
  assert.deepEqual(calls[1], [
    "sh",
    [installer.meteredRuntimeBuilder, "1.14.2", binaryPath]
  ]);
  assert.equal(calls.some(([, args]) => args[0] === "-c"), false);
});

test("Linux one-click installation prefers the packaged Runtime artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-release-install-"));
  const runtimeArtifactDir = join(directory, "runtime");
  const binaryPath = join(directory, "raylink-sing-box");
  const artifactPath = join(
    runtimeArtifactDir,
    "raylink-sing-box-1.14.2-linux-amd64"
  );
  const artifact = Buffer.from("precompiled-runtime");
  const cronetPath = join(
    runtimeArtifactDir,
    "raylink-libcronet-1.14.2-linux-amd64.so"
  );
  const cronetArtifact = Buffer.from("precompiled-cronet");
  const checksum = createHash("sha256").update(artifact).digest("hex");
  const cronetChecksum = createHash("sha256").update(cronetArtifact).digest("hex");
  await mkdir(runtimeArtifactDir);
  await writeFile(artifactPath, artifact);
  await writeFile(`${artifactPath}.sha256`, `${checksum}  ${artifactPath}\n`);
  await writeFile(cronetPath, cronetArtifact);
  await writeFile(`${cronetPath}.sha256`, `${cronetChecksum}  ${cronetPath}\n`);
  let builderCalls = 0;
  const installer = new SingBoxInstaller({
    binaryPath,
    platform: "linux",
    runtimeArch: "x64",
    runtimeArtifactDir,
    runner: async (file) => {
      if (file === "sh") builderCalls += 1;
      if (file === binaryPath) {
        try {
          await readFile(binaryPath);
        } catch (error) {
          error.code = "ENOENT";
          throw error;
        }
        return {
          stdout: "sing-box version 1.14.2\nEnvironment: go1.24.7 linux/amd64\nTags: with_quic,with_v2ray_api"
        };
      }
      return { stdout: "" };
    }
  });

  const installed = await installer.install();

  assert.equal(installed.version, "1.14.2");
  assert.equal(builderCalls, 0);
  assert.deepEqual(await readFile(binaryPath), artifact);
  assert.deepEqual(await readFile(join(directory, "libcronet.so")), cronetArtifact);
});

test("production installer rebuilds a compatible Linux Runtime with user metering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-metered-install-"));
  const binaryPath = join(directory, "raylink-sing-box");
  const calls = [];
  let metered = false;
  const installer = new SingBoxInstaller({
    binaryPath,
    platform: "linux",
    preferMeteredRuntime: true,
    meteredRuntimeBuilder: "/opt/raylink/build-metered-runtime.sh",
    runner: async (file, args) => {
      calls.push([file, args]);
      if (file === "sh" && args[0] === "/opt/raylink/build-metered-runtime.sh") {
        metered = true;
        return { stdout: "" };
      }
      return {
        stdout: [
          "sing-box version 1.14.2",
          "Environment: go1.26.5 linux/amd64",
          `Tags: with_quic${metered ? ",with_v2ray_api" : ""}`
        ].join("\n")
      };
    }
  });

  const installation = await installer.install();

  assert.equal(installation.version, "1.14.2");
  assert.equal(installation.tags.includes("with_v2ray_api"), true);
  assert.ok(calls.some(([file, args]) => (
    file === "sh"
    && args.join(" ") === `/opt/raylink/build-metered-runtime.sh 1.14.2 ${binaryPath}`
  )));
  assert.equal(calls.some(([, args]) => args[0] === "-c"), false);
});

test("one-click installer replaces a mismatched Linux sing-box version", async () => {
  const calls = [];
  let version = "1.12.9";
  const installer = new SingBoxInstaller({
    binaryPath: "sing-box",
    platform: "linux",
    runner: async (file, args) => {
      calls.push([file, args]);
      if (file === "sh") {
        version = "1.14.2";
        return { stdout: "" };
      }
      return {
        stdout: `sing-box version ${version}\nEnvironment: go1.26.5 linux/amd64\nTags: with_quic,with_v2ray_api`
      };
    }
  });

  assert.equal((await installer.install()).version, "1.14.2");
  assert.deepEqual(calls[1], [
    "sh",
    [installer.meteredRuntimeBuilder, "1.14.2", "/usr/local/bin/raylink-sing-box"]
  ]);
});

test("one-click installer keeps an approved metering-capable Runtime", async () => {
  const calls = [];
  const installer = new SingBoxInstaller({
    binaryPath: "sing-box",
    platform: "linux",
    runner: async (file, args) => {
      calls.push([file, args]);
      return {
        stdout: "sing-box version 1.14.2\nEnvironment: go1.26.5 linux/amd64\nTags: with_quic,with_v2ray_api"
      };
    }
  });

  const installation = await installer.install();

  assert.equal(installation.version, "1.14.2");
  assert.equal(installation.alreadyInstalled, true);
  assert.equal(calls.length, 1);
});

test("one-click installer rejects an unsupported newer Runtime instead of silently accepting it", async () => {
  const installer = new SingBoxInstaller({
    binaryPath: "sing-box",
    platform: "linux",
    runner: async () => ({
      stdout: "sing-box version 1.15.0\nEnvironment: go1.27.0 linux/amd64\nTags: with_quic"
    })
  });

  await assert.rejects(
    installer.install(),
    (error) => error.code === "RUNTIME_VERSION_UNSUPPORTED"
  );
});

test("one-click installer rejects a concurrent package-manager run", async () => {
  let releaseProbe;
  const probeBlocked = new Promise((resolve) => {
    releaseProbe = resolve;
  });
  let singBoxCalls = 0;
  const installer = new SingBoxInstaller({
    platform: "darwin",
    runner: async (file) => {
      if (file === "sing-box") {
        singBoxCalls += 1;
        if (singBoxCalls === 1) {
          await probeBlocked;
          const error = new Error("missing");
          error.code = "ENOENT";
          throw error;
        }
        return { stdout: "sing-box version 1.13.12\nEnvironment: go1.26.5 darwin/arm64\nTags: with_quic" };
      }
      return { stdout: "" };
    }
  });

  const firstInstall = installer.install();
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    installer.install(),
    (error) => error.code === "INSTALLATION_IN_PROGRESS"
  );
  releaseProbe();
  assert.equal((await firstInstall).installed, true);
});

test("runtime update check offers only the approved metered release", async () => {
  const installer = new SingBoxInstaller({
    platform: "linux",
    runner: async () => ({
      stdout: "sing-box version 1.13.12\nEnvironment: go1.26.5 linux/amd64\nTags: with_quic"
    }),
    fetchImpl: async () => new Response(JSON.stringify({
      tag_name: "v1.14.3",
      prerelease: false,
      draft: false,
      html_url: "https://github.com/SagerNet/sing-box/releases/tag/v1.14.3",
      published_at: "2026-07-25T08:00:00Z"
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  });

  const update = await installer.checkForUpdates();

  assert.equal(update.currentVersion, "1.13.12");
  assert.equal(update.latestVersion, "1.14.2");
  assert.equal(update.discoveredVersion, "1.14.3");
  assert.equal(update.updateAvailable, true);
  assert.equal(update.compatible, true);
  assert.match(update.approvalNotice, /1\.14\.3.*尚未进入/);
  assert.equal(installer.releaseStatus().latestVersion, "1.14.2");
});

test("runtime update check offers a same-version rebuild when metering is missing", async () => {
  const installer = new SingBoxInstaller({
    platform: "linux",
    runner: async () => ({
      stdout: "sing-box version 1.14.2\nEnvironment: go1.24.7 linux/amd64\nTags: with_quic"
    }),
    fetchImpl: async () => new Response(JSON.stringify({
      tag_name: "v1.14.3",
      prerelease: false,
      draft: false,
      html_url: "https://github.com/SagerNet/sing-box/releases/tag/v1.14.3"
    }), { status: 200 })
  });

  const update = await installer.checkForUpdates();
  assert.equal(update.latestVersion, "1.14.2");
  assert.equal(update.meteringMigrationRequired, true);
  assert.equal(update.updateAvailable, true);
});

test("runtime update check falls back to the official latest-release redirect when the API is rate limited", async () => {
  let fetchCalls = 0;
  const installer = new SingBoxInstaller({
    platform: "linux",
    runner: async () => ({
      stdout: "sing-box version 1.13.12\nEnvironment: go1.26.5 linux/amd64\nTags: with_quic"
    }),
    fetchImpl: async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) return { ok: false, status: 403 };
      return {
        ok: true,
        status: 200,
        url: "https://github.com/SagerNet/sing-box/releases/tag/v1.14.2"
      };
    }
  });

  const update = await installer.checkForUpdates();

  assert.equal(fetchCalls, 2);
  assert.equal(update.latestVersion, "1.14.2");
  assert.equal(update.updateAvailable, true);
  assert.equal(update.releaseUrl, "https://github.com/SagerNet/sing-box/releases/tag/v1.14.2");
});

test("runtime upgrade validates the active config and restarts the service", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-upgrade-success-"));
  const binaryPath = join(directory, "sing-box");
  const configPath = join(directory, "config.json");
  await writeFile(binaryPath, "previous-binary");
  await writeFile(configPath, "{}");
  let version = "1.13.12";
  const calls = [];
  const installer = new SingBoxInstaller({
    binaryPath,
    dataDir: directory,
    activeConfigPath: configPath,
    platform: "linux",
    runtimeMode: "systemd",
    systemdUnit: "raylink-sing-box.service",
    healthCheckDelayMs: 0,
    runner: async (file, args) => {
      calls.push([file, args]);
      if (file === "sh") {
        version = args[1] || version;
        await writeFile(binaryPath, "candidate-binary");
        return { stdout: "" };
      }
      if (file === "systemctl" && args[0] === "is-active") return { stdout: "active\n" };
      if (file === binaryPath && args[0] === "version") {
        return {
          stdout: `sing-box version ${version}\nEnvironment: go1.26.5 linux/amd64\nTags: with_quic,with_v2ray_api`
        };
      }
      return { stdout: "" };
    }
  });

  const upgraded = await installer.upgrade("1.14.2");

  assert.equal(upgraded.version, "1.14.2");
  assert.equal(await readFile(binaryPath, "utf8"), "candidate-binary");
  assert.ok(calls.some(([file, args]) => file === binaryPath && args.join(" ") === `check -c ${configPath}`));
  assert.ok(calls.some(([file, args]) => file === "systemctl" && args.join(" ") === "restart raylink-sing-box.service"));
});

test("online upgrade preserves the with_v2ray_api metering build", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-metered-upgrade-"));
  const binaryPath = join(directory, "raylink-sing-box");
  const configPath = join(directory, "config.json");
  await writeFile(binaryPath, "metered-binary");
  await writeFile(configPath, "{}");
  let version = "1.13.12";
  const calls = [];
  const installer = new SingBoxInstaller({
    binaryPath,
    dataDir: directory,
    activeConfigPath: configPath,
    platform: "linux",
    runtimeMode: "systemd",
    systemdUnit: "raylink-sing-box.service",
    meteredRuntimeBuilder: "/opt/raylink/build-metered-runtime.sh",
    healthCheckDelayMs: 0,
    runner: async (file, args) => {
      calls.push([file, args]);
      if (file === "sh" && args[0] === "/opt/raylink/build-metered-runtime.sh") {
        version = args[1];
        await writeFile(binaryPath, "upgraded-metered-binary");
        return { stdout: "" };
      }
      if (file === "systemctl" && args[0] === "is-active") return { stdout: "active\n" };
      if (file === binaryPath && args[0] === "version") {
        return {
          stdout: `sing-box version ${version}\nEnvironment: go1.26.5 linux/amd64\nTags: with_quic,with_v2ray_api`
        };
      }
      return { stdout: "" };
    }
  });

  const upgraded = await installer.upgrade("1.14.2");

  assert.equal(upgraded.version, "1.14.2");
  assert.ok(calls.some(([file, args]) => (
    file === "sh"
    && args.join(" ") === `/opt/raylink/build-metered-runtime.sh 1.14.2 ${binaryPath}`
  )));
  assert.equal(calls.some(([, args]) => args[0] === "-c"), false);
});

test("failed runtime upgrade restores the previous binary and service", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-upgrade-rollback-"));
  const binaryPath = join(directory, "sing-box");
  const configPath = join(directory, "config.json");
  await writeFile(binaryPath, "previous-binary");
  await writeFile(configPath, "{}");
  let version = "1.13.12";
  let restarts = 0;
  const systemdCalls = [];
  const installer = new SingBoxInstaller({
    binaryPath,
    dataDir: directory,
    activeConfigPath: configPath,
    platform: "linux",
    runtimeMode: "systemd",
    systemdUnit: "raylink-sing-box.service",
    healthCheckDelayMs: 0,
    runner: async (file, args) => {
      if (file === "systemctl") systemdCalls.push(args.join(" "));
      if (file === "sh") {
        version = args[1] || version;
        await writeFile(binaryPath, "broken-binary");
        return { stdout: "" };
      }
      if (file === binaryPath && args[0] === "version") {
        const binary = await readFile(binaryPath, "utf8");
        const reportedVersion = binary === "previous-binary" ? "1.13.12" : version;
        return {
          stdout: `sing-box version ${reportedVersion}\nEnvironment: go1.26.5 linux/amd64\nTags: with_quic,with_v2ray_api`
        };
      }
      if (file === binaryPath && args[0] === "check") throw new Error("candidate rejected config");
      if (file === "systemctl" && args[0] === "restart") {
        restarts += 1;
        return { stdout: "" };
      }
      if (file === "systemctl" && args[0] === "list-unit-files") {
        return { stdout: "sing-box.service enabled\n" };
      }
      if (file === "systemctl" && args[0] === "is-enabled") {
        return { stdout: "enabled\n" };
      }
      if (file === "systemctl" && args[0] === "is-active") {
        return { stdout: args[1] === "sing-box.service" ? "inactive\n" : "active\n" };
      }
      return { stdout: "active\n" };
    }
  });

  await assert.rejects(
    installer.upgrade("1.14.2"),
    (error) => error.code === "RUNTIME_UPGRADE_ROLLED_BACK"
  );
  assert.equal(await readFile(binaryPath, "utf8"), "previous-binary");
  assert.equal(restarts, 1);
  assert.ok(systemdCalls.includes("enable sing-box.service"));
  assert.ok(systemdCalls.includes("stop sing-box.service"));
  assert.equal(systemdCalls.includes("disable --now sing-box.service"), false);
});
