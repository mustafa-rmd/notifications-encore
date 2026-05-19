import type { Channel } from "@notify/shared";

export type NotificationRow = {
  id: string;
  user_id: string;
  channel: Channel;
  title: string;
  body: string;
  created_at: Date;
  sent_at: Date | null;
  read_at: Date | null;
};
