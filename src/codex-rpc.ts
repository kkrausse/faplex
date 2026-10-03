// JSON-RPC to the shared Codex app-server daemon. Its control socket speaks WebSocket over a
// Unix socket, which Bun's WebSocket cannot dial, so this frames RFC 6455 by hand.
import type { Socket } from "bun";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class CodexRpc {
  private sock?: Socket<undefined>;
  private buf = new Uint8Array(0);
  private upgraded = false;
  private frag: Uint8Array[] = [];
  private nextId = 1;
  private pending = new Map<number, Pending>();
  onNotification: (method: string, params: any) => void = () => {};
  onClose: () => void = () => {};

  async connect(path: string): Promise<void> {
    let opened!: () => void, failed!: (e: Error) => void;
    const ready = new Promise<void>((res, rej) => ((opened = res), (failed = rej)));
    this.sock = await Bun.connect({
      unix: path,
      socket: {
        data: (_s, d) => {
          this.buf = concat(this.buf, d);
          if (!this.upgraded) {
            const end = indexOfCrlf2(this.buf);
            if (end < 0) return;
            const head = new TextDecoder().decode(this.buf.subarray(0, end));
            this.buf = this.buf.subarray(end + 4);
            if (!head.startsWith("HTTP/1.1 101")) return failed(new Error(`codex upgrade: ${head.split("\r\n")[0]}`));
            this.upgraded = true;
            opened();
          }
          this.drain();
        },
        close: () => {
          for (const p of this.pending.values()) p.reject(new Error("codex socket closed"));
          this.pending.clear();
          this.onClose();
        },
        error: (_s, e) => failed(e),
      },
    });
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
    this.sock.write(
      `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    await ready;
    await this.request("initialize", { clientInfo: { name: "faplex", title: null, version: "0" }, capabilities: null });
    this.notify("initialized");
  }

  close() {
    this.sock?.end();
  }

  request<T = any>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params?: unknown) {
    this.send(params === undefined ? { method } : { method, params });
  }

  private send(msg: unknown) {
    this.writeFrame(0x1, new TextEncoder().encode(JSON.stringify(msg)));
  }

  private writeFrame(opcode: number, payload: Uint8Array) {
    const n = payload.length;
    const head = n < 126 ? 2 : n < 65536 ? 4 : 10;
    const out = new Uint8Array(head + 4 + n);
    out[0] = 0x80 | opcode;
    if (n < 126) out[1] = 0x80 | n;
    else if (n < 65536) (out[1] = 0x80 | 126), new DataView(out.buffer).setUint16(2, n);
    else (out[1] = 0x80 | 127), new DataView(out.buffer).setBigUint64(2, BigInt(n));
    const mask = crypto.getRandomValues(new Uint8Array(4));
    out.set(mask, head);
    for (let i = 0; i < n; i++) out[head + 4 + i] = payload[i]! ^ mask[i & 3]!;
    this.sock!.write(out);
  }

  // Server frames are unmasked; text messages may arrive fragmented.
  private drain() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      let len = b[1]! & 0x7f, off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        (len = (b[2]! << 8) | b[3]!), (off = 4);
      } else if (len === 127) {
        if (b.length < 10) return;
        (len = Number(new DataView(b.buffer, b.byteOffset).getBigUint64(2))), (off = 10);
      }
      if (b.length < off + len) return;
      const fin = (b[0]! & 0x80) !== 0, opcode = b[0]! & 0x0f;
      const payload = b.slice(off, off + len);
      this.buf = b.subarray(off + len);
      if (opcode === 0x9) this.writeFrame(0xa, payload);
      else if (opcode === 0x8) this.sock?.end();
      else if (opcode === 0x1 || opcode === 0x0) {
        this.frag.push(payload);
        if (fin) {
          const text = new TextDecoder().decode(this.frag.reduce(concat));
          this.frag = [];
          this.dispatch(JSON.parse(text));
        }
      }
    }
  }

  private dispatch(msg: any) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    } else if (msg.method && msg.id === undefined) this.onNotification(msg.method, msg.params);
  }
}

const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

const indexOfCrlf2 = (b: Uint8Array) => {
  for (let i = 0; i + 3 < b.length; i++) if (b[i] === 13 && b[i + 1] === 10 && b[i + 2] === 13 && b[i + 3] === 10) return i;
  return -1;
};
