import http from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { Client } from "ssh2";
import WebSocket, { WebSocketServer } from "ws";
import type { ControlMessage, ManagedConnection, ConnectionsSseSummary } from "./types";
import fs from "node:fs/promises";
import path from "node:path";

const PORT = Number(process.env.PORT ?? 8080);
const BASE_PATH = normalizeBasePath(process.env.BASE_PATH ?? "");
const DEFAULT_IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS ?? 600000);
const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS ?? 30000);
const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS ?? 100);
const SSE_HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS ?? 15000);

const STATIC_ROOT = path.resolve(process.cwd(), "examples");
const OPENAPI_ROOT = path.resolve(process.cwd(), "openapi");

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "*").split(",").map(s => s.trim()).filter(Boolean);

function normalizeBasePath(p: string) {
  if (!p) return "";
  if (!p.startsWith("/")) p = "/" + p;
  if (p.endsWith("/")) p = p.slice(0, -1);
  return p;
}
function withBase(pathname: string) { return `${BASE_PATH}${pathname}`; }
const now = () => Date.now();

const connections = new Map<string, ManagedConnection>();
let connectionsVersion = 0;

// SSE clients
const sseClients = new Set<http.ServerResponse>();
let sseSeq = 0;

function corsHeaders(req?: http.IncomingMessage) {
  const origin = req?.headers.origin;
  if (!origin) return {};
  if (ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin)) {
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "content-type, authorization",
      "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    };
  }
  return {};
}

function send(res: http.ServerResponse, status: number, headers: Record<string, string>, body?: Buffer) {
  res.writeHead(status, { ...headers, ...corsHeaders(res.req) });
  res.end(body);
}
function sendJson(res: http.ServerResponse, status: number, obj: any) {
  const data = Buffer.from(JSON.stringify(obj));
  send(res, status, {"content-type":"application/json; charset=utf-8","content-length": String(data.length)}, data);
}
function parseJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); }
    });
  });
}
function safeCloseWs(ws: WebSocket, code = 1000, reason = "") { try { ws.close(code, reason); } catch {} }

function touch(conn: ManagedConnection) { conn.lastActivityAt = now(); }

function computeCounts() {
  const counts = { total: 0, ready: 0, connecting: 0, error: 0, closed: 0 };
  for (const c of connections.values()) {
    counts.total++;
    if (c.state === "ready") counts.ready++;
    else if (c.state === "connecting") counts.connecting++;
    else if (c.state === "error") counts.error++;
    else counts.closed++;
  }
  return counts;
}
function bumpAndNotify(reason: ConnectionsSseSummary["reason"], changedIds?: string[]) {
  connectionsVersion++;
  const summary: ConnectionsSseSummary = { version: connectionsVersion, ts: now(), reason, changedIds, counts: computeCounts() };
  for (const res of sseClients) sseSend(res, "connections", summary);
}

function connectionsSnapshot() {
  return {
    version: connectionsVersion,
    ts: now(),
    connections: [...connections.values()].map((c) => ({
      id: c.id,
      state: c.state,
      createdAt: c.createdAt,
      lastActivityAt: c.lastActivityAt,
      idleTimeoutMs: c.idleTimeoutMs,
      attachedClients: [...c.clients].filter((w) => w.readyState === WebSocket.OPEN).length,
      meta: c.meta,
    })),
  };
}

function sseWrite(res: http.ServerResponse, chunk: string) { try { res.write(chunk); } catch {} }
function sseSend(res: http.ServerResponse, event: string, data: any) {
  const id = String(++sseSeq);
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  const rawLines = payload.split("\n");
  const lines = rawLines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  sseWrite(res, `id: ${id}\n`);
  sseWrite(res, `event: ${event}\n`);
  for (const line of lines) sseWrite(res, `data: ${line}\n`);
  sseWrite(res, "\n");
}

function handleSse(req: http.IncomingMessage, res: http.ServerResponse) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
    "x-accel-buffering": "no",
    ...corsHeaders(req),
  });
  sseWrite(res, ": connected\n\n");
  sseClients.add(res);
  // initial summary
  sseSend(res, "connections", { version: connectionsVersion, ts: now(), reason: "state", counts: computeCounts() });
  const hb = setInterval(() => { sseWrite(res, ": hb\n\n"); }, SSE_HEARTBEAT_MS);
  const cleanup = () => { clearInterval(hb); sseClients.delete(res); };
  req.on("close", cleanup);
  req.on("end", cleanup);
}

function tryParseControlMessage(data: unknown): ControlMessage | null {
  if (typeof data === "string") {
    const s = data.trim();
    if (s.startsWith("{") && s.endsWith("}")) {
      try {
        const obj = JSON.parse(s);
        if (obj && typeof obj.type === "string") return obj as ControlMessage;
      } catch {}
    }
  }
  return null;
}

function applyResize(conn: ManagedConnection, cols: number, rows: number) {
  conn.cols = cols;
  conn.rows = rows;
  try { (conn.shell as any)?.setWindow?.(rows, cols, 0, 0); } catch {}
  bumpAndNotify("resize", [conn.id]);
}

function attachWebSocket(ws: WebSocket, conn: ManagedConnection, readOnly: boolean) {
  if (conn.state !== "ready" || !conn.shell) { safeCloseWs(ws, 1011, "Connection not ready"); return; }
  conn.clients.add(ws);
  touch(conn);
  bumpAndNotify("ws-attached", [conn.id]);
  try { ws.send(Buffer.from("\r\n[attached]\r\n")); } catch {}
  ws.on("message", (data: WebSocket.RawData) => {
    touch(conn);
    if (readOnly) return;
    const ctrl = tryParseControlMessage(data);
    if (ctrl) {
      if (ctrl.type === "resize") { if (Number.isFinite(ctrl.cols) && Number.isFinite(ctrl.rows)) applyResize(conn, Number(ctrl.cols), Number(ctrl.rows)); return; }
      if (ctrl.type === "stdin") { conn.shell!.write(String(ctrl.data ?? "")); return; }
      if (ctrl.type === "ping") { try { ws.send(JSON.stringify({ type: "pong" })); } catch {} return; }
      if (ctrl.type === "detach") { safeCloseWs(ws, 1000, "Detached"); return; }
    }
    if (typeof data === "string") conn.shell!.write(data); else conn.shell!.write(data as Buffer);
  });
  const cleanup = () => { conn.clients.delete(ws); touch(conn); bumpAndNotify("ws-detached", [conn.id]); };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
}

function terminateConnection(conn: ManagedConnection, why: string, reason: ConnectionsSseSummary["reason"]) {
  conn.state = "closed";
  for (const ws of conn.clients) safeCloseWs(ws, 1001, why);
  conn.clients.clear();
  try { conn.shell?.close?.(); } catch {}
  try { conn.ssh.end(); } catch {}
  connections.delete(conn.id);
  bumpAndNotify(reason, [conn.id]);
}

async function createConnection(params: { host: string; port?: number; username: string; password: string; cols?: number; rows?: number; idleTimeoutMs?: number; }) {
  if (connections.size >= MAX_CONNECTIONS) throw new Error("MAX_CONNECTIONS exceeded");
  const id = randomUUID();
  const ssh = new Client();
  const conn: ManagedConnection = {
    id, state: "connecting", createdAt: now(), lastActivityAt: now(),
    ssh, shell: undefined, clients: new Set(),
    cols: params.cols ?? 120, rows: params.rows ?? 30,
    idleTimeoutMs: Number.isFinite(params.idleTimeoutMs as number) ? Number(params.idleTimeoutMs) : DEFAULT_IDLE_TIMEOUT_MS,
    meta: { host: params.host, port: params.port ?? 22, username: params.username },
  };
  connections.set(id, conn);
  bumpAndNotify("created", [id]);
  await new Promise<void>((resolve, reject) => {
    ssh.on("ready", resolve);
    ssh.on("error", reject);
    ssh.on("close", () => { conn.state = "closed"; for (const w of conn.clients) safeCloseWs(w, 1011, "SSH closed"); conn.clients.clear(); bumpAndNotify("state", [id]); });
    ssh.connect({ host: params.host, port: params.port ?? 22, username: params.username, password: params.password, keepaliveInterval: 15000, keepaliveCountMax: 3, readyTimeout: 20000 });
  });
  await new Promise<void>((resolve, reject) => {
    ssh.shell({ term: "xterm-256color", cols: conn.cols, rows: conn.rows }, (err, stream) => {
      if (err) return reject(err);
      conn.shell = stream; conn.state = "ready"; touch(conn); bumpAndNotify("state", [id]);
      stream.on("data", (chunk: Buffer) => { touch(conn); for (const w of conn.clients) { if (w.readyState === WebSocket.OPEN) { try { w.send(chunk); } catch {} } } });
      stream.on("close", () => { conn.state = "closed"; for (const w of conn.clients) safeCloseWs(w, 1011, "Shell closed"); conn.clients.clear(); bumpAndNotify("state", [id]); });
      stream.on("error", () => { conn.state = "error"; for (const w of conn.clients) safeCloseWs(w, 1011, "Shell error"); conn.clients.clear(); bumpAndNotify("state", [id]); });
      resolve();
    });
  });
  return conn;
}

async function serveFile(res: http.ServerResponse, filePath: string, contentType: string) {
  const data = await fs.readFile(filePath);
  send(res, 200, {"content-type": contentType, "content-length": String(data.length), "cache-control": "no-store"}, data);
}
function guessContentType(p: string) {
  if (p.endsWith(".html")) return "text/html; charset=utf-8";
  if (p.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (p.endsWith(".css")) return "text/css; charset=utf-8";
  if (p.endsWith(".yaml") || p.endsWith(".yml")) return "application/yaml; charset=utf-8";
  return "application/octet-stream";
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const method = req.method ?? "GET";
    if (method === "OPTIONS") { res.writeHead(204, corsHeaders(req)); res.end(); return; }

    if (method === "GET" && url.pathname === "/") { await serveFile(res, path.join(STATIC_ROOT, "index.html"), "text/html; charset=utf-8"); return; }
    if (method === "GET" && url.pathname.startsWith("/examples/")) {
      const rel = url.pathname.slice("/examples/".length);
      const safe = path.normalize(rel).replace(/^\.\.(\/|\\\\)/, "");
      const p = path.join(STATIC_ROOT, safe);
      await serveFile(res, p, guessContentType(p)); return;
    }
    if (method === "GET" && url.pathname === "/openapi.yaml") { await serveFile(res, path.join(OPENAPI_ROOT, "openapi.yaml"), "application/yaml; charset=utf-8"); return; }
    if (method === "GET" && url.pathname === "/openapi") { send(res, 302, { location: "/openapi.yaml" }); return; }

    if (method === "GET" && url.pathname === withBase("/healthz")) { sendJson(res, 200, { ok: true, ts: now() }); return; }
    if (method === "GET" && url.pathname === withBase("/connections/stream")) { handleSse(req, res); return; }

    if (method === "POST" && url.pathname === withBase("/connections")) {
      const body = await parseJsonBody(req);
      if (!body.host || !body.username || !body.password) { sendJson(res, 400, { error: "host, username, password are required" }); return; }
      const conn = await createConnection({ host: String(body.host), port: body.port ? Number(body.port) : undefined, username: String(body.username), password: String(body.password), cols: body.cols ? Number(body.cols) : undefined, rows: body.rows ? Number(body.rows) : undefined, idleTimeoutMs: body.idleTimeoutMs ? Number(body.idleTimeoutMs) : undefined });
      sendJson(res, 201, { id: conn.id, state: conn.state, createdAt: conn.createdAt, lastActivityAt: conn.lastActivityAt, idleTimeoutMs: conn.idleTimeoutMs, wsPath: withBase(`/ws/${conn.id}`), meta: conn.meta });
      return;
    }

    if (method === "GET" && url.pathname === withBase("/connections")) { sendJson(res, 200, connectionsSnapshot()); return; }

    if (method === "DELETE" && url.pathname.startsWith(withBase("/connections/"))) {
      const id = url.pathname.slice(withBase("/connections/").length).split("/")[0];
      const conn = connections.get(id);
      if (!conn) { sendJson(res, 404, { error: "Not Found" }); return; }
      terminateConnection(conn, "Deleted", "deleted");
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && url.pathname.startsWith(withBase("/connections/")) && url.pathname.endsWith("/resize")) {
      const parts = url.pathname.split("/");
      const id = parts[parts.length - 2];
      const conn = connections.get(id);
      if (!conn || !conn.shell) { sendJson(res, 404, { error: "Not Found" }); return; }
      const body = await parseJsonBody(req);
      const cols = Number(body.cols); const rows = Number(body.rows);
      if (!Number.isFinite(cols) || !Number.isFinite(rows)) { sendJson(res, 400, { error: "cols and rows must be numbers" }); return; }
      applyResize(conn, cols, rows);
      sendJson(res, 200, { ok: true, cols, rows });
      return;
    }

    sendJson(res, 404, { error: "Not Found" });
  } catch (e: any) {
    sendJson(res, 500, { error: "Internal Server Error", detail: String(e?.message ?? e) });
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (!url.pathname.startsWith(withBase("/ws/"))) { socket.destroy(); return; }
    const id = url.pathname.slice(withBase("/ws/").length).split("/")[0];
    const conn = connections.get(id);
    if (!conn) { socket.destroy(); return; }
    const readOnly = url.searchParams.get("readOnly") === "1";
    wss.handleUpgrade(req, socket, head, (ws) => { attachWebSocket(ws, conn, readOnly); });
  } catch { socket.destroy(); }
});

setInterval(() => {
  const t = now();
  for (const conn of connections.values()) {
    const activeClients = [...conn.clients].some((ws) => ws.readyState === WebSocket.OPEN);
    const idleFor = t - conn.lastActivityAt;
    if (!activeClients && idleFor > conn.idleTimeoutMs) {
      terminateConnection(conn, `Idle timeout (${conn.idleTimeoutMs}ms)`, "idle-timeout");
    }
  }
}, SWEEP_INTERVAL_MS).unref();

server.listen(PORT, () => {
  console.log(`ws-ssh-proxy listening on :${PORT}`);
  console.log(`BASE_PATH=${BASE_PATH || "(empty)"}`);
  console.log(`demo: http://localhost:${PORT}/`);
  console.log(`openapi: http://localhost:${PORT}/openapi.yaml`);
  console.log(`connections SSE: ${withBase("/connections/stream")}`);
});
