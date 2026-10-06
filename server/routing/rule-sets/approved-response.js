// The manifest pins the decoded artifact length. Content-Length is a useful
// early rejection, but the stream itself remains the authoritative size check.
const MAX_APPROVED_RULE_SET_BYTES = 32 * 1024 * 1024;

export async function readApprovedRuleSetResponse(response, expectedBytes) {
  let reader;
  let validationError;
  const fail = (message) => {
    validationError = new Error(message);
    throw validationError;
  };
  try {
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > MAX_APPROVED_RULE_SET_BYTES) {
      fail("Invalid approved rule-set response size");
    }
    if (!response?.ok) fail(`Rule-set response HTTP ${response?.status ?? "unavailable"}`);
    if (!response.body) fail("Empty approved rule-set response");
    const rawLength = response.headers.get("content-length");
    if (rawLength !== null) {
      if (!/^\d+$/.test(rawLength)) fail("Invalid rule-set Content-Length");
      const length = Number(rawLength);
      if (!Number.isSafeInteger(length) || length > MAX_APPROVED_RULE_SET_BYTES) fail("Rule-set Content-Length exceeds limit");
      // Fetch decodes Content-Encoding before exposing the body; its wire
      // Content-Length then need not equal the decoded manifest length.
      const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
      if ((!encoding || encoding === "identity") && length !== expectedBytes) fail("Rule-set Content-Length differs from approved size");
    }
    reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > expectedBytes) fail("Rule-set response exceeds approved size");
      chunks.push(result.value);
    }
    if (length !== expectedBytes) fail("Truncated approved rule-set response");
    return Buffer.concat(chunks, length);
  } catch (error) {
    try {
      if (reader) await reader.cancel();
      else await response?.body?.cancel();
    } catch { /* Preserve the read/validation failure when transport cleanup also fails. */ }
    if (error === validationError) throw error;
    throw new Error("Approved rule-set response read failed", { cause: error });
  } finally {
    reader?.releaseLock();
  }
}
