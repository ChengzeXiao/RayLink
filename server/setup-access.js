import { execFile as execFileCallback } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { access, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connect as tlsConnect } from "node:tls";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

function setupAccessError(code, message, statusCode, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function replaceEnvironmentValue(source, key, value) {
  const prefix = `${key}=`;
  let replaced = false;
  const lines = String(source).split(/\r?\n/).flatMap((line) => {
    if (!line.startsWith(prefix)) return [line];
    if (replaced) return [];
    replaced = true;
    return [`${prefix}${value}`];
  });
  if (!replaced) {
    if (lines.at(-1) === "") lines.splice(lines.length - 1, 0, `${prefix}${value}`);
    else lines.push(`${prefix}${value}`);
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function normalizedIp(value) {
  return String(value).replace(/^\[|\]$/g, "").toLowerCase();
}

function trustedTlsConnection(origin, timeoutMs) {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = tlsConnect({
      host: "127.0.0.1",
      port: Number(url.port) || 443,
      servername: url.hostname,
      rejectUnauthorized: true
    });
    socket.setTimeout(timeoutMs);
    socket.once("secureConnect", () => {
      socket.write(
        `GET /api/setup/status HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`
      );
    });
    socket.once("data", (chunk) => {
      if (!/^HTTP\/1\.[01] [1-5]\d\d\b/.test(String(chunk))) {
        socket.destroy(new Error("HTTPS health probe returned an invalid response"));
        return;
      }
      settled = true;
      socket.end();
      resolve();
    });
    socket.once("timeout", () => {
      socket.destroy(new Error("TLS connection timed out"));
    });
    socket.once("error", (error) => {
      if (!settled) reject(error);
    });
  });
}

async function waitForTrustedHttps(origin) {
  let lastError;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await trustedTlsConnection(origin, Math.min(3_000, deadline - Date.now()));
      return;
    } catch (error) {
      lastError = error;
      const remaining = deadline - Date.now();
      if (remaining > 0) await delay(Math.min(2_000, remaining));
    }
  }
  throw lastError;
}

async function locateCaddyCertificate(dataDirectory, domain) {
  const issuers = await readdir(dataDirectory, { withFileTypes: true }).catch(() => []);
  const candidates = [];
  for (const issuer of issuers) {
    if (!issuer.isDirectory()) continue;
    const base = join(dataDirectory, issuer.name, domain);
    const certificatePath = join(base, `${domain}.crt`);
    const keyPath = join(base, `${domain}.key`);
    try {
      await access(keyPath);
      const certificate = new X509Certificate(await readFile(certificatePath));
      const validFrom = Date.parse(certificate.validFrom);
      const validTo = Date.parse(certificate.validTo);
      if (validFrom <= Date.now() && validTo > Date.now() && certificate.checkHost(domain)) {
        candidates.push({ certificatePath, keyPath, validFrom, validTo });
      }
    } catch {}
  }
  const latest = candidates.sort((a, b) => b.validFrom - a.validFrom || b.validTo - a.validTo)[0];
  return latest ? { certificatePath: latest.certificatePath, keyPath: latest.keyPath } : null;
}

function caddyfileForDomains({
  consoleDomain,
  subscriptionDomain,
  email,
  initialOrigin,
  certificatePath,
  privateKeyPath
}) {
  const subscriptionSite = subscriptionDomain === consoleDomain
    ? ""
    : `
${subscriptionDomain} {
\t@subscription path /sub/* /rule-sets/*
\thandle @subscription {
\t\timport raylink_proxy
\t}
\thandle {
\t\trespond 404
\t}
}
`;
  return `{
\tadmin 127.0.0.1:2019
\temail ${email}
}

(raylink_proxy) {
\tencode zstd gzip
\treverse_proxy 127.0.0.1:4173
\theader {
\t\tX-Content-Type-Options nosniff
\t\tX-Frame-Options DENY
\t\tReferrer-Policy no-referrer
\t}
}

${consoleDomain} {
\timport raylink_proxy
}
${subscriptionSite}

${initialOrigin} {
\ttls ${certificatePath} ${privateKeyPath}
\timport raylink_proxy
}
`;
}

export class CaddySetupAccessManager {
  constructor({
    caddyfilePath,
    environmentFilePath,
    initialOrigin,
    certificatePath,
    privateKeyPath,
    caddyBinary = "caddy",
    lookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
    verifyHttps = waitForTrustedHttps,
    caddyDataDirectory = "/var/lib/caddy/.local/share/caddy/certificates",
    locateCertificate = (domain) => locateCaddyCertificate(caddyDataDirectory, domain),
    replaceFile = rename,
    runCommand = (command, args) => execFile(command, args, {
      timeout: 30_000,
      windowsHide: true
    })
  }) {
    this.caddyfilePath = caddyfilePath;
    this.environmentFilePath = environmentFilePath;
    this.initialOrigin = new URL(initialOrigin).origin;
    this.certificatePath = certificatePath;
    this.privateKeyPath = privateKeyPath;
    this.caddyBinary = caddyBinary;
    this.lookup = lookup;
    this.verifyHttps = verifyHttps;
    this.locateCertificate = locateCertificate;
    this.replaceFile = replaceFile;
    this.runCommand = runCommand;
    this.caddyMutation = Promise.resolve();
  }

  async mutateCaddy(callback) {
    const previous = this.caddyMutation;
    let release;
    this.caddyMutation = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }

  async findNodeCertificate(domain) {
    const hostname = String(domain || "").trim().toLowerCase();
    if (isIP(hostname) || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(hostname)) return null;
    let caddyfile;
    try { caddyfile = await readFile(this.caddyfilePath, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    const marker = `# RayLink managed node certificate: ${hostname}`;
    if (!caddyfile.split(/\r?\n/).some((line) => line.trim() === marker)) return null;
    const source = await this.locateCertificate(hostname);
    return source ? { ...source, serverName: hostname, managedBy: "caddy" } : null;
  }

  async ensureNodeCertificate(domain) {
    const hostname = String(domain || "").trim().toLowerCase();
    if (isIP(hostname) || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(hostname)) {
      throw setupAccessError("NODE_DOMAIN_REQUIRED", "节点自动证书需要有效域名", 422);
    }
    const addresses = await this.lookup(hostname).catch((error) => {
      throw setupAccessError(
        "NODE_DOMAIN_DNS_NOT_READY",
        `节点域名 ${hostname} 尚未解析`,
        422,
        error
      );
    });
    const initialHostname = normalizedIp(new URL(this.initialOrigin).hostname);
    if (
      isIP(initialHostname)
      && !addresses.some(({ address }) => normalizedIp(address) === initialHostname)
    ) {
      throw setupAccessError(
        "NODE_DOMAIN_DNS_MISMATCH",
        `节点域名 ${hostname} 必须解析到本机公网 IP ${initialHostname}`,
        422
      );
    }
    const marker = `# RayLink managed node certificate: ${hostname}`;
    const block = `${marker}\nhttps://${hostname} {\n\trespond 204\n}\n`;
    let inserted = false;
    const removeManagedBlock = async () => {
      if (!inserted) return;
      await this.mutateCaddy(async () => {
        const current = await readFile(this.caddyfilePath, "utf8");
        const escaped = hostname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const withoutBlock = current.replace(
          new RegExp(
            `\\n*# RayLink managed node certificate: ${escaped}\\nhttps:\\/\\/${escaped} \\{\\n\\trespond 204\\n\\}\\n?`
          ),
          "\n"
        );
        await writeFile(this.caddyfilePath, `${withoutBlock.trimEnd()}\n`, { mode: 0o644 });
        await this.runCommand(this.caddyBinary, [
          "reload",
          "--config",
          this.caddyfilePath,
          "--adapter",
          "caddyfile"
        ]);
        inserted = false;
      });
    };
    await this.mutateCaddy(async () => {
      const current = await readFile(this.caddyfilePath, "utf8");
      if (current.includes(marker)) return;
      const candidate = `${this.caddyfilePath}.node-certificate.candidate`;
      await writeFile(candidate, `${current.trimEnd()}\n\n${block}`, { mode: 0o644 });
      try {
        await this.runCommand(this.caddyBinary, [
          "adapt",
          "--config",
          candidate,
          "--adapter",
          "caddyfile"
        ]);
        await this.replaceFile(candidate, this.caddyfilePath);
        inserted = true;
        await this.runCommand(this.caddyBinary, [
          "reload",
          "--config",
          this.caddyfilePath,
          "--adapter",
          "caddyfile"
        ]);
      } catch (error) {
        await unlink(candidate).catch(() => {});
        if (inserted) {
          await writeFile(this.caddyfilePath, current, { mode: 0o644 });
          await this.runCommand(this.caddyBinary, [
            "reload",
            "--config",
            this.caddyfilePath,
            "--adapter",
            "caddyfile"
          ]).catch(() => {});
        }
        throw setupAccessError(
          "NODE_CERTIFICATE_ACTIVATION_FAILED",
          `Caddy 无法为节点域名 ${hostname} 启用证书`,
          502,
          error
        );
      } finally {
        await unlink(candidate).catch(() => {});
      }
    });
    let certificate = null;
    const deadline = Date.now() + 90_000;
    while (!certificate && Date.now() < deadline) {
      certificate = await this.locateCertificate(hostname);
      if (!certificate) await delay(1_000);
    }
    if (!certificate) {
      const error = setupAccessError(
        "NODE_CERTIFICATE_NOT_READY",
        `Caddy 未能在 90 秒内签发 ${hostname} 的证书`,
        502
      );
      try {
        await removeManagedBlock();
      } catch (rollbackError) {
        error.rollbackError = rollbackError.message;
      }
      throw error;
    }
    return {
      ...certificate,
      serverName: hostname,
      managedBy: "caddy",
      rollback: removeManagedBlock
    };
  }

  async preflight(input) {
    const origins = [...new Set([
      input.access.canonicalOrigin,
      input.access.subscriptionOrigin
    ])];
    for (const origin of origins) {
      const hostname = new URL(origin).hostname;
      try {
        const addresses = await this.lookup(hostname);
        if (!Array.isArray(addresses) || addresses.length === 0) {
          throw new Error("DNS returned no addresses");
        }
        const initialHostname = normalizedIp(new URL(this.initialOrigin).hostname);
        if (
          isIP(initialHostname)
          && !addresses.some(({ address }) => normalizedIp(address) === initialHostname)
        ) {
          const resolved = addresses.map(({ address }) => address).join(", ");
          throw setupAccessError(
            "DOMAIN_DNS_MISMATCH",
            `域名 ${hostname} 当前解析到 ${resolved}，请改为本机公网 IP ${initialHostname} 后重试`,
            422
          );
        }
      } catch (error) {
        if (error?.code === "DOMAIN_DNS_MISMATCH") throw error;
        throw setupAccessError(
          "DOMAIN_DNS_NOT_READY",
          `域名 ${hostname} 尚未解析，请配置 DNS 后重试`,
          422,
          error
        );
      }
    }
    try {
      await this.runCommand(this.caddyBinary, ["version"]);
    } catch (error) {
      throw setupAccessError(
        "CADDY_UNAVAILABLE",
        "未检测到可用的 Caddy 服务",
        409,
        error
      );
    }
    return { dns: "passed", caddy: "passed" };
  }

  async activate(input) {
    const canonicalOrigin = new URL(input.access.canonicalOrigin);
    const subscriptionOrigin = new URL(input.access.subscriptionOrigin);
    const previousCaddyfile = await readFile(this.caddyfilePath, "utf8");
    const previousEnvironment = await readFile(this.environmentFilePath, "utf8");
    const nextCaddyfile = caddyfileForDomains({
      consoleDomain: canonicalOrigin.hostname,
      subscriptionDomain: subscriptionOrigin.hostname,
      email: input.certificate.email,
      initialOrigin: this.initialOrigin,
      certificatePath: this.certificatePath,
      privateKeyPath: this.privateKeyPath
    });
    const nextEnvironment = replaceEnvironmentValue(
      replaceEnvironmentValue(
        replaceEnvironmentValue(
          previousEnvironment,
          "RAYLINK_PUBLIC_ORIGIN",
          canonicalOrigin.origin
        ),
        "RAYLINK_SUBSCRIPTION_ORIGIN",
        subscriptionOrigin.origin
      ),
      "RAYLINK_PROXY_HOST",
      input.runtime.address
    );
    const caddyCandidate = `${this.caddyfilePath}.candidate`;
    const environmentCandidate = `${this.environmentFilePath}.candidate`;

    await writeFile(caddyCandidate, nextCaddyfile, { mode: 0o644 });
    try {
      await this.runCommand(this.caddyBinary, [
        "adapt",
        "--config",
        caddyCandidate,
        "--adapter",
        "caddyfile"
      ]);
    } catch (error) {
      await unlink(caddyCandidate).catch(() => {});
      throw setupAccessError(
        "CADDY_CONFIG_INVALID",
        "Caddy 域名配置校验失败",
        422,
        error
      );
    }

    await writeFile(environmentCandidate, nextEnvironment, { mode: 0o600 });
    const restoreFiles = async () => {
      await writeFile(caddyCandidate, previousCaddyfile, { mode: 0o644 });
      await writeFile(environmentCandidate, previousEnvironment, { mode: 0o600 });
      await this.replaceFile(caddyCandidate, this.caddyfilePath);
      await this.replaceFile(environmentCandidate, this.environmentFilePath);
    };
    const restore = async () => {
      await restoreFiles();
      await this.runCommand(this.caddyBinary, [
        "reload",
        "--config",
        this.caddyfilePath,
        "--adapter",
        "caddyfile"
      ]);
    };

    try {
      await this.replaceFile(caddyCandidate, this.caddyfilePath);
      await this.replaceFile(environmentCandidate, this.environmentFilePath);
    } catch (error) {
      try {
        await restoreFiles();
      } catch (rollbackError) {
        throw setupAccessError(
          "CADDY_ROLLBACK_FAILED",
          "Caddy 配置文件写入失败，且旧配置恢复失败，请登录服务器检查",
          500,
          rollbackError
        );
      }
      throw setupAccessError(
        "CADDY_FILES_ACTIVATION_FAILED",
        "Caddy 配置文件写入失败，已恢复原配置",
        500,
        error
      );
    } finally {
      await unlink(caddyCandidate).catch(() => {});
      await unlink(environmentCandidate).catch(() => {});
    }

    try {
      await this.runCommand(this.caddyBinary, [
        "reload",
        "--config",
        this.caddyfilePath,
        "--adapter",
        "caddyfile"
      ]);
    } catch (error) {
      try {
        await restore();
      } catch (rollbackError) {
        throw setupAccessError(
          "CADDY_ROLLBACK_FAILED",
          "Caddy 域名配置失败，且 IP 入口恢复失败，请登录服务器检查 Caddy",
          500,
          rollbackError
        );
      }
      throw setupAccessError(
        "CADDY_ACTIVATION_FAILED",
        "Caddy 无法启用域名，请检查 80/443 端口和 DNS",
        502,
        error
      );
    }

    try {
      for (const origin of new Set([
        canonicalOrigin.origin,
        subscriptionOrigin.origin
      ])) {
        await this.verifyHttps(origin);
      }
    } catch (error) {
      try {
        await restore();
      } catch (rollbackError) {
        throw setupAccessError(
          "CADDY_ROLLBACK_FAILED",
          "域名 HTTPS 未能生效，且 IP 入口恢复失败，请登录服务器检查 Caddy",
          500,
          rollbackError
        );
      }
      throw setupAccessError(
        "DOMAIN_HTTPS_NOT_READY",
        "未能签发并验证域名 HTTPS 证书，请确认 DNS 已生效且公网 80/443 端口开放",
        502,
        error
      );
    }

    let active = true;
    return {
      rollback: async () => {
        if (!active) return;
        active = false;
        await restore();
      }
    };
  }
}
