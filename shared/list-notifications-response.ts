import type { Notification } from "./notification";

export interface ListNotificationsResponse {
  notifications: Notification[];
  page: number;
  size: number;
  total: number;
  totalPages: number;
}
