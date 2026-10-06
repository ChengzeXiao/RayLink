#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { RayLinkStore } from "../server/database.js";

function fail(message) {
  process.stderr.write(`RayLink 数据库兼容检查失败：${message}\n`);
  process.exitCode = 1;
}

function schemaSnapshot(database) {
  return JSON.stringify({
    schema: database.prepare(
      "SELECT type, name, tbl_name, rootpage, sql FROM sqlite_schema ORDER BY type, name, tbl_name"
    ).all(),
    userVersion: database.prepare("PRAGMA user_version").get().user_version
  });
}

const sourcePath = process.argv[2] ? resolve(process.argv[2]) : "";
const requireUnchangedSchema = process.argv.includes("--require-unchanged-schema");
if (!sourcePath) {
  fail("请提供升级前 raylink.db 的完整路径");
} else if (process.argv.slice(3).some((argument) => argument !== "--require-unchanged-schema")) {
  fail("不支持的数据库检查参数");
} else {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "raylink-db-compat-"));
  const candidatePath = join(temporaryDirectory, basename(sourcePath));
  try {
    await copyFile(sourcePath, candidatePath);
    for (const suffix of ["-wal", "-shm"]) {
      await copyFile(`${sourcePath}${suffix}`, `${candidatePath}${suffix}`).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }

    // Inspect only the disposable copy, including indexes, views, triggers and
    // the application's migration version, before the candidate opens it.
    const baseline = new DatabaseSync(candidatePath, { readOnly: true });
    let previousSchema;
    try { previousSchema = schemaSnapshot(baseline); } finally { baseline.close(); }
    const compatibilityStore = new RayLinkStore({
      dbPath: candidatePath,
      adminUsername: `compat-${randomUUID()}`,
      adminPassword: `Compatibility-${randomUUID()}`,
      subscriptionEncryptionKey: randomUUID(),
      seedDemoData: false,
      setupRequired: false
    });
    compatibilityStore.close();

    const verified = new DatabaseSync(candidatePath, { readOnly: true });
    try {
      const integrity = String(
        verified.prepare("PRAGMA integrity_check").get().integrity_check || ""
      );
      if (integrity !== "ok") throw new Error(`PRAGMA integrity_check 返回 ${integrity}`);
      const foreignKeyErrors = verified.prepare("PRAGMA foreign_key_check").all();
      if (foreignKeyErrors.length) {
        throw new Error(`发现 ${foreignKeyErrors.length} 个外键约束错误`);
      }
      const schemaUnchanged = schemaSnapshot(verified) === previousSchema;
      if (requireUnchangedSchema && !schemaUnchanged) {
        throw new Error("数据库 schema 已变化，不能在回滚旧程序时保留候选版本的数据");
      }
      process.stdout.write(`${JSON.stringify({
        compatible: true,
        schemaUnchanged,
        integrity,
        foreignKeyErrors: 0
      })}\n`);
    } finally {
      verified.close();
    }
  } catch (error) {
    fail(error.message || "候选版本无法打开数据库副本");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
