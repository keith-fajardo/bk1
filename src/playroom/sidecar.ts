import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import type {
  PlayroomMethod,
  PlayroomEvent,
  PlayroomEventName,
  InitResult,
  CreateResult,
  JoinResult,
  LeaveResult,
  SendResult,
} from './protocol';

// Lazy-spawned long-lived child process. Speaks newline-delimited JSON
// over stdin/stdout. Each request gets an id; responses match by id;
// events have no id and fan out via listeners.

const BINARY_PATH = join(homedir(), '.bk1', 'bk1-playroom');

type Pending = {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
};

type EventListener = (data: any) => void;

export class PlayroomSidecar {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private pending = new Map<string, Pending>();
  private listeners = new Map<PlayroomEventName, Set<EventListener>>();
  private nextId = 1;
  private readBuf = '';
  private exited = false;

  static binaryAvailable(): boolean {
    return existsSync(BINARY_PATH);
  }

  async start(): Promise<void> {
    if (this.proc) return;
    if (!PlayroomSidecar.binaryAvailable()) {
      throw new Error(
        `bk1-playroom not found at ${BINARY_PATH}. Run "bun run build:playroom" or "bun run setup".`,
      );
    }
    this.proc = Bun.spawn([BINARY_PATH], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    this.consumeStdout();
    this.proc.exited.then(() => {
      this.exited = true;
      const err = new Error('bk1-playroom sidecar exited');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
  }

  // Methods ──────────────────────────────────────────────────────────────────
  init(): Promise<InitResult> { return this.request('init'); }
  create(): Promise<CreateResult> { return this.request('create'); }
  join(address: string): Promise<JoinResult> { return this.request('join', { address }); }
  leave(): Promise<LeaveResult> { return this.request('leave'); }
  send(data: string): Promise<SendResult> { return this.request('send', { data }); }

  // Event subscription ───────────────────────────────────────────────────────
  on<N extends PlayroomEventName>(
    name: N,
    fn: (data: Extract<PlayroomEvent, { name: N }>['data']) => void,
  ): () => void {
    let set = this.listeners.get(name);
    if (!set) { set = new Set(); this.listeners.set(name, set); }
    set.add(fn as EventListener);
    return () => { set!.delete(fn as EventListener); };
  }

  async close(): Promise<void> {
    if (!this.proc) return;
    try { this.proc.kill(); } catch {}
    await this.proc.exited;
    this.proc = null;
  }

  // Internals ────────────────────────────────────────────────────────────────
  private async request(method: PlayroomMethod, params?: Record<string, unknown>): Promise<any> {
    if (!this.proc || this.exited) throw new Error('sidecar not running');
    const id = String(this.nextId++);
    const envelope = { id, type: 'request', method, params: params ?? {} };
    const line = JSON.stringify(envelope) + '\n';
    const writer = this.proc.stdin as any;
    if (typeof writer.write === 'function') {
      writer.write(line);
      if (typeof writer.flush === 'function') writer.flush();
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  private async consumeStdout(): Promise<void> {
    if (!this.proc) return;
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      this.readBuf += decoder.decode(value, { stream: true });
      let nl = this.readBuf.indexOf('\n');
      while (nl >= 0) {
        const line = this.readBuf.slice(0, nl).trim();
        this.readBuf = this.readBuf.slice(nl + 1);
        if (line) this.handleLine(line);
        nl = this.readBuf.indexOf('\n');
      }
    }
  }

  private handleLine(line: string): void {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === 'response' && msg.id) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
      return;
    }
    if (msg.type === 'event' && msg.name) {
      const set = this.listeners.get(msg.name as PlayroomEventName);
      if (set) for (const fn of set) fn(msg.data);
    }
  }
}
