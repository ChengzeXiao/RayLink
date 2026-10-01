import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { connect } from "node:http2";
import { promisify } from "node:util";

const SERVICE_PATH = "/v2ray.core.app.stats.command.StatsService/QueryStats";
const execFile = promisify(execFileCallback);

function encodeVarint(value) {
  let remaining = BigInt(value);
  const bytes = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return Buffer.from(bytes);
}

function readVarint(buffer, offset) {
  let value = 0n;
  let shift = 0n;
  let cursor = offset;
  while (cursor < buffer.length) {
    const byte = buffer[cursor];
    value |= BigInt(byte & 0x7f) << shift;
    cursor += 1;
    if ((byte & 0x80) === 0) return { value, offset: cursor };
    shift += 7n;
    if (shift > 63n) throw new Error("V2Ray Stats protobuf varint 过长");
  }
  throw new Error("V2Ray Stats protobuf varint 不完整");
}

function skipField(buffer, offset, wireType) {
  if (wireType === 0) return readVarint(buffer, offset).offset;
  if (wireType === 1) return offset + 8;
  if (wireType === 5) return offset + 4;
  if (wireType === 2) {
    const length = readVarint(buffer, offset);
    return length.offset + Number(length.value);
  }
  throw new Error(`V2Ray Stats protobuf wire type ${wireType} 不受支持`);
}

function decodeStat(buffer) {
  let offset = 0;
  let name = "";
  let value = 0;
  while (offset < buffer.length) {
    const key = readVarint(buffer, offset);
    offset = key.offset;
    const field = Number(key.value >> 3n);
    const wireType = Number(key.value & 0x7n);
    if (field === 1 && wireType === 2) {
      const length = readVarint(buffer, offset);
      const start = length.offset;
      const end = start + Number(length.value);
      name = buffer.subarray(start, end).toString("utf8");
      offset = end;
    } else if (field === 2 && wireType === 0) {
      const decoded = readVarint(buffer, offset);
      if (decoded.value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("V2Ray Stats 计数超过安全整数范围");
      }
      value = Number(decoded.value);
      offset = decoded.offset;
    } else {
      offset = skipField(buffer, offset, wireType);
    }
  }
  return { name, value };
}

function decodeQueryStatsResponse(buffer) {
  const stats = [];
  let offset = 0;
  while (offset < buffer.length) {
    const key = readVarint(buffer, offset);
    offset = key.offset;
    const field = Number(key.value >> 3n);
    const wireType = Number(key.value & 0x7n);
    if (field === 1 && wireType === 2) {
      const length = readVarint(buffer, offset);
      const start = length.offset;
      const end = start + Number(length.value);
      stats.push(decodeStat(buffer.subarray(start, end)));
      offset = end;
    } else {
      offset = skipField(buffer, offset, wireType);
    }
  }
  return stats;
}

function queryPayload() {
  const pattern = Buffer.from("user>>>", "utf8");
  return Buffer.concat([
    Buffer.from([0x1a]),
    encodeVarint(pattern.length),
    pattern
  ]);
}

export async function queryV2RayUserStats(options = {}) {
  const endpoint = new URL(options.endpoint || "http://127.0.0.1:10085");
  const timeoutMs = Math.max(100, Number(options.timeoutMs || 5_000));
  const session = connect(endpoint.origin);
  let timeoutHandle;
  return new Promise((resolve, reject) => {
    session.on("error", reject);
    timeoutHandle = setTimeout(() => {
      session.destroy();
      reject(new Error("V2Ray Stats 查询超时"));
    }, timeoutMs);
    const chunks = [];
    let grpcStatus = "0";
    const request = session.request({
      ":method": "POST",
      ":path": SERVICE_PATH,
      "content-type": "application/grpc",
      te: "trailers"
    });
    request.on("response", (headers) => {
      if (Number(headers[":status"]) !== 200) {
        reject(new Error(`V2Ray Stats HTTP ${headers[":status"]}`));
      }
      if (headers["grpc-status"] !== undefined) {
        grpcStatus = String(headers["grpc-status"]);
      }
    });
    request.on("trailers", (headers) => {
      grpcStatus = String(headers["grpc-status"] || "0");
    });
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("error", reject);
    request.on("end", () => {
      clearTimeout(timeoutHandle);
      session.close();
      if (grpcStatus !== "0") {
        reject(new Error(`V2Ray Stats gRPC ${grpcStatus}`));
        return;
      }
      try {
        const body = Buffer.concat(chunks);
        const stats = [];
        let offset = 0;
        while (offset + 5 <= body.length) {
          if (body[offset] !== 0) throw new Error("V2Ray Stats 压缩响应不受支持");
          const length = body.readUInt32BE(offset + 1);
          const start = offset + 5;
          const end = start + length;
          if (end > body.length) throw new Error("V2Ray Stats gRPC 帧不完整");
          stats.push(...decodeQueryStatsResponse(body.subarray(start, end)));
          offset = end;
        }
        resolve(stats);
      } catch (error) {
        reject(error);
      }
    });
    const payload = queryPayload();
    const frame = Buffer.alloc(5);
    frame.writeUInt32BE(payload.length, 1);
    request.end(Buffer.concat([frame, payload]));
  }).finally(() => {
    clearTimeout(timeoutHandle);
    session.close();
  });
}

export function normalizeV2RayUserStats(stats) {
  const users = new Map();
  for (const stat of stats || []) {
    const match = String(stat.name || "").match(/^user>>>(.+)>>>traffic>>>(uplink|downlink)$/);
    if (!match || !Number.isSafeInteger(stat.value) || stat.value < 0) continue;
    const current = users.get(match[1]) || {
      name: match[1],
      uplinkBytes: 0,
      downlinkBytes: 0
    };
    current[match[2] === "uplink" ? "uplinkBytes" : "downlinkBytes"] = stat.value;
    users.set(match[1], current);
  }
  return [...users.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export class V2RayStatsCollector {
  constructor(options = {}) {
    this.query = options.query || (() => queryV2RayUserStats(options));
    this.runtimeInstanceProvider = options.runtimeInstanceProvider || (() => "local-runtime");
    this.clock = options.clock || (() => new Date());
    this.sampleId = options.sampleId || randomUUID;
  }

  async collect() {
    const runtimeInstanceId = String(await this.runtimeInstanceProvider());
    const users = normalizeV2RayUserStats(await this.query());
    if (String(await this.runtimeInstanceProvider()) !== runtimeInstanceId) {
      throw new Error("采样期间 Runtime 实例发生变化，等待下一轮重新采样");
    }
    return {
      sampleId: this.sampleId(),
      runtimeInstanceId,
      observedAt: this.clock().toISOString(),
      users
    };
  }
}

export async function systemdRuntimeInstanceId(
  systemdUnit = "raylink-sing-box.service",
  runner = execFile
) {
  const { stdout } = await runner("systemctl", [
    "show",
    systemdUnit,
    "--property=InvocationID",
    "--value"
  ], { timeout: 5_000 });
  const invocationId = String(stdout || "").trim();
  if (!/^[a-f0-9]{16,64}$/i.test(invocationId)) {
    throw new Error("无法读取 sing-box Runtime InvocationID");
  }
  return invocationId;
}
