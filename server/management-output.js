// Defense in depth after the resource allowlist. Advanced JSON and raw errors
// may embed credentials, so ordinary tools expose their status rather than text.
export function safeManagementOutput(value) {
  if (Array.isArray(value)) return value.map(safeManagementOutput);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    const normalized = key.replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
    if (key === "passwordReset" && typeof child === "boolean") return [[key, child]];
    if (key === "passwordConfigured" && typeof child === "boolean") return [[key, child]];
    if (key === "tokenConfigured" && typeof child === "boolean") return [[key, child]];
    if (key === "subscriptionVerified" && typeof child === "boolean") return [[key, child]];
    if (key === "subscriptionStatus" && ["verified", "awaiting-users"].includes(child)) return [[key, child]];
    if (/password|secret|token|privatekey|runtimeuuid|subscription|authorization|cookie|credential|configtext|configjson|sealedtlsbundle/.test(normalized)
      || ["options", "config", "raw", "error", "lasterror", "rollbackerror"].includes(normalized)) return [];
    return [[key, safeManagementOutput(child)]];
  }));
}
