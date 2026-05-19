import type { Query } from "encore.dev/api";
import type { Channel } from "@notify/shared";

export interface Handshake {
  userId: string;
  channel?: Query<Channel>;
}
