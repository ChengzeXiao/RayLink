import { createHash, randomUUID } from "node:crypto";

import { buildSingBoxConfig } from "./config.js";

function deploymentVersion(prefix = "v", now = new Date()) {
  return `${prefix}${now.toISOString().replace(/[-:.]/g, "")}-${randomUUID().slice(0, 8)}`;
}

function compile(store, listenPort, hostId = "local", protocols = null) {
  const snapshot = store.runtimeSnapshot(hostId);
  if (protocols) snapshot.protocols = protocols;
  const config = buildSingBoxConfig(snapshot, { listenPort });
  const configText = `${JSON.stringify(config, null, 2)}\n`;
  const checksum = createHash("sha256").update(configText).digest("hex");
  const eligibleUsers = new Set(
    config.inbounds.flatMap((inbound) => inbound.users?.map(
      (user) => user.name || user.username
    ).filter((name) => name !== "raylink-probe@internal") || [])
  ).size;
  return {
    config,
    configText,
    checksum,
    eligibleUsers,
    protocols: snapshot.protocols
  };
}

function runtimeCredentialNames(config) {
  return new Set(
    config?.inbounds?.flatMap((inbound) => inbound.users?.map(
      (user) => user.name || user.username
    ) || []) || []
  );
}

function removesRuntimeCredentials(previousConfig, nextConfig) {
  if (!previousConfig) return false;
  const previous = runtimeCredentialNames(previousConfig);
  const next = runtimeCredentialNames(nextConfig);
  return [...previous].some((credential) => !next.has(credential));
}

function deploymentCandidateMatchesSnapshot(candidate, snapshot) {
  if (candidate.compiled.checksum !== snapshot.checksum) return false;
  const expectedHosts = new Map(
    candidate.hostSnapshots.map((host) => [host.hostId, host.checksum])
  );
  const activeHosts = new Map(
    snapshot.hostSnapshots.map((host) => [host.hostId, host.checksum])
  );
  if (expectedHosts.size !== activeHosts.size) return false;
  return [...expectedHosts].every(([hostId, checksum]) => activeHosts.get(hostId) === checksum);
}

export class RuntimeManager {
  constructor({ store, adapter, listenPort = 8388, tlsAssetPackager = null }) {
    this.store = store;
    this.adapter = adapter;
    this.listenPort = listenPort;
    this.tlsAssetPackager = tlsAssetPackager;
    this.publishing = false;
  }

  preview() {
    const compiled = compile(this.store, this.listenPort);
    return {
      checksum: compiled.checksum,
      eligibleUsers: compiled.eligibleUsers,
      inboundCount: compiled.config.inbounds.length,
      listenPort: compiled.config.inbounds[0]?.listen_port || null,
      protocols: compiled.config.inbounds.map((inbound) => inbound.type)
    };
  }

  compileHostRuntimeConfig(hostId = "local", protocols = null) {
    return compile(this.store, this.listenPort, hostId, protocols).config;
  }

  async prepareDeploymentCandidate() {
    const compiled = compile(this.store, this.listenPort);
    const remoteHosts = this.store.listHosts().filter((host) => host.kind === "remote" && host.enrolledAt);
    const remoteDeployments = [];
    for (const host of remoteHosts) {
      let remote = compile(this.store, this.listenPort, host.id);
      let sealedTlsBundle = null;
      let tlsAssets = [];
      if (this.tlsAssetPackager) {
        const prepared = await this.tlsAssetPackager.prepare(
          remote.config,
          this.store.nodeEncryptionPublicKey(host.id)
        );
        const configText = `${JSON.stringify(prepared.config, null, 2)}\n`;
        remote = {
          ...remote,
          config: prepared.config,
          configText,
          checksum: createHash("sha256").update(configText).digest("hex")
        };
        sealedTlsBundle = prepared.sealedTlsBundle;
        tlsAssets = prepared.tlsAssets;
      }
      remoteDeployments.push({ host, remote, sealedTlsBundle, tlsAssets });
    }
    const hostSnapshots = remoteDeployments.map(({
      host,
      remote,
      sealedTlsBundle,
      tlsAssets
    }) => ({
      hostId: host.id,
      config: remote.config,
      checksum: remote.checksum,
      protocols: remote.protocols,
      ...(sealedTlsBundle ? { sealedTlsBundle, tlsAssets } : {})
    }));
    return { compiled, remoteDeployments, hostSnapshots };
  }

  async publish(publisherAdminId = null, options = {}) {
    return this.#withPublication(async () => this.#publishCandidate(
      await this.prepareDeploymentCandidate(),
      publisherAdminId,
      options
    ));
  }

  async publishCandidate(candidate, publisherAdminId = null, options = {}) {
    return this.#withPublication(() => this.#publishCandidate(candidate, publisherAdminId, options));
  }

  async #publishCandidate(candidate, publisherAdminId, options) {
    const { compiled, remoteDeployments, hostSnapshots } = candidate;
    const deployment = await this.#publishCompiled({
      ...compiled,
      hostSnapshots,
      version: deploymentVersion(),
      publisherAdminId
    });
    this.store.markHostProtocolsApplied("local", compiled.protocols);
    for (const { host, remote, sealedTlsBundle, tlsAssets } of remoteDeployments) {
      const revokesCredentials = options.forceCritical === true
        || (options.detectRevocation === true && removesRuntimeCredentials(
          this.store.latestAppliedNodeConfig(host.id),
          remote.config
        ));
      this.store.queueNodeTask(host.id, "publish-config", {
        version: deployment.version,
        checksum: remote.checksum,
        configText: remote.configText,
        protocols: remote.protocols,
        ...(options.activation?.hostId === host.id
          ? { activation: options.activation }
          : {}),
        ...(sealedTlsBundle ? { sealedTlsBundle, tlsAssets } : {}),
        reason: options.reason || "deployment"
      }, {
        priority: revokesCredentials ? "critical" : "normal",
        maxAttempts: revokesCredentials ? 0 : 5
      });
    }
    const current = this.store.listDeployments()
      .find((candidate) => candidate.id === deployment.id) || deployment;
    return { ...current, runtime: deployment.runtime, remoteQueued: remoteDeployments.length };
  }

  async reconcile(publisherAdminId = null, options = {}) {
    if (this.publishing) return { changed: false, reason: "deployment-in-progress" };
    return this.#withPublication(() => this.#reconcile(publisherAdminId, options));
  }

  async #reconcile(publisherAdminId, options) {
    const activeDeployment = this.store.listDeployments(100)
      .find((deployment) => deployment.status === "active");
    if (!activeDeployment) return { changed: false, reason: "initial-publication-required" };
    const candidate = await this.prepareDeploymentCandidate();
    const activeSnapshot = this.store.deploymentSnapshot(activeDeployment.id);
    if (
      deploymentCandidateMatchesSnapshot(candidate, activeSnapshot)
      && options.forceCritical !== true
    ) {
      return { changed: false, reason: "configuration-current" };
    }
    return {
      changed: true,
      deployment: await this.#publishCandidate(
        candidate,
        publisherAdminId,
        {
          reason: options.reason || "entitlement-reconciliation",
          detectRevocation: true,
          forceCritical: options.forceCritical === true
        }
      )
    };
  }

  async rollback(sourceDeploymentId, publisherAdminId = null) {
    return this.#withPublication(() => this.#rollback(sourceDeploymentId, publisherAdminId));
  }

  async #rollback(sourceDeploymentId, publisherAdminId) {
    const snapshot = this.store.deploymentSnapshot(sourceDeploymentId);
    const configText = `${JSON.stringify(snapshot.config, null, 2)}\n`;
    const deployment = await this.#publishCompiled({
      config: snapshot.config,
      configText,
      checksum: createHash("sha256").update(configText).digest("hex"),
      eligibleUsers: snapshot.eligibleUsers,
      protocols: snapshot.protocols,
      hostSnapshots: snapshot.hostSnapshots,
      version: deploymentVersion("r"),
      publisherAdminId
    });
    this.store.markHostProtocolsApplied("local", snapshot.protocols);
    let remoteQueued = 0;
    for (const remote of snapshot.hostSnapshots) {
      const host = this.store.getHost(remote.hostId);
      if (!host || host.kind !== "remote" || !host.enrolledAt) continue;
      const configText = `${JSON.stringify(remote.config, null, 2)}\n`;
      const revokesCredentials = removesRuntimeCredentials(
        this.store.latestAppliedNodeConfig(host.id),
        remote.config
      );
      this.store.queueNodeTask(host.id, "publish-config", {
        version: deployment.version,
        checksum: remote.checksum || createHash("sha256").update(configText).digest("hex"),
        configText,
        protocols: remote.protocols,
        ...(remote.sealedTlsBundle
          ? { sealedTlsBundle: remote.sealedTlsBundle, tlsAssets: remote.tlsAssets || [] }
          : {}),
        reason: "rollback"
      }, {
        priority: revokesCredentials ? "critical" : "normal",
        maxAttempts: revokesCredentials ? 0 : 5
      });
      remoteQueued += 1;
    }
    const current = this.store.listDeployments()
      .find((candidate) => candidate.id === deployment.id) || deployment;
    return { ...current, runtime: deployment.runtime, remoteQueued };
  }

  async #withPublication(operation) {
    if (this.publishing) {
      const error = new Error("已有配置正在发布，请稍后重试");
      error.code = "DEPLOYMENT_IN_PROGRESS";
      error.statusCode = 409;
      throw error;
    }
    this.publishing = true;
    try {
      return await operation();
    } finally {
      this.publishing = false;
    }
  }

  async publishCompiled(compiled) {
    return this.#withPublication(() => this.#publishCompiled(compiled));
  }

  async #publishCompiled({
    config,
    configText,
    checksum,
    eligibleUsers,
    protocols,
    hostSnapshots = [],
    version,
    publisherAdminId
  }) {
    let deploymentId;
    try {
      deploymentId = this.store.createDeployment({
        version,
        configJson: config,
        checksum,
        eligibleUsers,
        protocols,
        hostSnapshots,
        publisherAdminId
      });
      const runtime = await this.adapter.publish({
        version,
        checksum,
        configText
      });
      this.store.finishDeployment(deploymentId, { status: "active" });
      return {
        ...this.store.listDeployments().find((deployment) => deployment.id === deploymentId),
        runtime
      };
    } catch (error) {
      if (deploymentId) this.store.finishDeployment(deploymentId, {
        status: "failed",
        error: error.rollbackError
          ? `${error.message}；恢复失败：${error.rollbackError}`
          : error.message
      });
      throw error;
    }
  }

  async status() {
    return this.adapter.status();
  }
}
