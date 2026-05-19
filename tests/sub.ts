import type { Channel, Notification, StreamEvent } from "@notify/shared";

const API = (process.env.NOTIFY_API_URL ?? "http://127.0.0.1:4000").replace(
  /\/$/,
  "",
);
const WS_API = API.replace(/^http/, "ws");

export class Sub {
  private ws: WebSocket;
  private buffered: Notification[] = [];
  private waiters: Array<(n: Notification) => void> = [];

  constructor(userId: string, channel?: Channel) {
    const qs = channel ? `?channel=${channel}` : "";
    this.ws = new WebSocket(
      `${WS_API}/users/${userId}/notifications/stream${qs}`,
    );
    this.ws.addEventListener("message", (e) => {
      const event = JSON.parse(String(e.data)) as StreamEvent;
      if (event.type !== "notification" || !event.data) return;
      const waiter = this.waiters.shift();
      if (waiter) waiter(event.data);
      else this.buffered.push(event.data);
    });
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (e) =>
        reject(new Error(`ws error: ${(e as ErrorEvent).message ?? e}`)),
      );
    });
  }

  next(timeoutMs = 2000): Promise<Notification> {
    const head = this.buffered.shift();
    if (head) return Promise.resolve(head);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(resolver);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(
          new Error(`timed out after ${timeoutMs}ms waiting for ws message`),
        );
      }, timeoutMs);
      const resolver = (n: Notification): void => {
        clearTimeout(timer);
        resolve(n);
      };
      this.waiters.push(resolver);
    });
  }

  async expectSilence(windowMs = 400): Promise<void> {
    await new Promise((r) => setTimeout(r, windowMs));
    if (this.buffered.length > 0) {
      throw new Error(
        `expected no messages but received ${this.buffered.length}: ${JSON.stringify(
          this.buffered,
        )}`,
      );
    }
  }

  close(): void {
    this.ws.close();
  }
}
