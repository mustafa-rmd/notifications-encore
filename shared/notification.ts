import type { Channel } from "./channel";

export interface Notification {
  id: string;
  userId: string;
  channel: Channel;
  title: string;
  body: string;
  createdAt: string;
  sentAt: string | null;
  readAt: string | null;
}
