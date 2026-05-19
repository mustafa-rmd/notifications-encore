import type { Notification } from "./notification";

export interface StreamEvent {
  type: "notification" | "ping";
  data?: Notification;
}
