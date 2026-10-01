import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import ssh2 from "ssh2";
import { SshBootstrap } from "../server/ssh-bootstrap.js";

const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
const hostFingerprint = `SHA256:${createHash("sha256").update(ssh2.utils.parseKey(hostKey).getPublicSSH()).digest("base64").replace(/=+$/, "")}`;
const userKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const userPrivateKey = userKeys.privateKey.export({ type: "pkcs1", format: "pem" });
const userPublicKey = ssh2.utils.parseKey(userPrivateKey);

test("SSH bootstrap trusts only the supplied control-plane certificate while downloading over real TLS", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-ssh-ca-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
    "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem")]);
  const certificate = await readFile(join(directory, "cert.pem"), "utf8");
  let downloads = 0;
  let existing = null;
  const server = createHttpsServer({ key: await readFile(join(directory, "key.pem")), cert: certificate }, (_request, response) => {
    downloads += 1;
    response.end('set -eu\n[ -s "$RAYLINK_CONTROL_CA_FILE" ]\n[ -n "${RAYLINK_ENROLL_TOKEN:-${RAYLINK_EXPECT_HOST_ID:-}}" ]\n');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `https://127.0.0.1:${server.address().port}`;
  const f = await fixture(t, { execute({ command, input, stream }) {
    if (command === "id -u") { stream.write("0\n"); stream.exit(0); stream.end(); return; }
    const preflight = input.includes("uname -s");
    const child = spawn("bash", preflight ? ["-n"] : ["-s"]);
    child.stdout.on("data", (chunk) => stream.write(chunk));
    child.stderr.on("data", (chunk) => stream.stderr.write(chunk));
    child.on("close", (code) => {
      if (preflight && code === 0) stream.write(`RAYLINK_SSH_OS=linux\nRAYLINK_SSH_ARCH=x86_64\nRAYLINK_SSH_SYSTEMD=yes\nRAYLINK_SSH_MISSING=\nRAYLINK_SSH_SCRIPT=yes\nRAYLINK_SSH_STATE=${JSON.stringify(existing)}\n`);
      stream.exit(code); stream.end();
    });
    child.stdin.end(input);
  } });
  const session = await new SshBootstrap().connect(f);
  t.after(() => session.close());
  const input = { server: origin, hostId: "ca-host", enrollmentToken: "test_enrollment_".repeat(3), controlPlaneCaCertificate: certificate };
  assert.equal((await session.install(input)).status, "installed");
  existing = { server: origin, hostId: "ca-host", enrolled: true };
  assert.equal((await session.install({ ...input, enrollmentToken: undefined })).status, "existing");
  assert.equal(downloads, 2, "enrolled Nodes still run the installer to repair explicitly supplied CA trust");
  existing = null;
  await assert.rejects(session.install({ ...input, controlPlaneCaCertificate: null }), { code: "SSH_REMOTE_FAILED" });
  await assert.rejects(session.install({ ...input, server: "https://192.0.2.5" }), { code: "SSH_CONTROL_CA_INVALID" });
  await assert.rejects(session.preflight({ server: origin, controlPlaneCaCertificate: userPrivateKey }), { code: "SSH_CONTROL_CA_INVALID" });
  assert.doesNotMatch(f.commands.join("\n"), /BEGIN CERTIFICATE|test_enrollment/);
  assert.doesNotMatch(f.inputs.join("\n"), /--insecure|curl -k\b|NODE_TLS_REJECT_UNAUTHORIZED/);
});

async function fixture(t, { execute, authenticate = true } = {}) {
  const connections = new Set();
  const commands = [];
  const inputs = [];
  const server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    connections.add(client);
    client.on("close", () => connections.delete(client));
    client.on("error", () => {});
    client.on("authentication", (ctx) => {
      if (!authenticate) return;
      if (ctx.username === "admin" && ctx.method === "password" && ctx.password === "ssh-test-password") ctx.accept();
      else if (ctx.username === "admin" && ctx.method === "publickey" && ctx.key.data.equals(userPublicKey.getPublicSSH())
        && (!ctx.signature || userPublicKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true)) ctx.accept();
      else ctx.reject();
    });
    client.on("ready", () => client.on("session", (accept) => {
      const session = accept();
      session.on("exec", (acceptExec, _reject, info) => {
        commands.push(info.command);
        const stream = acceptExec();
        let input = "";
        stream.on("data", (chunk) => { input += chunk; });
        stream.on("end", () => {
          inputs.push(input);
          if (execute) return execute({ command: info.command, input, stream });
          stream.write("0\n"); stream.exit(0); stream.end();
        });
      });
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const client of connections) client.end();
    await new Promise((resolve) => server.close(resolve));
  });
  return { host: "127.0.0.1", port: server.address().port, username: "admin", password: "ssh-test-password", commands, inputs };
}

test("SSH connects using password or private key and pins the actual server host key", async (t) => {
  const f = await fixture(t);
  const bootstrap = new SshBootstrap();
  const first = await bootstrap.connect(f);
  assert.equal(first.fingerprint, hostFingerprint);
  first.close();
  const keyed = await bootstrap.connect({ ...f, password: undefined, privateKey: userPrivateKey }, { expectedFingerprint: hostFingerprint });
  assert.equal(keyed.fingerprint, hostFingerprint);
  keyed.close();
  await assert.rejects(bootstrap.connect(f, { expectedFingerprint: `SHA256:${"A".repeat(43)}` }), { code: "SSH_HOST_KEY_MISMATCH" });
  await assert.rejects(bootstrap.connect({ ...f, password: "wrong-password" }), { code: "SSH_AUTHENTICATION_FAILED" });
  await assert.rejects(bootstrap.connect({ ...f, password: undefined, privateKey: hostKey }), { code: "SSH_AUTHENTICATION_FAILED" });
  const encryptedKey = userKeys.privateKey.export({ type: "pkcs1", format: "pem", cipher: "aes-256-cbc", passphrase: "test-key-passphrase" });
  const encrypted = await bootstrap.connect({ ...f, password: undefined, privateKey: encryptedKey, passphrase: "test-key-passphrase" });
  encrypted.close();
});

test("SSH preflight is read-only and returns only safe target identity and prerequisite evidence", async (t) => {
  const f = await fixture(t, { execute({ command, input, stream }) {
    if (command === "id -u") stream.write("0\n");
    else {
      assert.match(input, /uname -s/);
      assert.doesNotMatch(input, /apt-get install|systemctl (start|restart)|RAYLINK_ENROLL_TOKEN=/);
      stream.write('RAYLINK_SSH_OS=linux\nRAYLINK_SSH_ARCH=x86_64\nRAYLINK_SSH_SYSTEMD=yes\nRAYLINK_SSH_MISSING=curl\nRAYLINK_SSH_SCRIPT=no\nRAYLINK_SSH_STATE={"hostId":"host-1","server":"https://panel.example","enrolled":true}\n');
    }
    stream.exit(0); stream.end();
  } });
  const session = await new SshBootstrap().connect(f);
  t.after(() => session.close());
  const result = await session.preflight({ server: "https://panel.example" });
  assert.deepEqual(result, { os: "linux", architecture: "x86_64", systemd: true, privilege: "root",
    missingDependencies: ["curl"], scriptVerified: false, existing: { hostId: "host-1", server: "https://panel.example", enrolled: true } });
  await assert.rejects(session.preflight({ server: "https://panel.example/$(touch x)" }), { code: "SSH_INPUT_INVALID" });
});

test("SSH install keeps enrollment credentials out of command arguments and forwards only allowed stages", async (t) => {
  const f = await fixture(t, { execute({ command, input, stream }) {
    if (command === "id -u") stream.write("0\n");
    else if (input.includes("uname -s")) stream.write('RAYLINK_SSH_OS=linux\nRAYLINK_SSH_ARCH=x86_64\nRAYLINK_SSH_SYSTEMD=yes\nRAYLINK_SSH_MISSING=\nRAYLINK_SSH_SCRIPT=yes\nRAYLINK_SSH_STATE=null\n');
    else {
      assert.match(input, /RAYLINK_EXPECT_HOST_ID='host-1'/);
      assert.match(input, /bash -n/);
      stream.write("private password=NEVER_FORWARD\nRAYLINK_SSH_STAGE=download\nRAYLINK_SSH_STAGE=install\nRAYLINK_SSH_STAGE=complete\n");
      stream.stderr.write("secret=NEVER_FORWARD\n");
    }
    stream.exit(0); stream.end();
  } });
  const session = await new SshBootstrap().connect(f);
  t.after(() => session.close());
  const stages = [];
  const result = await session.install({ server: "https://panel.example", hostId: "host-1", enrollmentToken: "test_enrollment_".repeat(3), onStage: (stage) => stages.push(stage) });
  assert.deepEqual(result, { status: "installed", hostId: "host-1", server: "https://panel.example" });
  assert.deepEqual(stages, ["preflight", "download", "install", "complete"]);
  assert.doesNotMatch(JSON.stringify(f.commands), /test_enrollment_|ssh-test-password/);
  assert.doesNotMatch(JSON.stringify({ result, stages }), /NEVER_FORWARD/);
  await assert.rejects(session.install({ server: "https://panel.example", hostId: "host-1", enrollmentToken: "bad'; touch /tmp/injection; '" }), { code: "SSH_INPUT_INVALID" });
});

test("SSH preserves matching enrolled and pending identities and refuses a different Host", async (t) => {
  for (const enrolled of [true, false]) {
    const f = await fixture(t, { execute({ command, input, stream }) {
      if (command === "id -u") stream.write("0\n");
      else if (input.includes("uname -s")) stream.write(`RAYLINK_SSH_OS=linux\nRAYLINK_SSH_ARCH=x86_64\nRAYLINK_SSH_SYSTEMD=yes\nRAYLINK_SSH_MISSING=\nRAYLINK_SSH_SCRIPT=yes\nRAYLINK_SSH_STATE=${JSON.stringify({ hostId: "host-1", server: "https://panel.example", enrolled })}\n`);
      else {
        if (enrolled) {
          assert.match(input, /if ! systemctl is-active --quiet raylink-node.service/);
          assert.match(input, /systemctl start raylink-node.service/);
          assert.doesNotMatch(input, /RAYLINK_ENROLL_TOKEN|curl|raylink-sing-box/);
        } else {
          assert.match(input, /\/node\/install.sh/);
          assert.match(input, /RAYLINK_EXPECT_HOST_ID='host-1'/);
          assert.doesNotMatch(input, /export RAYLINK_ENROLL_TOKEN=/);
        }
      }
      stream.exit(0); stream.end();
    } });
    const session = await new SshBootstrap().connect(f);
    t.after(() => session.close());
    assert.equal((await session.install({ server: "https://panel.example", hostId: "host-1" })).status, "existing");
    assert.ok(f.inputs.some((input) => input.includes(enrolled ? "systemctl start raylink-node.service" : "export RAYLINK_EXPECT_HOST_ID=")), "Existing offline or partially installed Nodes must be resumed");
    await assert.rejects(session.install({ server: "https://panel.example", hostId: "other-host" }), { code: "SSH_EXISTING_NODE_CONFLICT" });
    await assert.rejects(session.install({ server: "https://other.example", hostId: "host-1" }), { code: "SSH_EXISTING_NODE_CONFLICT" });
  }
});

test("SSH bounds authentication and command timeouts and supports cancellation without raw diagnostics", async (t) => {
  const stalled = await fixture(t, { authenticate: false });
  await assert.rejects(new SshBootstrap({ connectTimeoutMs: 80 }).connect(stalled), { code: "SSH_CONNECT_TIMEOUT" });
  const controller = new AbortController();
  const connecting = new SshBootstrap().connect(stalled, { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(connecting, { code: "SSH_ABORTED" });
  const hanging = await fixture(t, { execute() {} });
  const session = await new SshBootstrap({ commandTimeoutMs: 80 }).connect(hanging);
  t.after(() => session.close());
  await assert.rejects(session.preflight({ server: "https://panel.example" }), { code: "SSH_COMMAND_TIMEOUT" });
});

test("sudo password framing works with both cached and prompted sudo and never evaluates the password", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-ssh-sudo-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "sudo"), `#!/bin/bash
if [ "$TEST_SUDO_CACHED" = no ]; then IFS= read -r password; [ "$password" = "$TEST_SUDO_PASSWORD" ] || exit 1; fi
while [ "$1" != -- ]; do shift; done
shift
exec "$@"
`, { mode: 0o755 });
  const sudoPassword = `p'; $(touch ${join(directory, "injected")}) #`;
  for (const cached of ["yes", "no"]) {
    const f = await fixture(t, { execute({ command, input, stream }) {
      if (command === "id -u") { stream.write("1000\n"); stream.exit(0); stream.end(); return; }
      if (command === "sudo -n true") { stream.exit(1); stream.end(); return; }
      assert.ok(command.startsWith("sudo -S -p '' -- bash -c "));
      assert.ok(!command.includes(sudoPassword));
      assert.match(input, /uname -s/);
      // Execute the actual sudo command and stdin framing, substituting a
      // harmless target script at the remote OS seam instead of systemctl.
      const [password, marker] = input.split("\n");
      const script = "printf '%s\\n' 'RAYLINK_SSH_OS=linux' 'RAYLINK_SSH_ARCH=x86_64' 'RAYLINK_SSH_SYSTEMD=yes' 'RAYLINK_SSH_MISSING=' 'RAYLINK_SSH_SCRIPT=yes' 'RAYLINK_SSH_STATE=null'\n";
      const child = spawn("bash", ["-c", command], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_SUDO_CACHED: cached, TEST_SUDO_PASSWORD: sudoPassword } });
      child.stdout.on("data", (chunk) => stream.write(chunk));
      child.stderr.on("data", (chunk) => stream.stderr.write(chunk));
      child.on("close", (code) => { stream.exit(code); stream.end(); });
      child.stdin.end(`${password}\n${marker}\n${script}`);
    } });
    const session = await new SshBootstrap().connect({ ...f, sudoPassword });
    t.after(() => session.close());
    assert.equal((await session.preflight({ server: "https://panel.example" })).privilege, "sudo");
  }
  await assert.rejects(promisify(execFile)("test", ["-e", join(directory, "injected")]));
});

test("SSH rejects oversized output and suppresses remote failure details", async (t) => {
  for (const oversized of [true, false]) {
    const f = await fixture(t, { execute({ stream }) {
      if (oversized) stream.write("x".repeat(40_000));
      else stream.stderr.write("password=DO_NOT_RETURN\n");
      stream.exit(oversized ? 0 : 1); stream.end();
    } });
    const session = await new SshBootstrap().connect(f);
    t.after(() => session.close());
    await assert.rejects(session.preflight({ server: "https://panel.example" }), (error) => {
      assert.equal(error.code, oversized ? "SSH_OUTPUT_LIMIT" : "SSH_REMOTE_FAILED");
      assert.doesNotMatch(JSON.stringify(error) + error.message, /DO_NOT_RETURN|xxxxxx/);
      return true;
    });
  }
});

test("downloaded installer is syntax-checked and receives credentials through stdin environment, not exec arguments", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-ssh-install-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "curl"), `#!/bin/bash
cat <<'INSTALLER'
set -eu
[ "$RAYLINK_SERVER" = 'https://panel.example' ]
[ "$RAYLINK_EXPECT_HOST_ID" = 'host-1' ]
[ -n "$RAYLINK_ENROLL_TOKEN" ]
printf 'private=%s\\n' "$RAYLINK_ENROLL_TOKEN"
INSTALLER
`, { mode: 0o755 });
  for (const name of ["xz", "tar"]) await writeFile(join(bin, name), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  const f = await fixture(t, { execute({ command, input, stream }) {
    if (command === "id -u") { stream.write("0\n"); stream.exit(0); stream.end(); return; }
    const preflight = input.includes("uname -s");
    const child = spawn("bash", preflight ? ["-n"] : ["-s"], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    child.stdout.on("data", (chunk) => stream.write(chunk));
    child.stderr.on("data", (chunk) => stream.stderr.write(chunk));
    child.on("close", (code) => {
      if (preflight && code === 0) stream.write('RAYLINK_SSH_OS=linux\nRAYLINK_SSH_ARCH=x86_64\nRAYLINK_SSH_SYSTEMD=yes\nRAYLINK_SSH_MISSING=\nRAYLINK_SSH_SCRIPT=yes\nRAYLINK_SSH_STATE=null\n');
      stream.exit(code); stream.end();
    });
    child.stdin.end(input);
  } });
  const session = await new SshBootstrap().connect(f);
  t.after(() => session.close());
  const stages = [];
  assert.equal((await session.install({ server: "https://panel.example", hostId: "host-1", enrollmentToken: "test_enrollment_".repeat(3), onStage: (stage) => stages.push(stage) })).status, "installed");
  assert.deepEqual(stages, ["preflight", "download", "install", "complete"]);
  await writeFile(join(bin, "curl"), "#!/bin/bash\nprintf 'invalid shell (\\n'\n", { mode: 0o755 });
  await assert.rejects(session.install({ server: "https://panel.example", hostId: "host-1", enrollmentToken: "test_enrollment_".repeat(3) }), { code: "SSH_REMOTE_FAILED" });
});

test("passwordless sudo is preferred and installation has its own bounded deadline", async (t) => {
  const f = await fixture(t, { execute({ command, input, stream }) {
    if (command === "id -u") stream.write("1000\n");
    else if (command === "sudo -n true") { /* privilege probe */ }
    else if (input.includes("uname -s")) {
      assert.equal(command, "sudo -n -- bash -s");
      stream.write('RAYLINK_SSH_OS=linux\nRAYLINK_SSH_ARCH=x86_64\nRAYLINK_SSH_SYSTEMD=yes\nRAYLINK_SSH_MISSING=\nRAYLINK_SSH_SCRIPT=yes\nRAYLINK_SSH_STATE=null\n');
    } else return; // Installed program deliberately never completes.
    stream.exit(0); stream.end();
  } });
  const session = await new SshBootstrap({ installTimeoutMs: 80 }).connect({ ...f, sudoPassword: "unused-sudo-password" });
  t.after(() => session.close());
  await assert.rejects(session.install({ server: "https://panel.example", hostId: "host-1", enrollmentToken: "test_enrollment_".repeat(3) }), { code: "SSH_COMMAND_TIMEOUT" });
  assert.ok(f.commands.every((command) => !command.includes("sudo -S")));
  assert.ok(f.inputs.every((input) => !input.includes("unused-sudo-password")));
});

test("preflight can recover an environment-only pending installation without Node.js or evaluating its environment", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-ssh-pending-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin"), config = join(directory, "config"), systemd = join(directory, "systemd");
  await Promise.all([mkdir(bin), mkdir(config), mkdir(systemd)]);
  await writeFile(join(bin, "uname"), "#!/bin/bash\nif [ \"$1\" = -s ]; then echo Linux; else echo x86_64; fi\n", { mode: 0o755 });
  await writeFile(join(bin, "systemctl"), "#!/bin/bash\nexit 1\n", { mode: 0o755 });
  await writeFile(join(bin, "node"), "#!/bin/bash\nexit 88\n", { mode: 0o755 });
  await writeFile(join(config, "node.env"), `RAYLINK_SERVER=https://panel.example\nRAYLINK_EXPECT_HOST_ID=host-1\nRAYLINK_ENROLL_TOKEN=do-not-return\nMALICIOUS=$(touch ${join(directory, "injected")})\n`);
  const f = await fixture(t, { execute({ command, input, stream }) {
    if (command === "id -u") { stream.write("0\n"); stream.exit(0); stream.end(); return; }
    const script = input.replaceAll("/etc/raylink-node", config).replaceAll("/run/systemd/system", systemd)
      .replaceAll("/opt/raylink-node/node/bin/node", join(directory, "not-installed-node"));
    const child = spawn("bash", ["-s"], { env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` } });
    child.stdout.on("data", (chunk) => stream.write(chunk));
    child.stderr.on("data", (chunk) => stream.stderr.write(chunk));
    child.on("close", (code) => { stream.exit(code); stream.end(); });
    child.stdin.end(script);
  } });
  const session = await new SshBootstrap().connect(f);
  t.after(() => session.close());
  const result = await session.preflight({ server: "https://panel.example" });
  assert.deepEqual(result.existing, { hostId: "host-1", server: "https://panel.example", enrolled: false });
  assert.doesNotMatch(JSON.stringify(result), /do-not-return|MALICIOUS/);
  await assert.rejects(promisify(execFile)("test", ["-e", join(directory, "injected")]));
});
