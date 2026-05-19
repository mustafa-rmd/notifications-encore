import { api, APIError } from "encore.dev/api";
import type { StreamOut } from "encore.dev/api";
import type { Channel, Notification, StreamEvent } from "@notify/shared";
import { db } from "../../db";
import type { NotificationRow } from "../shared/notification-row";
import { toNotification } from "../shared/mapper";
import type { Handshake } from "./handshake";

interface Subscriber {
  stream: StreamOut<StreamEvent>;
  // null = subscribe to all channels; otherwise only this channel fires fanOut.
  channel: Channel | null;
}

const subscribers = new Map<string, Set<Subscriber>>();

export function fanOut(notification: Notification): void {
  const set = subscribers.get(notification.userId);
  if (!set || set.size === 0) return;
  const event: StreamEvent = { type: "notification", data: notification };
  for (const sub of [...set]) {
    if (sub.channel !== null && sub.channel !== notification.channel) continue;
    try {
      sub.stream.send(event);
    } catch {
      set.delete(sub);
      if (set.size === 0) subscribers.delete(notification.userId);
    }
  }
}

export const stream = api.streamOut<Handshake, StreamEvent>(
  { path: "/users/:userId/notifications/stream", expose: true },
  async ({ userId, channel }, stream) => {
    if (channel !== undefined && channel !== "in_app" && channel !== "email") {
      throw APIError.invalidArgument(
        "channel must be 'in_app' or 'email' if provided",
      );
    }
    const sub: Subscriber = { stream, channel: channel ?? null };
    let set = subscribers.get(userId);
    if (!set) {
      set = new Set();
      subscribers.set(userId, set);
    }
    // Register the subscriber BEFORE the backlog query so a notification
    // committed mid-replay isn't lost — it'll be delivered live via fanOut
    // (and possibly also via backlog, so clients must dedupe by id).
    set.add(sub);

    try {
      const backlog = channel
        ? db.query<NotificationRow>`
            SELECT id, user_id, channel, title, body, created_at, sent_at, read_at
            FROM notifications
            WHERE user_id = ${userId}
              AND read_at IS NULL
              AND channel = ${channel}
            ORDER BY created_at ASC, id ASC
          `
        : db.query<NotificationRow>`
            SELECT id, user_id, channel, title, body, created_at, sent_at, read_at
            FROM notifications
            WHERE user_id = ${userId}
              AND read_at IS NULL
            ORDER BY created_at ASC, id ASC
          `;
      for await (const row of backlog) {
        if (!set.has(sub)) break; // client disconnected mid-replay
        await stream.send({
          type: "notification",
          data: toNotification(row),
        });
      }
    } catch {
      // Backlog failure shouldn't kill the live stream — fall through to the
      // ping loop; clients can still recover via REST list if needed.
    }

    try {
      while (set.has(sub)) {
        await new Promise((r) => setTimeout(r, 30_000));
        if (!set.has(sub)) break;
        await stream.send({ type: "ping" });
      }
    } catch {
      // client disconnected — fall through to cleanup
    } finally {
      set.delete(sub);
      if (set.size === 0) subscribers.delete(userId);
    }
  },
);
