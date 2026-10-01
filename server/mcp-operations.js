import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function operationError(code, message) {
  return Object.assign(new Error(message), { code, statusCode: 409 });
}
function keyFor(token, purpose) {
  return createHash("sha256").update(`raylink-mcp-${purpose}-v1\0${token}`).digest();
}
function encrypt(value, token, aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(token, "result"), iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}
function decrypt(value, token, aad) {
  const bytes = Buffer.from(value, "base64");
  const decipher = createDecipheriv("aes-256-gcm", keyFor(token, "result"), bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"));
}

// Durable claim before side effects; completed responses are encrypted with the
// caller's token, which is never stored. Pending claims survive a crash and are
// never automatically executed again: a partial external effect is possible.
export class McpOperations {
  constructor(store) {
    this.db = store.db;
    this.inFlight = new Map();
    this.db.exec(`CREATE TABLE IF NOT EXISTS mcp_operations (
      credential_id TEXT NOT NULL REFERENCES mcp_credentials(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      result_encrypted TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (credential_id, request_id)
    )`);
  }

  async run({ principal, token, tool, args }, execute) {
    const operationKey = JSON.stringify([principal.id, args.requestId]);
    const inputHash = createHmac("sha256", keyFor(token, "input")).update(canonical(args)).digest("hex");
    const claim = this.db.prepare(`INSERT OR IGNORE INTO mcp_operations
      (credential_id, request_id, tool, input_hash, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(principal.id, args.requestId, tool.name, inputHash, new Date().toISOString());
    const aad = JSON.stringify([principal.id, args.requestId, tool.name, inputHash]);
    if (!claim.changes) {
      const row = this.db.prepare("SELECT * FROM mcp_operations WHERE credential_id = ? AND request_id = ?")
        .get(principal.id, args.requestId);
      if (row.tool !== tool.name || row.input_hash !== inputHash) {
        throw operationError("REQUEST_ID_CONFLICT", "requestId 已用于其他参数或工具，请为新操作生成新编号");
      }
      if (row.result_encrypted) {
        return { value: decrypt(row.result_encrypted, token, aad), replayed: true };
      }
      if (this.inFlight.has(operationKey)) {
        return { value: await this.inFlight.get(operationKey), replayed: true };
      }
      throw operationError("OPERATION_OUTCOME_UNKNOWN", "该请求尚未完成或执行期间服务中断。请先检查用户、主机或发布记录；不要换编号盲目重试");
    }
    const promise = Promise.resolve().then(execute).then((value) => {
      this.db.prepare("UPDATE mcp_operations SET result_encrypted = ? WHERE credential_id = ? AND request_id = ?")
        .run(encrypt(value, token, aad), principal.id, args.requestId);
      return value;
    });
    this.inFlight.set(operationKey, promise);
    try { return { value: await promise, replayed: false }; }
    finally { this.inFlight.delete(operationKey); }
  }
}
