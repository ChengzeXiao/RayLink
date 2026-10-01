import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRayLinkApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";

const dataDir = process.env.RAYLINK_LOCAL_DATA_DIR
  ? resolve(process.env.RAYLINK_LOCAL_DATA_DIR)
  : fileURLToPath(new URL("../.raylink-local/", import.meta.url));
await mkdir(dataDir, { recursive: true, mode: 0o700 });
const credentialPath = join(dataDir, "local-credentials.json");
let identity;
try { identity = JSON.parse(await readFile(credentialPath, "utf8")); }
catch (error) {
  if (error.code !== "ENOENT") throw error;
  try {
    await access(join(dataDir, "raylink.db"));
    throw new Error("Existing local database has no credential file. Restore local-credentials.json before starting; existing accounts were not changed.");
  } catch (missing) { if (missing.code !== "ENOENT") throw missing; }
  identity = { username: "admin", password: randomBytes(24).toString("base64url"), encryptionKey: randomBytes(32).toString("base64url") };
  await writeFile(credentialPath, `${JSON.stringify(identity, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
if (identity.username !== "admin" || typeof identity.password !== "string" || identity.password.length < 12
  || typeof identity.encryptionKey !== "string" || identity.encryptionKey.length < 32) throw new Error("Invalid local-credentials.json; restore the existing local credentials.");
await chmod(credentialPath, 0o600);
const port = process.env.RAYLINK_PORT || "4199";
const origin = `http://127.0.0.1:${port}`;
const loginPath = join(dataDir, "initial-login.txt");
try {
  await writeFile(loginPath, `RayLink 本机初始登录信息\n地址：${origin}\n用户名：${identity.username}\n密码：${identity.password}\n\n这是首次创建时的凭据。若已在界面修改账号，请使用修改后的登录名和密码。\n`, { flag: "wx", mode: 0o600 });
} catch (error) { if (error.code !== "EEXIST") throw error; }
const config = loadConfig({ NODE_ENV: "development", RAYLINK_HOST: "127.0.0.1", RAYLINK_PORT: port,
  ...(process.env.SING_BOX_BIN ? { SING_BOX_BIN: process.env.SING_BOX_BIN } : {}),
  RAYLINK_DATA_DIR: dataDir, RAYLINK_PUBLIC_ORIGIN: origin, RAYLINK_SUBSCRIPTION_ORIGIN: origin,
  RAYLINK_ADMIN_USERNAME: identity.username, RAYLINK_ADMIN_PASSWORD: identity.password,
  RAYLINK_SUBSCRIPTION_ENCRYPTION_KEY: identity.encryptionKey, RAYLINK_SETUP_REQUIRED: "false", RAYLINK_RUNTIME_MODE: "dry-run" });
const app = await createRayLinkApp({ ...config, seedDemoData: false, alertWebhookUrl: "", alertIntervalMs: 0, runtimeUpdateCheckIntervalMs: 0 });
try { await app.listen({ host: config.host, port: config.port }); }
catch (error) { await app.close(); throw error; }
console.log(`[RayLink] Local control plane listening on ${origin}`);
console.log(`[RayLink] Persistent local data: ${dataDir}`);
console.log(`[RayLink] Initial login details: ${loginPath}`);
console.log("[RayLink] Local development mode; remote Node onboarding requires a VPS-reachable HTTPS control plane.");
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await app.close(); process.exit(0); }
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
