import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  X509Certificate
} from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";

import { sealNodeSecret } from "./node-secrets.js";

function safeAssetName(value) {
  return String(value || "runtime")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "runtime";
}

function certificateMatchesPrivateKey(certificatePem, privateKeyPem) {
  const certificate = new X509Certificate(certificatePem);
  const privateKey = createPrivateKey(privateKeyPem);
  const certificatePublic = certificate.publicKey.export({ type: "spki", format: "der" });
  const privatePublic = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  if (!certificatePublic.equals(privatePublic)) {
    const error = new Error("TLS 证书与私钥不匹配");
    error.code = "TLS_KEY_MISMATCH";
    error.statusCode = 422;
    throw error;
  }
  return certificate;
}

function validateCertificatePair(certificatePem, privateKeyPem, label, now = new Date()) {
  const certificate = certificateMatchesPrivateKey(certificatePem, privateKeyPem);
  const validFrom = new Date(certificate.validFrom);
  const validTo = new Date(certificate.validTo);
  if (validFrom > now || validTo <= now) {
    const error = new Error(`${label} 的 TLS 证书不在有效期内`);
    error.code = "TLS_CERTIFICATE_INVALID_DATE";
    error.statusCode = 422;
    throw error;
  }
  return certificate;
}

export function localTlsAssetPaths(dataDir, domain) {
  const assetName = safeAssetName(domain);
  const directory = join(dataDir, "tls");
  return {
    directory,
    certificatePath: join(directory, `${assetName}.certificate.pem`),
    keyPath: join(directory, `${assetName}.private-key.pem`)
  };
}

async function readOptional(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(path, value, mode) {
  const candidate = `${path}.${randomBytes(6).toString("hex")}.candidate`;
  try {
    await writeFile(candidate, value, { mode, flag: "wx" });
    await chmod(candidate, mode);
    await rename(candidate, path);
  } finally {
    await unlink(candidate).catch(() => {});
  }
}

export class LocalTlsAssetStager {
  constructor(options = {}) {
    this.dataDir = options.dataDir || "/var/lib/raylink/sing-box";
    this.readFile = options.readFile || readFile;
  }

  async stage({ domain, certificatePath, keyPath }) {
    const prepared = await this.prepare({ domain, certificatePath, keyPath });
    await prepared.commit();
    return prepared;
  }

  async prepare({ domain, certificatePath, keyPath, validateHostname = false, now = new Date() }) {
    const { directory: targetDirectory, certificatePath: targetCertificatePath, keyPath: targetKeyPath } = localTlsAssetPaths(this.dataDir, domain);
    let certificatePem;
    let privateKeyPem;
    try {
      [certificatePem, privateKeyPem] = await Promise.all([
        this.readFile(certificatePath, "utf8"),
        this.readFile(keyPath, "utf8")
      ]);
    } catch {
      const error = new Error(`${domain} 的 Caddy TLS 证书或私钥无法读取`);
      error.code = "TLS_ASSET_UNREADABLE";
      error.statusCode = 422;
      throw error;
    }
    if (
      Buffer.byteLength(certificatePem) > 1024 * 1024
      || Buffer.byteLength(privateKeyPem) > 1024 * 1024
    ) {
      const error = new Error(`${domain} 的 TLS 资产超过 1 MiB 限制`);
      error.code = "TLS_ASSET_TOO_LARGE";
      error.statusCode = 422;
      throw error;
    }
    const certificate = validateCertificatePair(certificatePem, privateKeyPem, domain, now);
    if (validateHostname && !certificate.checkHost(domain)) {
      throw Object.assign(new Error("TLS 证书不包含受管节点域名"), { code: "TLS_CERTIFICATE_HOST_MISMATCH", statusCode: 422 });
    }
    const [previousCertificate, previousKey] = await Promise.all([
      readOptional(targetCertificatePath),
      readOptional(targetKeyPath)
    ]);
    const nextCertificate = Buffer.from(certificatePem);
    const nextKey = Buffer.from(privateKeyPem);
    const changed = !previousCertificate?.equals(nextCertificate)
      || !previousKey?.equals(nextKey);
    let attempted = false;
    const restore = async () => {
      if (!changed || !attempted) return;
      if (previousCertificate) {
        await atomicWrite(targetCertificatePath, previousCertificate, 0o644);
      } else {
        await unlink(targetCertificatePath).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
      if (previousKey) {
        await atomicWrite(targetKeyPath, previousKey, 0o600);
      } else {
        await unlink(targetKeyPath).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
      attempted = false;
    };
    const commit = async () => {
      await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
      await chmod(targetDirectory, 0o700);
      if (changed) {
        if (attempted) return;
        attempted = true;
        try {
          await atomicWrite(targetCertificatePath, nextCertificate, 0o644);
          await atomicWrite(targetKeyPath, nextKey, 0o600);
        } catch (error) {
          try { await restore(); } catch { error.rollbackFailed = true; }
          throw error;
        }
      } else {
        await Promise.all([
          chmod(targetCertificatePath, 0o644),
          chmod(targetKeyPath, 0o600)
        ]);
      }
    };
    return {
      certificatePath: targetCertificatePath,
      keyPath: targetKeyPath,
      fingerprint256: certificate.fingerprint256,
      validFrom: certificate.validFrom,
      validTo: certificate.validTo,
      changed,
      commit,
      rollback: restore
    };
  }
}

export class RemoteTlsAssetPackager {
  constructor(options = {}) {
    this.readFile = options.readFile || readFile;
    this.remoteDataDir = options.remoteDataDir || "/var/lib/raylink-node/sing-box";
  }

  async prepare(config, nodePublicKey) {
    const remoteConfig = structuredClone(config);
    const assets = [];
    for (const inbound of remoteConfig.inbounds || []) {
      const certificatePath = inbound.tls?.certificate_path;
      const keyPath = inbound.tls?.key_path;
      if (!certificatePath && !keyPath) continue;
      if (!certificatePath || !keyPath) {
        const error = new Error(`${inbound.tag || inbound.type} 的 TLS 证书路径不完整`);
        error.code = "TLS_ASSET_INCOMPLETE";
        error.statusCode = 422;
        throw error;
      }
      if (!nodePublicKey) {
        const error = new Error("远程主机尚未上报资产加密公钥，请先升级 RayLink Node");
        error.code = "NODE_ENCRYPTION_KEY_REQUIRED";
        error.statusCode = 409;
        throw error;
      }
      const [certificatePem, privateKeyPem] = await Promise.all([
        this.readFile(certificatePath, "utf8"),
        this.readFile(keyPath, "utf8")
      ]).catch(() => {
        const error = new Error(`${inbound.tag || inbound.type} 的 TLS 证书或私钥无法读取`);
        error.code = "TLS_ASSET_UNREADABLE";
        error.statusCode = 422;
        throw error;
      });
      if (Buffer.byteLength(certificatePem) > 1024 * 1024 || Buffer.byteLength(privateKeyPem) > 1024 * 1024) {
        const error = new Error(`${inbound.tag || inbound.type} 的 TLS 资产超过 1 MiB 限制`);
        error.code = "TLS_ASSET_TOO_LARGE";
        error.statusCode = 422;
        throw error;
      }
      const certificate = validateCertificatePair(
        certificatePem,
        privateKeyPem,
        inbound.tag || inbound.type
      );
      const assetName = safeAssetName(inbound.tag || inbound.type);
      const releaseId = certificate.fingerprint256.toLowerCase().replace(/[^a-f0-9]/g, "");
      const targetDirectory = join(this.remoteDataDir, "tls", "releases", releaseId);
      const targetCertificatePath = join(targetDirectory, `${assetName}.certificate.pem`);
      const targetKeyPath = join(targetDirectory, `${assetName}.private-key.pem`);
      inbound.tls.certificate_path = targetCertificatePath;
      inbound.tls.key_path = targetKeyPath;
      assets.push({
        name: assetName,
        certificatePem,
        privateKeyPem,
        targetCertificatePath,
        targetKeyPath,
        fingerprint256: certificate.fingerprint256,
        validTo: certificate.validTo
      });
    }
    if (!assets.length) {
      return { config: remoteConfig, sealedTlsBundle: null, tlsAssets: [] };
    }
    return {
      config: remoteConfig,
      sealedTlsBundle: sealNodeSecret(nodePublicKey, { assets }),
      tlsAssets: assets.map(({ name, fingerprint256, validTo }) => ({
        name,
        fingerprint256,
        validTo
      }))
    };
  }
}
