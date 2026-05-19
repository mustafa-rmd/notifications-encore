import type { Notification, StreamEvent } from "@notify/shared";

export function parseStreamEvent(raw: string): Notification | null {
  try {
    const event = JSON.parse(raw) as StreamEvent;
    return event.type === "notification" && event.data ? event.data : null;
  } catch {
    return null;
  }
}
