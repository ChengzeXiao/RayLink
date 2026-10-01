import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { arch as currentArch, platform as currentPlatform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compareVersions } from "./singbox/installer.js";
import { readSoftwareUpdateJob, scheduleSoftwareUpdate } from "../web/node/software-update.mjs";

const execFile = promisify(execFileCallback);
const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const repository = "ChengzeXiao/RayLink";
const error = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });

export class SystemUpdateManager {
  constructor({ dataDir, runtimeMode = "dry-run", platform = currentPlatform(), architecture = currentArch(),
    installRoot = sourceRoot, environmentFile = "/etc/raylink/raylink.env", nodeBinary = process.execPath, fetchImpl = globalThis.fetch, runner = execFile } = {}) {
    Object.assign(this, { runtimeMode, platform, architecture, installRoot, environmentFile, nodeBinary, fetchImpl, runner });
    this.directory = join(dataDir, "system-updates");
    this.starting = false;
    this.state = { status: "not-checked", latestVersion: null, updateAvailable: false, checkedAt: null };
  }
  async status() {
    const currentVersion = JSON.parse(await readFile(join(this.installRoot, "package.json"), "utf8")).version;
    let blockedReason = this.platform !== "linux" || this.runtimeMode !== "systemd"
      ? "本机测试模式不支持系统更新；请在 Linux systemd 主控上操作" : null;
    if (!blockedReason) {
      try { await access(this.environmentFile); }
      catch { blockedReason = "当前不是标准 RayLink 服务安装，不能执行自动替换"; }
    }
    let task = null;
    try {
      const pointer = JSON.parse(await readFile(join(this.directory, "latest.json"), "utf8"));
      task = await readSoftwareUpdateJob(pointer.jobDir, this.runner);
    } catch (err) { if (err.code !== "ENOENT") throw err; }
    return { ...this.state, currentVersion, supported: !blockedReason, blockedReason,
      updateAvailable: Boolean(this.state.latestVersion && compareVersions(this.state.latestVersion, currentVersion) > 0 && this.state.releaseReady), task };
  }
  async check() {
    try {
      const response = await this.fetchImpl(`https://api.github.com/repos/${repository}/releases/latest`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "RayLink-system-updater" }, signal: AbortSignal.timeout(15_000)
      });
      if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
      const release = await response.json();
      const version = String(release.tag_name || "").replace(/^v/, "");
      if (release.draft || release.prerelease || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("发布版本不是稳定版");
      const arch = { x64: "amd64", arm64: "arm64" }[this.architecture];
      const name = `raylink-${version}-linux-${arch}.tar.gz`;
      const assets = new Set((release.assets || []).map((asset) => asset.name));
      const releaseReady = Boolean(arch && assets.has(name) && assets.has(`${name}.sha256`));
      this.state = { status: "ready", latestVersion: version, releaseReady, checkedAt: new Date().toISOString(),
        releaseUrl: `https://github.com/${repository}/releases/tag/v${version}`,
        error: releaseReady ? null : "此版本尚未发布当前架构的完整安装包和校验文件" };
      return await this.status();
    } catch (err) {
      this.state = { ...this.state, status: "error", releaseReady: false, checkedAt: new Date().toISOString(), error: String(err.message || "版本检查失败") };
      throw error("SYSTEM_UPDATE_CHECK_FAILED", this.state.error, 502);
    }
  }
  async upgrade() {
    if (this.starting) throw error("SYSTEM_UPDATE_BUSY", "系统更新正在提交");
    this.starting = true;
    try {
      let state = await this.status();
      if (!state.supported) throw error("SYSTEM_UPDATE_UNSUPPORTED", state.blockedReason, 422);
      if (["queued", "running"].includes(state.task?.status)) throw error("SYSTEM_UPDATE_BUSY", "系统更新正在执行");
      state = await this.check();
      if (!state.updateAvailable) throw error("SYSTEM_ALREADY_CURRENT", state.error || "当前已是最新正式版本");
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const id = randomUUID();
      const pointer = join(this.directory, "latest.json");
      await writeFile(`${pointer}.tmp`, JSON.stringify({ id, jobDir: join(this.directory, id) }), { mode: 0o600 });
      await rename(`${pointer}.tmp`, pointer);
      await scheduleSoftwareUpdate({ directory: this.directory, id, kind: "control-plane",
        targetVersion: state.latestVersion, root: this.installRoot, nodeBinary: this.nodeBinary,
        installerPath: join(this.installRoot, "deploy/install.sh"), releaseBaseUrl: `https://github.com/${repository}/releases/download`, runner: this.runner });
      return this.status();
    } finally { this.starting = false; }
  }
}
