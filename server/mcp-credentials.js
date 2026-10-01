import { randomUUID } from "node:crypto";
import { createSessionSecret, hashSessionSecret } from "./security.js";

export const MCP_SCOPES = Object.freeze([
  { id: "read", label: "读取状态", description: "读取不含密钥的用户、Host、Runtime 和系统状态" },
  { id: "users.manage", label: "管理用户", description: "创建和修改用户及其服务权益" },
  { id: "runtime.manage", label: "管理 Runtime", description: "管理协议、发布配置及执行 Runtime 操作" },
  { id: "system.manage", label: "管理系统", description: "修改证书设置、创建及校验备份" },
  { id: "admins.manage", label: "管理管理员", description: "管理管理员，仍受当前管理员角色限制" },
  { id: "audit.read", label: "读取审计", description: "读取操作审计记录" },
  { id: "secrets.read", label: "读取密钥", description: "读取工具明确允许返回的敏感凭据" }
].map((scope) => Object.freeze(scope)));
const SCOPE_IDS = new Set(MCP_SCOPES.map(({ id }) => id));

function credentialError(code, message, statusCode = 422) {
  return Object.assign(new Error(message), { code, statusCode });
}

function metadata(row) {
  return {
    id: row.id,
    adminId: row.admin_id,
    adminUsername: row.admin_username,
    name: row.name,
    scopes: JSON.parse(row.scopes_json),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at
  };
}

// Authorization belongs to the HTTP/tool layer. Each authentication returns
// the current administrator role so a token cannot preserve a former role.
export class McpCredentials {
  constructor({ store, clock = () => new Date() }) {
    this.db = store.db;
    this.clock = clock;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_credentials (
        id TEXT PRIMARY KEY,
        admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        scopes_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        last_used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS mcp_credentials_admin_created
        ON mcp_credentials(admin_id, created_at);
    `);
  }

  list(adminId) {
    const query = `SELECT credentials.*, admins.username AS admin_username
      FROM mcp_credentials AS credentials JOIN admins ON admins.id = credentials.admin_id
      ${adminId === undefined ? "" : "WHERE credentials.admin_id = ?"}
      ORDER BY credentials.created_at DESC, credentials.id DESC`;
    return (adminId === undefined ? this.db.prepare(query).all() : this.db.prepare(query).all(adminId)).map(metadata);
  }

  create({ adminId, name, scopes, expiresInDays = 30 } = {}) {
    if (typeof name !== "string" || !name.trim() || name.trim().length > 80
      || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name)) {
      throw credentialError("INVALID_MCP_NAME", "凭据名称需为 1–80 个字符，且不能包含控制字符");
    }
    if (!Array.isArray(scopes) || scopes.length === 0
      || scopes.length > 100 || Array.from(scopes).some((scope) => !SCOPE_IDS.has(scope))) {
      throw credentialError("INVALID_MCP_SCOPES", "请明确选择有效的 MCP 权限范围");
    }
    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) {
      throw credentialError("INVALID_MCP_EXPIRY", "凭据有效期必须为 1–365 天的整数");
    }
    if (typeof adminId !== "string" || !adminId) {
      throw credentialError("ADMIN_NOT_FOUND", "管理员不存在", 404);
    }
    const admin = this.db.prepare("SELECT id, username FROM admins WHERE id = ?").get(adminId);
    if (!admin) throw credentialError("ADMIN_NOT_FOUND", "管理员不存在", 404);
    const now = new Date(this.clock());
    const token = `rl_mcp_${createSessionSecret()}`;
    const row = {
      id: randomUUID(), admin_id: admin.id, admin_username: admin.username,
      name: name.trim(), scopes_json: JSON.stringify([...new Set(scopes)]), created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + expiresInDays * 86_400_000).toISOString(),
      revoked_at: null, last_used_at: null
    };
    this.db.prepare(`INSERT INTO mcp_credentials (
      id, admin_id, name, token_hash, scopes_json, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      row.id, row.admin_id, row.name, hashSessionSecret(token), row.scopes_json, row.created_at, row.expires_at
    );
    return { ...metadata(row), token };
  }

  authenticate(rawToken) {
    if (typeof rawToken !== "string" || !/^rl_mcp_[A-Za-z0-9_-]{43}$/.test(rawToken)) return null;
    const now = new Date(this.clock()).toISOString();
    const row = this.db.prepare(`
      SELECT credentials.id, credentials.admin_id, credentials.scopes_json,
             admins.username, admins.role
      FROM mcp_credentials AS credentials JOIN admins ON admins.id = credentials.admin_id
      WHERE credentials.token_hash = ? AND credentials.revoked_at IS NULL AND credentials.expires_at > ?
    `).get(hashSessionSecret(rawToken), now);
    if (!row) return null;
    this.db.prepare("UPDATE mcp_credentials SET last_used_at = ? WHERE id = ?").run(now, row.id);
    return {
      id: row.id, adminId: row.admin_id, scopes: JSON.parse(row.scopes_json),
      admin: { id: row.admin_id, username: row.username, role: row.role }
    };
  }

  revoke(id) {
    if (typeof id !== "string" || !id) {
      throw credentialError("MCP_CREDENTIAL_NOT_FOUND", "MCP 凭据不存在", 404);
    }
    const row = this.db.prepare(`
      UPDATE mcp_credentials SET revoked_at = COALESCE(revoked_at, ?)
      WHERE id = ? RETURNING *
    `).get(new Date(this.clock()).toISOString(), id);
    if (!row) throw credentialError("MCP_CREDENTIAL_NOT_FOUND", "MCP 凭据不存在", 404);
    const admin = this.db.prepare("SELECT username FROM admins WHERE id = ?").get(row.admin_id);
    return metadata({ ...row, admin_username: admin?.username || "" });
  }

  close() {
    // The store owns the shared database connection.
  }
}
