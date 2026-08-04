interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface D1Result<T = unknown> {
  success: boolean;
  results: T[];
  meta: Record<string, unknown>;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<Array<D1Result<T>>>;
}

interface KVValueWithMetadata<Value, Metadata> {
  value: Value | null;
  metadata: Metadata | null;
}

interface KVNamespace {
  get(key: string): Promise<string | null>;
  get<Value>(key: string, type: "json"): Promise<Value | null>;
  get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
  getWithMetadata<Metadata>(
    key: string,
    type: "arrayBuffer",
  ): Promise<KVValueWithMetadata<ArrayBuffer, Metadata>>;
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream | string,
    options?: {
      metadata?: Record<string, unknown>;
      expirationTtl?: number;
    },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  deleteAll(): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
}

interface DurableObjectState {
  storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  acceptWebSocket(socket: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
}

interface DurableObjectId {
  toString(): string;
}

interface DurableObjectStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

// Workers add hibernation helpers on top of the standard WebSocket, and allow a
// socket to be handed back to the client through a 101 response.
interface WebSocket {
  accept(): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

interface ResponseInit {
  webSocket?: WebSocket | null;
}

declare const WebSocketPair: {
  new (): { 0: WebSocket; 1: WebSocket };
};

declare module "cloudflare:workers" {
  export const env: {
    MEMORY_IMAGES?: KVNamespace;
    MEMORY_ROOM?: DurableObjectNamespace;
    STATS?: D1Database;
    UPLOAD_PASSWORD?: string;
    [key: string]: unknown;
  };

  export class DurableObject<Env = unknown> {
    constructor(ctx: DurableObjectState, env: Env);
    protected ctx: DurableObjectState;
    protected env: Env;
  }
}
