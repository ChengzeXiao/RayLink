import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import ssh2 from "ssh2";

function failure(code, message, statusCode = 502) {
  return Object.assign(new Error(message), { code, statusCode });
}

const quote = (value) => `'${String(value).replaceAll("'", "'\"'\"'")}'`;
function serverOrigin(value) {
  let url;
  try { url = new URL(value); } catch { /* handled below */ }
  if (!url || url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw failure("SSH_INPUT_INVALID", "控制面地址必须是 HTTPS 根地址", 422);
  }
  return url.origin;
}

function preflightScript(server) {
  return `set -euo pipefail
fail() { printf 'RAYLINK_SSH_ERROR=%s\\n' "$1"; exit 1; }
[ "$(uname -s)" = Linux ] || fail UNSUPPORTED_OS
printf 'RAYLINK_SSH_OS=linux\\n'
printf 'RAYLINK_SSH_ARCH=%s\\n' "$(uname -m)"
command -v systemctl >/dev/null && [ -d /run/systemd/system ] || fail SYSTEMD_REQUIRED
printf 'RAYLINK_SSH_SYSTEMD=yes\\n'
has_existing=no
missing=''
for dependency in curl tar xz; do
  if ! command -v "$dependency" >/dev/null 2>&1; then
    [ -z "$missing" ] || missing="$missing,"
    missing="$missing$dependency"
  fi
done
printf 'RAYLINK_SSH_MISSING=%s\\n' "$missing"
if [ -f /etc/raylink-node/node.json ] || [ -f /etc/raylink-node/node.env ] || systemctl cat raylink-node.service >/dev/null 2>&1; then
  has_existing=yes
  if [ ! -f /etc/raylink-node/node.json ]; then
    identity_value() {
      awk -v key="$1" 'index($0, key "=") == 1 { count++; value=substr($0, length(key)+2) } END { if (count != 1) exit 1; print value }' /etc/raylink-node/node.env
    }
    pending_host="$(identity_value RAYLINK_EXPECT_HOST_ID)" || fail EXISTING_IDENTITY_UNREADABLE
    pending_server="$(identity_value RAYLINK_SERVER)" || fail EXISTING_IDENTITY_UNREADABLE
    printf 'RAYLINK_SSH_STATE=pending\\nRAYLINK_SSH_PENDING_HOST=%s\\nRAYLINK_SSH_PENDING_SERVER=%s\\n' "$pending_host" "$pending_server"
  else
  parser=/opt/raylink-node/node/bin/node
  [ -x "$parser" ] || parser="$(command -v node || true)"
  [ -n "$parser" ] || fail EXISTING_IDENTITY_UNREADABLE
  "$parser" --input-type=module <<'RAYLINK_IDENTITY_JS'
import fs from 'node:fs';
let state = {}, env = '';
try { state = JSON.parse(fs.readFileSync('/etc/raylink-node/node.json', 'utf8')); } catch (error) { if (error.code !== 'ENOENT') process.exit(42); }
try { env = fs.readFileSync('/etc/raylink-node/node.env', 'utf8'); } catch (error) { if (error.code !== 'ENOENT') process.exit(42); }
const entry = (name) => {
  const values = env.split(/\\r?\\n/).filter((line) => line.startsWith(name + '='));
  if (values.length !== 1) process.exit(42);
  return values[0].slice(name.length + 1);
};
const hostId = state.hostId || entry('RAYLINK_EXPECT_HOST_ID');
const server = entry('RAYLINK_SERVER');
if (typeof hostId !== 'string' || !hostId || !server) process.exit(42);
console.log('RAYLINK_SSH_STATE=' + JSON.stringify({ hostId, server, enrolled: Boolean(state.hostId && state.nodeSecret) }));
RAYLINK_IDENTITY_JS
  fi
else
  printf 'RAYLINK_SSH_STATE=null\\n'
fi
if systemctl is-active --quiet sing-box.service || { [ "$has_existing" = no ] && { command -v sing-box >/dev/null 2>&1 || systemctl cat sing-box.service >/dev/null 2>&1; }; }; then fail UNMANAGED_RUNTIME; fi
if [ "$has_existing" = no ] && command -v curl >/dev/null 2>&1; then
  script="$(curl --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time 30 --max-filesize 1048576 -fsS ${quote(`${server}/node/install.sh`)})" || fail INSTALLER_UNAVAILABLE
  [ -n "$script" ] && printf '%s\\n' "$script" | bash -n || fail INSTALLER_UNAVAILABLE
  printf 'RAYLINK_SSH_SCRIPT=yes\\n'
else
  printf 'RAYLINK_SSH_SCRIPT=no\\n'
fi
`;
}

function parsePreflight(output, privilege) {
  const entries = Object.fromEntries(output.split("\n").filter((line) => line.startsWith("RAYLINK_SSH_")).map((line) => {
    const index = line.indexOf("="); return [line.slice(12, index), line.slice(index + 1)];
  }));
  let existing;
  try {
    existing = entries.STATE === "pending" ? { hostId: entries.PENDING_HOST, server: entries.PENDING_SERVER, enrolled: false } : JSON.parse(entries.STATE);
  } catch { throw failure("SSH_PREFLIGHT_INVALID", "远端预检未返回完整身份状态"); }
  if (entries.OS !== "linux" || entries.SYSTEMD !== "yes" || !["x86_64", "aarch64", "arm64"].includes(entries.ARCH)
    || !["yes", "no"].includes(entries.SCRIPT) || !/^(?:curl|tar|xz)?(?:,(?:curl|tar|xz))*$/.test(entries.MISSING ?? "!")
    || (existing !== null && (typeof existing?.hostId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(existing.hostId)
      || typeof existing.server !== "string" || typeof existing.enrolled !== "boolean"))) {
    throw failure("SSH_PREFLIGHT_INVALID", "远端系统或身份状态不受支持");
  }
  if (existing) existing = { hostId: existing.hostId, server: serverOrigin(existing.server), enrolled: existing.enrolled };
  return { os: "linux", architecture: entries.ARCH, systemd: true, privilege,
    missingDependencies: entries.MISSING ? entries.MISSING.split(",") : [], scriptVerified: entries.SCRIPT === "yes", existing };
}

function installScript({ server, hostId, enrollmentToken }) {
  return `set -euo pipefail
umask 077
if ! command -v curl >/dev/null || ! command -v tar >/dev/null || ! command -v xz >/dev/null; then
  printf 'RAYLINK_SSH_STAGE=dependencies\\n'
  if command -v apt-get >/dev/null; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y curl tar xz-utils ca-certificates
  elif command -v dnf >/dev/null; then dnf -y install curl tar xz ca-certificates
  elif command -v yum >/dev/null; then yum -y install curl tar xz ca-certificates
  else exit 1; fi
fi
printf 'RAYLINK_SSH_STAGE=download\\n'
script="$(curl --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time 60 --max-filesize 1048576 -fsS ${quote(`${server}/node/install.sh`)})"
[ -n "$script" ]
printf '%s\\n' "$script" | bash -n
export RAYLINK_SERVER=${quote(server)}
export RAYLINK_EXPECT_HOST_ID=${quote(hostId)}
${enrollmentToken === undefined ? "" : `export RAYLINK_ENROLL_TOKEN=${quote(enrollmentToken)}`}
printf 'RAYLINK_SSH_STAGE=install\\n'
printf '%s\\n' "$script" | bash
printf 'RAYLINK_SSH_STAGE=complete\\n'
`;
}

export class SshBootstrap {
  constructor({ connectTimeoutMs = 15_000, commandTimeoutMs = 60_000, installTimeoutMs = 20 * 60_000 } = {}) {
    this.connectTimeoutMs = connectTimeoutMs;
    this.commandTimeoutMs = commandTimeoutMs;
    this.installTimeoutMs = installTimeoutMs;
  }

  async connect({ host, port = 22, username, password, privateKey, passphrase, sudoPassword }, { expectedFingerprint, signal } = {}) {
    if (typeof host !== "string" || !isIP(host) || !Number.isInteger(port) || port < 1 || port > 65535
      || typeof username !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(username)
      || (!password && !privateKey)) throw failure("SSH_INPUT_INVALID", "需要有效 IP、端口、用户名和 SSH 认证信息", 422);
    if (expectedFingerprint !== undefined && !/^SHA256:[A-Za-z0-9+/]{43}$/.test(expectedFingerprint)) {
      throw failure("SSH_INPUT_INVALID", "SSH 主机指纹格式无效", 422);
    }
    if (signal?.aborted) throw failure("SSH_ABORTED", "SSH 操作已取消", 409);
    const client = new ssh2.Client();
    let fingerprint;
    let mismatch = false;
    let timedOut = false;
    let closed = false;
    const close = () => { closed = true; client.destroy(); };
    const abort = () => close();
    signal?.addEventListener("abort", abort, { once: true });
    client.once("close", () => { closed = true; signal?.removeEventListener("abort", abort); });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { timedOut = true; close(); }, this.connectTimeoutMs);
      const rejectConnection = (error) => {
        clearTimeout(timer);
        const code = signal?.aborted ? "SSH_ABORTED" : mismatch ? "SSH_HOST_KEY_MISMATCH" : timedOut ? "SSH_CONNECT_TIMEOUT"
          : error?.level === "client-authentication" ? "SSH_AUTHENTICATION_FAILED" : "SSH_CONNECTION_FAILED";
        reject(failure(code, "SSH 连接或认证失败，请核对地址、认证信息及主机指纹"));
      };
      client.on("error", rejectConnection);
      client.once("close", () => rejectConnection());
      client.once("ready", () => { clearTimeout(timer); resolve(); });
      try {
        client.connect({ host, port, username, password, privateKey, passphrase,
          readyTimeout: this.connectTimeoutMs, keepaliveInterval: 15_000, keepaliveCountMax: 3,
          hostVerifier(key) {
            fingerprint = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
            mismatch = expectedFingerprint !== undefined && fingerprint !== expectedFingerprint;
            return !mismatch;
          }
        });
      } catch {
        close(); rejectConnection();
      }
    }).catch((error) => { close(); throw error; });
    const execute = (command, input = "", timeoutMs = this.commandTimeoutMs, onStage) => new Promise((resolve, reject) => {
      if (closed) return reject(failure("SSH_CONNECTION_CLOSED", "SSH 连接已关闭"));
      let output = "";
      let pending = "";
      let settled = false;
      let channel;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer); client.removeListener("close", disconnected);
        if (error) reject(error); else resolve(value);
      };
      const disconnected = () => finish(failure(signal?.aborted ? "SSH_ABORTED" : "SSH_CONNECTION_CLOSED", "SSH 连接中断，远端操作结果需要核对"));
      const timer = setTimeout(() => { finish(failure("SSH_COMMAND_TIMEOUT", "SSH 操作超时，远端状态需要核对")); channel?.close(); close(); }, timeoutMs);
      client.once("close", disconnected);
      client.exec(command, (error, stream) => {
        if (error) { finish(failure("SSH_EXEC_FAILED", "无法执行远端操作")); return; }
        if (settled) { stream.close(); return; }
        channel = stream;
        stream.on("error", () => finish(failure("SSH_EXEC_FAILED", "远端操作中断")));
        stream.on("data", (chunk) => {
          if (settled) return;
          if (!onStage) {
            if (output.length + chunk.length > 32_768) { finish(failure("SSH_OUTPUT_LIMIT", "远端预检输出超过限制")); stream.close(); return; }
            output += chunk.toString();
            return;
          }
          pending += chunk.toString();
          const lines = pending.split("\n"); pending = lines.pop().slice(-4096);
          for (const line of lines) if (/^RAYLINK_SSH_STAGE=(dependencies|download|install|complete)$/.test(line)) {
            try { onStage(line.slice(18)); } catch { /* Progress cannot abort an already-running install. */ }
          }
        });
        stream.stderr.on("data", () => {}); // Raw remote diagnostics can contain credentials.
        stream.on("close", (code) => {
          const reported = output.match(/^RAYLINK_SSH_ERROR=(UNSUPPORTED_OS|SYSTEMD_REQUIRED|UNMANAGED_RUNTIME|EXISTING_IDENTITY_UNREADABLE|INSTALLER_UNAVAILABLE)$/m)?.[1];
          if (code !== 0) finish(failure(reported ? `SSH_${reported}` : "SSH_REMOTE_FAILED", "远端检查或安装失败，请核对目标主机状态"));
          else finish(null, output);
        });
        stream.end(input);
      });
    });
    let privilege;
    let sudoMode;
    const privileged = async (script, timeoutMs, onStage) => {
      if (!privilege) {
        const uid = (await execute("id -u")).trim();
        if (!/^\d+$/.test(uid)) throw failure("SSH_PRIVILEGE_REQUIRED", "无法确认远端运行身份");
        privilege = uid === "0" ? "root" : "sudo";
        if (privilege === "sudo") {
          try { await execute("sudo -n true"); sudoMode = "noninteractive"; }
          catch {
            if (typeof sudoPassword !== "string" || !sudoPassword || /[\r\n\0]/.test(sudoPassword)) throw failure("SSH_PRIVILEGE_REQUIRED", "需要 root、免密 sudo 或有效 sudo 密码", 422);
            sudoMode = "password";
          }
        }
      }
      if (privilege === "root") return execute("bash -s", script, timeoutMs, onStage);
      if (sudoMode === "noninteractive") return execute("sudo -n -- bash -s", script, timeoutMs, onStage);
      // Sudo may consume the password or use cached authorization. In either
      // case the privileged shell discards framing before reading the script.
      const marker = `RAYLINK_${randomBytes(24).toString("hex")}`;
      const reader = `while IFS= read -r line; do [ "$line" = ${quote(marker)} ] && exec bash -s; done; exit 1`;
      return execute(`sudo -S -p '' -- bash -c ${quote(reader)}`, `${sudoPassword}\n${marker}\n${script}`, timeoutMs, onStage);
    };
    const preflight = async ({ server }) => {
      const origin = serverOrigin(server);
      return parsePreflight(await privileged(preflightScript(origin)), privilege);
    };
    const install = async ({ server, hostId, enrollmentToken, onStage = () => {} }) => {
      const origin = serverOrigin(server);
      if (typeof hostId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(hostId)
        || (enrollmentToken !== undefined && !/^[A-Za-z0-9_-]{20,256}$/.test(enrollmentToken)) || typeof onStage !== "function") {
        throw failure("SSH_INPUT_INVALID", "Host 标识或注册信息无效", 422);
      }
      try { onStage("preflight"); } catch { /* best-effort progress */ }
      const checked = await preflight({ server: origin });
      if (checked.existing) {
        if (checked.existing.hostId !== hostId || checked.existing.server !== origin) {
          throw failure("SSH_EXISTING_NODE_CONFLICT", "已有 RayLink Node 属于其他 Host 或控制面，拒绝覆盖", 409);
        }
        if (checked.existing.enrolled) {
          await privileged("set -eu\nif ! systemctl is-active --quiet raylink-node.service; then\n  systemctl enable raylink-node.service\n  systemctl start raylink-node.service\nfi\n", this.commandTimeoutMs, () => {});
        } else {
          // The installer verifies the same binding again and repairs partial
          // installations using their original environment and enrollment token.
          await privileged(installScript({ server: origin, hostId }), this.installTimeoutMs, onStage);
        }
        try { onStage("complete"); } catch { /* best-effort progress */ }
        return { status: "existing", hostId, server: origin };
      }
      if (!enrollmentToken) throw failure("SSH_INPUT_INVALID", "首次安装需要注册令牌", 422);
      await privileged(installScript({ server: origin, hostId, enrollmentToken }), this.installTimeoutMs, onStage);
      return { status: "installed", hostId, server: origin };
    };
    return { fingerprint, preflight, install, close };
  }
}
