import type { Notification } from "@notify/shared";
import type { NotificationRow } from "./notification-row";

export function toNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    userId: row.user_id,
    channel: row.channel,
    title: row.title,
    body: row.body,
    createdAt: row.created_at.toISOString(),
    sentAt: row.sent_at ? row.sent_at.toISOString() : null,
    readAt: row.read_at ? row.read_at.toISOString() : null,
  };
}
