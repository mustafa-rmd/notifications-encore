import { api, APIError } from "encore.dev/api";
import type {
  ListNotificationsResponse,
  Notification,
  NotificationIdPath,
  SendRequest,
} from "@notify/shared";
import { db } from "../../db";
import type { NotificationRow } from "../shared/notification-row";
import { toNotification } from "../shared/mapper";
import { fanOut } from "../stream/stream";
import type { ListRequest } from "./list-request";

const DEFAULT_SIZE = 50;
const MAX_SIZE = 100;

function resolveSize(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_SIZE;
  if (!Number.isInteger(raw) || raw < 1 || raw > MAX_SIZE) {
    throw APIError.invalidArgument(
      `size must be an integer between 1 and ${MAX_SIZE}`,
    );
  }
  return raw;
}

function resolvePage(raw: number | undefined): number {
  if (raw === undefined) return 1;
  if (!Number.isInteger(raw) || raw < 1) {
    throw APIError.invalidArgument("page must be an integer >= 1");
  }
  return raw;
}

export const send = api(
  { method: "POST", path: "/notifications", expose: true },
  async (req: SendRequest): Promise<Notification> => {
    if (req.channel !== "in_app" && req.channel !== "email") {
      throw APIError.invalidArgument("channel must be 'in_app' or 'email'");
    }
    const title = req.title?.trim();
    const body = req.body?.trim();
    if (!title) throw APIError.invalidArgument("title is required");
    if (!body) throw APIError.invalidArgument("body is required");

    const user = await db.queryRow<{ id: string; email: string | null }>`
      SELECT id, email FROM users WHERE id = ${req.userId}
    `;
    if (!user) throw APIError.notFound("user not found");

    if (req.channel === "email" && !user.email) {
      throw APIError.invalidArgument("user has no email address on file");
    }

    // in_app is delivered synchronously; email is queued for the outbox worker
    // (see ../outbox/outbox.ts), which sets sent_at + delivery_status='sent' on success.
    const isInApp = req.channel === "in_app";
    const deliveryStatus = isInApp ? "sent" : "pending";
    const sentAt = isInApp ? new Date() : null;

    const row = await db.queryRow<NotificationRow>`
      INSERT INTO notifications (user_id, channel, title, body, delivery_status, sent_at)
      VALUES (${req.userId}, ${req.channel}, ${title}, ${body}, ${deliveryStatus}, ${sentAt})
      RETURNING id, user_id, channel, title, body, created_at, sent_at, read_at
    `;
    if (!row) throw APIError.internal("failed to insert notification");
    const notification = toNotification(row);
    fanOut(notification);
    return notification;
  },
);

export const listForUser = api(
  { method: "GET", path: "/users/:userId/notifications", expose: true },
  async ({
    userId,
    page,
    size,
  }: ListRequest): Promise<ListNotificationsResponse> => {
    const sz = resolveSize(size);
    const pg = resolvePage(page);
    const offset = (pg - 1) * sz;

    const countRow = await db.queryRow<{ total: number }>`
      SELECT COUNT(*)::int AS total FROM notifications WHERE user_id = ${userId}
    `;
    const total = countRow?.total ?? 0;

    const rows: NotificationRow[] = [];
    for await (const row of db.query<NotificationRow>`
      SELECT id, user_id, channel, title, body, created_at, sent_at, read_at
      FROM notifications
      WHERE user_id = ${userId}
      ORDER BY created_at DESC, id DESC
      LIMIT ${sz} OFFSET ${offset}
    `) {
      rows.push(row);
    }
    return {
      notifications: rows.map(toNotification),
      page: pg,
      size: sz,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / sz),
    };
  },
);

export const listUnreadForUser = api(
  { method: "GET", path: "/users/:userId/notifications/unread", expose: true },
  async ({
    userId,
    page,
    size,
  }: ListRequest): Promise<ListNotificationsResponse> => {
    const sz = resolveSize(size);
    const pg = resolvePage(page);
    const offset = (pg - 1) * sz;

    const countRow = await db.queryRow<{ total: number }>`
      SELECT COUNT(*)::int AS total
      FROM notifications
      WHERE user_id = ${userId} AND read_at IS NULL
    `;
    const total = countRow?.total ?? 0;

    const rows: NotificationRow[] = [];
    for await (const row of db.query<NotificationRow>`
      SELECT id, user_id, channel, title, body, created_at, sent_at, read_at
      FROM notifications
      WHERE user_id = ${userId} AND read_at IS NULL
      ORDER BY created_at DESC, id DESC
      LIMIT ${sz} OFFSET ${offset}
    `) {
      rows.push(row);
    }
    return {
      notifications: rows.map(toNotification),
      page: pg,
      size: sz,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / sz),
    };
  },
);

export const markRead = api(
  { method: "POST", path: "/notifications/:id/read", expose: true },
  async ({ id }: NotificationIdPath): Promise<Notification> => {
    const row = await db.queryRow<NotificationRow>`
      UPDATE notifications
      SET read_at = COALESCE(read_at, now())
      WHERE id = ${id}
      RETURNING id, user_id, channel, title, body, created_at, sent_at, read_at
    `;
    if (!row) throw APIError.notFound("notification not found");
    return toNotification(row);
  },
);
