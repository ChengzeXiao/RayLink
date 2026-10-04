import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const failure = (code, stage = "connect") => Object.assign(new Error(code), { code, stage });

function connectHttp(config, address, { signal, ca }) {
  const authority = `${net.isIP(address) === 6 ? `[${address}]` : address}:443`;
  return new Promise((resolve, reject) => {
    const transport = config.type === "https" ? https : http;
    const request = transport.request({ hostname: config.server, port: config.port, method: "CONNECT", path: authority,
      agent: false, signal, maxHeaderSize: 16_384, rejectUnauthorized: true, minVersion: "TLSv1.2",
      ...(config.type === "https" ? { servername: config.tlsServerName || (net.isIP(config.server) ? undefined : config.server), ...(ca ? { ca } : {}) } : {}),
      headers: { host: authority, ...(config.username ? {
        "proxy-authorization": "Basic " + Buffer.from(`${config.username}:${config.password}`).toString("base64")
      } : {}) } });
    request.once("error", reject);
    request.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(failure(response.statusCode === 407 ? "AI_UPSTREAM_AUTH" : "AI_UPSTREAM_CONNECT"));
        return;
      }
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    request.end();
  });
}

// SOCKS replies are small but can be fragmented at any byte boundary. Keep a
// bounded reader until negotiation is complete, then return the untouched stream.
function socksReader(socket) {
  let buffer = Buffer.alloc(0), pending = null, ended = null;
  const pump = () => {
    if (!pending) return;
    if (ended) { const item = pending; pending = null; item.reject(ended); }
    else if (buffer.length >= pending.length) {
      const item = pending; pending = null;
      const result = buffer.subarray(0, item.length); buffer = buffer.subarray(item.length); item.resolve(result);
    }
  };
  const data = (chunk) => {
    if (buffer.length + chunk.length > 16_384) { ended = failure("AI_UPSTREAM_INVALID_REPLY"); socket.destroy(); }
    else buffer = Buffer.concat([buffer, chunk]);
    pump();
  };
  const error = (value) => { ended = value; pump(); };
  const close = () => error(failure("AI_UPSTREAM_CONNECTION_CLOSED"));
  socket.on("data", data); socket.on("error", error); socket.on("close", close);
  return {
    read(length) { return new Promise((resolve, reject) => { pending = { length, resolve, reject }; pump(); }); },
    release() {
      socket.pause(); socket.off("data", data); socket.off("error", error); socket.off("close", close);
      if (buffer.length) socket.unshift(buffer);
    }
  };
}

function addressBytes(address) {
  if (net.isIP(address) === 4) return Buffer.from([1, ...address.split(".").map(Number)]);
  const [left, right = ""] = address.split("::");
  const head = left ? left.split(":") : [], tail = right ? right.split(":") : [];
  const groups = [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];
  const bytes = Buffer.alloc(17); bytes[0] = 4;
  groups.forEach((group, index) => bytes.writeUInt16BE(parseInt(group, 16), 1 + index * 2));
  return bytes;
}

async function connectSocks(config, address, { signal }) {
  const socket = net.connect({ host: config.server, port: config.port, signal });
  const reader = socksReader(socket);
  try {
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const authenticated = Boolean(config.username);
    socket.write(Buffer.from([5, 1, authenticated ? 2 : 0]));
    const method = await reader.read(2);
    if (method[0] !== 5 || method[1] !== (authenticated ? 2 : 0)) throw failure("AI_UPSTREAM_AUTH");
    if (authenticated) {
      const username = Buffer.from(config.username), password = Buffer.from(config.password);
      socket.write(Buffer.concat([Buffer.from([1, username.length]), username, Buffer.from([password.length]), password]));
      const authentication = await reader.read(2);
      if (authentication[0] !== 1 || authentication[1] !== 0) throw failure("AI_UPSTREAM_AUTH");
    }
    socket.write(Buffer.concat([Buffer.from([5, 1, 0]), addressBytes(address), Buffer.from([1, 187])]));
    const reply = await reader.read(4);
    if (reply[0] !== 5 || reply[1] !== 0 || reply[2] !== 0) throw failure("AI_UPSTREAM_CONNECT");
    const length = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : reply[3] === 3 ? (await reader.read(1))[0] : 0;
    if (!length) throw failure("AI_UPSTREAM_INVALID_REPLY");
    await reader.read(length + 2);
    return socket;
  } catch (error) { socket.destroy(); throw error; }
  finally { reader.release(); }
}

/** Fixed-target transport. The diagnostic service validates target IPs first;
 * only the administrator-configured proxy may be private (e.g. a local tunnel).
 * `ca` is an injected trust store for isolated TLS tests, never an API setting. */
export function createAiUpstreamProbe(config, { resolve, ca } = {}) {
  return {
    resolve,
    request({ url, address, signal, onStage }) {
      return new Promise((resolveResponse, reject) => {
        let stage = "connect", incoming, settled = false;
        const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
        agent.createConnection = (_options, callback) => {
          const connect = config.type === "socks5" ? connectSocks : connectHttp;
          connect(config, address, { signal, ca }).then((socket) => {
            if (signal.aborted) { socket.destroy(); callback(failure("ABORT_ERR")); return; }
            stage = "tls"; onStage?.(stage);
            const secured = tls.connect({ socket, servername: url.hostname, rejectUnauthorized: true, minVersion: "TLSv1.2", ...(ca ? { ca } : {}) });
            secured.once("secureConnect", () => { stage = "http"; onStage?.(stage); });
            callback(null, secured);
          }, callback);
        };
        const finish = (error, result) => {
          if (settled) return;
          settled = true;
          if (error) { error.stage ||= stage; reject(error); } else resolveResponse(result);
          incoming?.destroy(); request.destroy(); agent.destroy();
        };
        const request = https.request({ hostname: url.hostname, port: 443, path: url.pathname + url.search, method: "GET",
          agent, signal, maxHeaderSize: 65_536, headers: { "user-agent": "RayLink-AI-Diagnostics/1.0", accept: "text/html,application/json", "accept-encoding": "identity", connection: "close" }
        }, (response) => {
          incoming = response; stage = "http"; onStage?.(stage);
          let size = 0; const chunks = [];
          const complete = () => finish(null, { httpStatus: response.statusCode, headers: response.headers,
            body: Buffer.concat(chunks, size).toString("utf8"), remoteAddress: null });
          response.on("data", (chunk) => {
            const part = chunk.subarray(0, 16_384 - size); chunks.push(part); size += part.length;
            if (size >= 16_384) complete();
          });
          response.once("end", complete); response.once("error", (error) => finish(error));
          response.once("aborted", () => finish(failure("ECONNRESET", "http")));
        });
        request.once("error", (error) => finish(error)); request.end();
      });
    }
  };
}
