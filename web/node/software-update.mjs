import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const modulePath = fileURLToPath(import.meta.url);
const validVersion = (value) => typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);
const validId = (value) => typeof value === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(value);
const now = () => new Date().toISOString();
async function save(path, data) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

// A separate systemd unit survives stopping/replacing the control plane or Node.
// The descriptor is private, locally generated, and never accepted from an HTTP body.
export async function scheduleSoftwareUpdate({ directory, id, kind, targetVersion, installerPath, releaseBaseUrl,
  server, scriptSha256, root, caPath = null, nodeBinary = process.execPath, runner = execFile }) {
  if (!validId(id) || !validVersion(targetVersion) || !["control-plane", "node"].includes(kind)) throw new Error("Invalid software update task");
  if (caPath && (!isAbsolute(caPath) || /[\r\n\0]/.test(caPath))) throw new Error("Invalid control-plane certificate path");
  const jobDir = join(directory, id);
  await mkdir(jobDir, { recursive: true, mode: 0o700 });
  const unit = `raylink-${kind}-update-${id}`;
  const descriptor = { id, kind, targetVersion, server, scriptSha256, root, caPath, releaseBaseUrl, nodeBinary, unit, jobDir, dataRoot: dirname(directory) };
  await copyFile(modulePath, join(jobDir, "runner.mjs"));
  if (kind === "control-plane") await copyFile(installerPath, join(jobDir, "install.sh"));
  await save(join(jobDir, "job.json"), descriptor);
  await save(join(jobDir, "status.json"), { status: "queued", stage: "starting", message: "更新任务已提交", startedAt: now(), targetVersion });
  try {
    await runner("systemd-run", ["--unit", unit, "--collect", "--property=Type=exec", ...(caPath ? [`--setenv=NODE_EXTRA_CA_CERTS=${caPath}`] : []), nodeBinary,
      join(jobDir, "runner.mjs"), "--job", join(jobDir, "job.json")], { timeout: 15_000, maxBuffer: 1024 * 1024 });
  } catch (error) {
    const current = JSON.parse(await readFile(join(jobDir, "status.json"), "utf8"));
    // systemd can accept the unit before its client times out. Preserve the
    // job (and any worker result) until a later unit probe resolves uncertainty.
    if (current.status !== "queued" || error.killed || error.signal || error.code === "ETIMEDOUT") {
      return { id, unit, jobDir };
    }
    await save(join(jobDir, "status.json"), { status: "failed", stage: "starting", message: "无法启动独立更新服务", error: "systemd-run 启动失败", finishedAt: now(), targetVersion });
    throw new Error("无法启动独立更新服务，请检查 systemd 权限", { cause: error });
  }
  return { id, unit, jobDir };
}

export async function readSoftwareUpdateJob(jobDir, runner = execFile) {
  let status;
  try { status = JSON.parse(await readFile(join(jobDir, "status.json"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (["queued", "running"].includes(status.status) && Date.now() - new Date(status.startedAt).getTime() > 30_000) {
    const job = JSON.parse(await readFile(join(jobDir, "job.json"), "utf8"));
    try { await runner("systemctl", ["is-active", "--quiet", job.unit], { timeout: 5_000 }); }
    catch (error) {
      // A timeout or unavailable D-Bus says nothing about whether the installer
      // is still running. Keep the durable lock until systemd confirms absence.
      if (error.killed || error.signal || ![3, 4].includes(error.code)) return status;
      // Read once more so a just-completed worker cannot be overwritten as interrupted.
      status = JSON.parse(await readFile(join(jobDir, "status.json"), "utf8"));
      if (["queued", "running"].includes(status.status)) {
        status = { ...status, status: "failed", stage: "interrupted", error: "更新进程已中断，请重试", finishedAt: now() };
        await save(join(jobDir, "status.json"), status);
      }
    }
  }
  return status;
}

export class NodeSoftwareUpdater {
  constructor({ server, dataDir, root = "/opt/raylink-node", caPath = process.env.RAYLINK_CONTROL_CA_FILE || process.env.NODE_EXTRA_CA_CERTS || null, runner = execFile, nodeBinary = process.execPath } = {}) {
    this.server = server; this.directory = join(dataDir, "software-updates");
    this.root = root; this.caPath = caPath; this.runner = runner; this.nodeBinary = nodeBinary;
  }
  async schedule(task) {
    const origin = new URL(this.server);
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("Node 更新必须使用已注册的 HTTPS 控制面");
    if (!/^[a-f0-9]{64}$/.test(task.payload?.scriptSha256 || "")) throw new Error("Node 更新缺少脚本校验值");
    return scheduleSoftwareUpdate({ directory: this.directory, id: task.id, kind: "node", targetVersion: task.payload.targetVersion,
      server: origin.origin, scriptSha256: task.payload.scriptSha256, root: this.root, caPath: this.caPath, runner: this.runner, nodeBinary: this.nodeBinary });
  }
  async result(taskId) {
    if (!validId(taskId)) throw new Error("Invalid Node update task");
    const status = await readSoftwareUpdateJob(join(this.directory, taskId), this.runner);
    if (!status) return { status: "failed", result: { error: "更新调度中断，请重试" } };
    if (["queued", "running"].includes(status.status)) return null;
    return { status: status.status, result: status.status === "succeeded" ? { agentVersion: status.targetVersion } : { error: status.error || "Node 更新失败" } };
  }
}

async function runWorker(descriptorPath) {
  const job = JSON.parse(await readFile(descriptorPath, "utf8"));
  const statusPath = join(job.jobDir, "status.json");
  const startedAt = now();
  const report = (status, stage, message, extra = {}) => save(statusPath, { status, stage, message, targetVersion: job.targetVersion, startedAt, ...extra });
  try {
    await report("running", "installing", "正在校验并安装更新，服务将自动恢复");
    // Give the initiating HTTP request time to acknowledge its durable task.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    let script = join(job.jobDir, "install.sh");
    let args = [script, "--version", job.targetVersion, "--release-base-url", job.releaseBaseUrl];
    const env = { ...process.env };
    if (job.kind === "control-plane") { env.RAYLINK_INSTALL_ROOT = job.root; env.RAYLINK_DATA_ROOT = job.dataRoot; }
    if (job.kind === "node") {
      script = join(job.jobDir, "upgrade.sh");
      const response = await fetch(`${job.server}/node/upgrade.sh`, { redirect: "error", signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error("Node 更新脚本下载失败");
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length > 1024 * 1024 || createHash("sha256").update(body).digest("hex") !== job.scriptSha256) throw new Error("Node 更新脚本 SHA-256 不匹配");
      await writeFile(script, body, { mode: 0o700 });
      args = [script]; env.RAYLINK_SERVER = job.server; env.RAYLINK_NODE_ROOT = job.root; env.RAYLINK_NODE_CONFIG_ROOT = job.dataRoot;
      if (job.caPath) env.RAYLINK_CONTROL_CA_FILE = job.caPath;
    }
    const output = await execFile("/bin/bash", args, { env, timeout: 30 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    await writeFile(join(job.jobDir, "install.log"), `${output.stdout || ""}\n${output.stderr || ""}`, { mode: 0o600 });
    const installed = job.kind === "node"
      ? (await execFile(job.nodeBinary, ["--input-type=module", "-e", "const m=await import(process.argv[1]); process.stdout.write(m.AGENT_VERSION)", pathToFileURL(join(job.root, "raylink-node.mjs")).href], { timeout: 10_000 })).stdout.trim()
      : JSON.parse(await readFile(join(job.root, "package.json"), "utf8")).version;
    if (installed !== job.targetVersion) throw new Error("安装后的版本与目标版本不一致");
    await execFile("systemctl", ["is-active", "--quiet", job.kind === "node" ? "raylink-node.service" : "raylink.service"], { timeout: 10_000 });
    await report("succeeded", "complete", "更新完成，服务与版本验证通过", { finishedAt: now() });
  } catch (error) {
    await writeFile(join(job.jobDir, "install.log"), String(error.stderr || error.message || error), { mode: 0o600 });
    await report("failed", "failed", "更新未通过验证，请查看安装日志和服务状态", { error: "更新未通过安装或健康检查，请查看服务器更新日志", finishedAt: now() });
    process.exitCode = 1;
  }
}

if (process.argv[1] && process.argv[2] === "--job" && fileURLToPath(import.meta.url) === await realpath(process.argv[1])) {
  await runWorker(process.argv[3]);
}
