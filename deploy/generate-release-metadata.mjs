#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

function fail(message) {
  process.stderr.write(`RayLink 发布元数据生成失败：${message}\n`);
  process.exit(1);
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function atomicJson(path, value) {
  const candidate = `${path}.${process.pid}.tmp`;
  await writeFile(candidate, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  await rename(candidate, path);
}

const [
  archiveArgument,
  runtimeArgument,
  version = "",
  runtimeVersion = "",
  architecture = "",
  cronetArgument,
  lockArgument
] = process.argv.slice(2);

if (!archiveArgument || !runtimeArgument || !cronetArgument) {
  fail("用法：generate-release-metadata.mjs ARCHIVE RUNTIME VERSION RUNTIME_VERSION ARCH CRONET");
}
if (!/^\d+\.\d+\.\d+$/.test(version)) fail("RayLink 版本格式无效");
if (!/^1\.14\.2$/.test(runtimeVersion)) fail("sing-box Runtime 版本格式无效");
if (!["amd64", "arm64"].includes(architecture)) fail("发布架构必须是 amd64 或 arm64");

const archivePath = resolve(archiveArgument);
const runtimePath = resolve(runtimeArgument);
const cronetPath = resolve(cronetArgument);
const expectedArchiveName = `raylink-${version}-linux-${architecture}.tar.gz`;
const expectedRuntimeName = `raylink-sing-box-${runtimeVersion}-linux-${architecture}`;
const expectedCronetName = `raylink-libcronet-${runtimeVersion}-linux-${architecture}.so`;
if (basename(archivePath) !== expectedArchiveName) fail("发布包名称与版本或架构不一致");
if (basename(runtimePath) !== expectedRuntimeName) fail("Runtime 名称与版本或架构不一致");
if (basename(cronetPath) !== expectedCronetName) fail("Cronet 名称与版本或架构不一致");

const [
  archiveStats,
  runtimeStats,
  cronetStats,
  archiveSha256,
  runtimeSha256,
  cronetSha256
] = await Promise.all([
  stat(archivePath),
  stat(runtimePath),
  stat(cronetPath),
  sha256(archivePath),
  sha256(runtimePath),
  sha256(cronetPath)
]).catch((error) => fail(error.message || "无法读取发布产物"));
const createdAt = new Date().toISOString();
const assetPrefix = expectedArchiveName.replace(/\.tar\.gz$/, "");
const outputDirectory = dirname(archivePath);
const manifestPath = join(outputDirectory, `${assetPrefix}.manifest.json`);
const sbomPath = join(outputDirectory, `${assetPrefix}.spdx.json`);

const manifest = {
  schemaVersion: 1,
  product: "RayLink",
  version,
  platform: "linux",
  architecture,
  createdAt,
  archive: {
    filename: expectedArchiveName,
    sizeBytes: archiveStats.size,
    sha256: archiveSha256
  },
  runtime: {
    name: "sing-box",
    version: runtimeVersion,
    filename: expectedRuntimeName,
    sizeBytes: runtimeStats.size,
    sha256: runtimeSha256,
    companions: [{
      name: "Cronet",
      filename: expectedCronetName,
      sizeBytes: cronetStats.size,
      sha256: cronetSha256
    }]
  }
};

const documentId = `SPDXRef-DOCUMENT`;
const rayLinkId = "SPDXRef-Package-RayLink";
const singBoxId = "SPDXRef-Package-sing-box";
const cronetId = "SPDXRef-Package-Cronet";
const sbom = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: documentId,
  name: `${assetPrefix}-sbom`,
  documentNamespace: `https://github.com/Zanetach/RayLink/releases/download/v${version}/${assetPrefix}.spdx.json#${archiveSha256}`,
  creationInfo: {
    created: createdAt,
    creators: ["Tool: RayLink-release-metadata/1"]
  },
  packages: [
    {
      name: "RayLink",
      SPDXID: rayLinkId,
      versionInfo: version,
      supplier: "NOASSERTION",
      downloadLocation: `https://github.com/Zanetach/RayLink/releases/download/v${version}/${expectedArchiveName}`,
      filesAnalyzed: false,
      licenseConcluded: "NOASSERTION",
      licenseDeclared: "NOASSERTION",
      copyrightText: "NOASSERTION",
      checksums: [{ algorithm: "SHA256", checksumValue: archiveSha256 }]
    },
    {
      name: "sing-box",
      SPDXID: singBoxId,
      versionInfo: runtimeVersion,
      supplier: "Organization: SagerNet",
      downloadLocation: `https://github.com/SagerNet/sing-box/releases/tag/v${runtimeVersion}`,
      filesAnalyzed: false,
      licenseConcluded: "NOASSERTION",
      licenseDeclared: "GPL-3.0-or-later",
      copyrightText: "NOASSERTION",
      checksums: [{ algorithm: "SHA256", checksumValue: runtimeSha256 }]
    },
    {
      name: "Cronet",
      SPDXID: cronetId,
      versionInfo: runtimeVersion,
      supplier: "Organization: SagerNet",
      downloadLocation: `https://github.com/SagerNet/sing-box/releases/tag/v${runtimeVersion}`,
      filesAnalyzed: false,
      licenseConcluded: "NOASSERTION",
      licenseDeclared: "NOASSERTION",
      copyrightText: "NOASSERTION",
      checksums: [{ algorithm: "SHA256", checksumValue: cronetSha256 }]
    }
  ],
  relationships: [
    {
      spdxElementId: documentId,
      relationshipType: "DESCRIBES",
      relatedSpdxElement: rayLinkId
    },
    {
      spdxElementId: rayLinkId,
      relationshipType: "DEPENDS_ON",
      relatedSpdxElement: singBoxId
    },
    {
      spdxElementId: singBoxId,
      relationshipType: "DEPENDS_ON",
      relatedSpdxElement: cronetId
    }
  ]
};

// Inventory the installed release candidate, not the developer's node_modules.
// Optional dependencies absent on the release platform are not shipped.
if (lockArgument) {
  const lockPath = resolve(lockArgument);
  const lockText = await readFile(lockPath, "utf8");
  const lock = JSON.parse(lockText);
  let packageCount = 0;
  for (const [packagePath, entry] of Object.entries(lock.packages || {})) {
    if (!packagePath || entry.dev) continue;
    if (!packagePath.startsWith("node_modules/") || packagePath.split("/").includes("..") || entry.link) {
      fail(`不支持的生产依赖路径：${packagePath}`);
    }
    const installed = await readFile(join(dirname(lockPath), packagePath, "package.json"), "utf8")
      .then(JSON.parse).catch((error) => {
        if (entry.optional && error.code === "ENOENT") return null;
        throw error;
      });
    if (!installed) continue;
    if (!installed.name || installed.version !== entry.version) fail(`生产依赖版本与锁文件不一致：${packagePath}`);
    const packageId = `SPDXRef-npm-${createHash("sha256").update(packagePath).digest("hex").slice(0, 24)}`;
    const integrity = /^(sha256|sha512)-([A-Za-z0-9+/=]+)$/.exec(entry.integrity || "");
    sbom.packages.push({
      name: installed.name,
      SPDXID: packageId,
      versionInfo: installed.version,
      supplier: "NOASSERTION",
      downloadLocation: /^https?:\/\//.test(entry.resolved || "") ? entry.resolved : "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: "NOASSERTION",
      licenseDeclared: typeof installed.license === "string" ? installed.license : "NOASSERTION",
      copyrightText: "NOASSERTION",
      externalRefs: [{ referenceCategory: "PACKAGE-MANAGER", referenceType: "purl",
        referenceLocator: `pkg:npm/${installed.name.replace(/^@/, "%40")}@${installed.version}` }],
      ...(integrity ? { checksums: [{ algorithm: integrity[1].toUpperCase(), checksumValue: Buffer.from(integrity[2], "base64").toString("hex") }] } : {})
    });
    sbom.relationships.push({ spdxElementId: rayLinkId, relationshipType: "CONTAINS", relatedSpdxElement: packageId });
    packageCount += 1;
  }
  manifest.productionDependencies = { lockfile: "package-lock.json", sha256: createHash("sha256").update(lockText).digest("hex"), packageCount };
}

await Promise.all([
  atomicJson(manifestPath, manifest),
  atomicJson(sbomPath, sbom)
]);
process.stdout.write(`RayLink 发布清单：${manifestPath}\n`);
process.stdout.write(`RayLink SPDX SBOM：${sbomPath}\n`);
