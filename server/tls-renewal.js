import { X509Certificate } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { resolve } from "node:path";

import { LocalTlsAssetStager, localTlsAssetPaths } from "./tls-assets.js";

const DAY_MS = 86_400_000;
const safeErrorCodes = new Set([
  "TLS_ASSET_UNREADABLE", "TLS_ASSET_TOO_LARGE", "TLS_KEY_MISMATCH",
  "TLS_CERTIFICATE_INVALID_DATE", "TLS_CERTIFICATE_HOST_MISMATCH",
  "TLS_CADDY_SOURCE_UNAVAILABLE", "TLS_SOURCE_OLDER", "TLS_CURRENT_CERTIFICATE_INVALID",
  "TLS_MANAGED_ASSET_UNSAFE", "TLS_RUNTIME_ACTIVATION_UNAVAILABLE",
  "RUNTIME_OPERATION_IN_PROGRESS", "SYSTEM_UPDATE_BUSY"
]);

function errorCode(error) {
  return safeErrorCodes.has(error?.code) ? error.code : "TLS_RENEWAL_FAILED";
}

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function managedDomains(config, runtimeDirectory) {
  const domains = new Map();
  for (const inbound of config?.inbounds || []) {
    const tls = inbound.tls;
    const domain = String(tls?.server_name || "").toLowerCase();
    if (!tls?.enabled || tls.reality?.enabled || tls.acme || tls.certificate_provider || tls.certificate?.length || tls.key?.length
      || !domain || isIP(domain) || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) continue;
    const paths = localTlsAssetPaths(runtimeDirectory, domain);
    if (tls.certificate_path !== paths.certificatePath || tls.key_path !== paths.keyPath) continue;
    const entry = domains.get(domain) || { domain, ...paths, protocolTypes: [], inboundTags: [] };
    if (!entry.protocolTypes.includes(inbound.type)) entry.protocolTypes.push(inbound.type);
    if (inbound.tag && !entry.inboundTags.includes(inbound.tag)) entry.inboundTags.push(inbound.tag);
    domains.set(domain, entry);
  }
  return [...domains.values()];
}

function describeCertificate(domain, certificate, now, warningDays) {
  const validTo = new Date(certificate.validTo).toISOString();
  const remaining = Date.parse(validTo) - now.getTime();
  return {
    domain, validTo, fingerprint256: certificate.fingerprint256,
    daysRemaining: Math.floor(remaining / DAY_MS),
    status: remaining <= 0 ? "expired" : remaining <= warningDays * DAY_MS ? "expiring" : "healthy"
  };
}

// Two file renames are not a filesystem transaction. Prepare every pair first,
// then activate only after both paths are complete. A failed activation restores
// all previous pairs before the one rollback activation; it never republishes profiles.
export class LocalTlsRenewalManager {
  constructor({ runtimeDirectory, readAppliedConfig, certificateProvider, activate,
    withRuntimeLock = (operation) => operation(), clock = () => new Date(), warningDays = 30 }) {
    this.runtimeDirectory = resolve(runtimeDirectory);
    this.readAppliedConfig = readAppliedConfig;
    this.certificateProvider = certificateProvider;
    this.activate = activate;
    this.withRuntimeLock = withRuntimeLock;
    this.clock = clock;
    this.warningDays = warningDays;
    this.stager = new LocalTlsAssetStager({ dataDir: this.runtimeDirectory });
    this.current = { status: "idle", checkedAt: null, lastUpdatedAt: null, certificates: [], changed: 0 };
    this.pending = null;
  }

  status() {
    return structuredClone(this.current);
  }

  sync() {
    if (this.pending) return this.pending;
    this.pending = Promise.resolve().then(() => this.withRuntimeLock(() => this.#synchronize()))
      .catch((error) => {
        this.current = { ...this.current, status: "error", checkedAt: new Date(this.clock()).toISOString(), changed: 0, errorCode: errorCode(error) };
        return this.status();
      }).finally(() => { this.pending = null; });
    return this.pending;
  }

  async #synchronize() {
    const now = new Date(this.clock());
    const certificates = [];
    const changes = [];
    const domains = managedDomains(await this.readAppliedConfig(), this.runtimeDirectory);
    for (const entry of domains) {
      let description = { domain: entry.domain, validTo: null, fingerprint256: null, daysRemaining: null, status: "error" };
      try {
        for (const path of [this.runtimeDirectory, entry.directory, entry.certificatePath, entry.keyPath]) {
          const metadata = await lstat(path);
          if (metadata.isSymbolicLink()) throw failure("TLS_MANAGED_ASSET_UNSAFE");
        }
        let previous;
        try { previous = new X509Certificate(await readFile(entry.certificatePath)); }
        catch { throw failure("TLS_CURRENT_CERTIFICATE_INVALID"); }
        description = describeCertificate(entry.domain, previous, now, this.warningDays);
        const source = await this.certificateProvider(entry.domain);
        if (!source || source.managedBy !== "caddy") throw failure("TLS_CADDY_SOURCE_UNAVAILABLE");
        const prepared = await this.stager.prepare({
          domain: entry.domain, certificatePath: source.certificatePath, keyPath: source.keyPath,
          validateHostname: true, now
        });
        if (prepared.changed && (Date.parse(prepared.validFrom) < Date.parse(previous.validFrom)
          || Date.parse(prepared.validTo) < Date.parse(previous.validTo))) throw failure("TLS_SOURCE_OLDER");
        if (prepared.changed) changes.push({ entry, prepared, previous, description });
        else await prepared.commit();
        certificates.push(description);
      } catch (error) {
        certificates.push({ ...description, status: "error", errorCode: errorCode(error) });
      }
    }
    const report = { status: "healthy", checkedAt: now.toISOString(), lastUpdatedAt: this.current.lastUpdatedAt,
      certificates, changed: 0 };
    if (certificates.some((certificate) => certificate.errorCode)) {
      this.current = { ...report, status: "error", errorCode: certificates.find((certificate) => certificate.errorCode).errorCode };
      return this.status();
    }
    if (changes.length) {
      let attempted = false;
      try {
        if (typeof this.activate !== "function") throw failure("TLS_RUNTIME_ACTIVATION_UNAVAILABLE");
        for (const { prepared } of changes) { attempted = true; await prepared.commit(); }
        await this.activate({ phase: "apply", domains: changes.map(({ entry, prepared, previous }) => ({
          domain: entry.domain, fingerprint256: prepared.fingerprint256,
          previousFingerprint256: previous.fingerprint256, protocolTypes: entry.protocolTypes, inboundTags: entry.inboundTags
        })) });
        for (const change of changes) Object.assign(change.description,
          describeCertificate(change.entry.domain, change.prepared, now, this.warningDays));
        report.changed = changes.length;
        report.lastUpdatedAt = now.toISOString();
      } catch (error) {
        let rollbackFailed = false;
        if (attempted) {
          for (const { prepared } of [...changes].reverse()) {
            try { await prepared.rollback(); } catch { rollbackFailed = true; }
          }
          if (!rollbackFailed) {
            try { await this.activate({ phase: "rollback", domains: changes.map(({ entry, previous, prepared }) => ({
              domain: entry.domain, fingerprint256: previous.fingerprint256,
              previousFingerprint256: prepared.fingerprint256, protocolTypes: entry.protocolTypes, inboundTags: entry.inboundTags
            })) }); } catch { rollbackFailed = true; }
          }
        }
        const code = rollbackFailed ? "TLS_RENEWAL_ROLLBACK_FAILED" : errorCode(error);
        for (const change of changes) Object.assign(change.description, { status: "error", errorCode: code });
        this.current = { ...report, status: "error", errorCode: code };
        return this.status();
      }
    }
    if (certificates.some((certificate) => certificate.status !== "healthy")) report.status = "warning";
    this.current = report;
    return this.status();
  }
}
