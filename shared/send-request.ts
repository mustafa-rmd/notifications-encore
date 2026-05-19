import type { Channel } from "./channel";

export interface SendRequest {
  userId: string;
  channel: Channel;
  title: string;
  body: string;
}
