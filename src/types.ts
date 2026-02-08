import type { ClientChannel } from "ssh2";
import type { Client } from "ssh2";
import type WebSocket from "ws";

export type ConnectionState = "connecting" | "ready" | "closed" | "error";

export interface ManagedConnection {
  id: string;
  state: ConnectionState;
  createdAt: number;
  lastActivityAt: number;

  ssh: Client;
  shell?: ClientChannel;

  clients: Set<WebSocket>;

  cols: number;
  rows: number;

  idleTimeoutMs: number;

  meta: {
    host: string;
    port: number;
    username: string;
  };
}

export type ControlMessage =
  | { type: "resize"; cols: number; rows: number }
  | { type: "stdin"; data: string }
  | { type: "ping" }
  | { type: "detach" };

export type ConnectionsSseSummary = {
  version: number;
  ts: number;
  reason:
    | "created"
    | "deleted"
    | "state"
    | "ws-attached"
    | "ws-detached"
    | "resize"
    | "idle-timeout";
  changedIds?: string[];
  counts: {
    total: number;
    ready: number;
    connecting: number;
    error: number;
    closed: number;
  };
};
