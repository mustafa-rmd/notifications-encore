import type {
  Channel,
  ListNotificationsResponse,
  ListUsersResponse,
  Notification,
  User,
} from "@notify/shared";
import { ApiError } from "./api-error";
import type { ApiErrorBody } from "../types/api-error-body";

const PAGE_SIZE = 100;

export class ApiClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async request<T>(
    method: string,
    path: string,
    payload?: Record<string, unknown>,
  ): Promise<T> {
    const init: RequestInit = { method };
    if (payload !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(payload);
    }
    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}${path}`, init);
    } catch (e) {
      throw new Error(
        `Cannot reach backend at ${this.baseUrl} — is it running? (${(e as Error).message})`,
      );
    }
    const text = await resp.text();
    const body = text ? (JSON.parse(text) as unknown) : null;
    if (!resp.ok) {
      const err = (body ?? {}) as ApiErrorBody;
      throw new ApiError(
        resp.status,
        err.code ?? "unknown",
        err.message ?? `HTTP ${resp.status}`,
      );
    }
    return body as T;
  }

  private async listAllPages(basePath: string): Promise<Notification[]> {
    const all: Notification[] = [];
    let page = 1;
    while (true) {
      const params = new URLSearchParams({
        page: String(page),
        size: String(PAGE_SIZE),
      });
      const resp = await this.request<ListNotificationsResponse>(
        "GET",
        `${basePath}?${params.toString()}`,
      );
      all.push(...resp.notifications);
      if (page >= resp.totalPages || resp.notifications.length === 0)
        return all;
      page++;
    }
  }

  createUser(name: string, email?: string): Promise<User> {
    return this.request<User>("POST", "/users", { name, email });
  }

  listUsers(): Promise<ListUsersResponse> {
    return this.request("GET", "/users");
  }

  send(
    userId: string,
    channel: Channel,
    title: string,
    body: string,
  ): Promise<Notification> {
    return this.request("POST", "/notifications", {
      userId,
      channel,
      title,
      body,
    });
  }

  listNotifications(userId: string): Promise<Notification[]> {
    return this.listAllPages(
      `/users/${encodeURIComponent(userId)}/notifications`,
    );
  }

  listUnread(userId: string): Promise<Notification[]> {
    return this.listAllPages(
      `/users/${encodeURIComponent(userId)}/notifications/unread`,
    );
  }

  markRead(id: string): Promise<Notification> {
    return this.request(
      "POST",
      `/notifications/${encodeURIComponent(id)}/read`,
    );
  }

  openStream(userId: string, channel?: Channel): Promise<WebSocket> {
    const qs = channel ? `?channel=${channel}` : "";
    const wsUrl =
      this.baseUrl.replace(/^http/, "ws") +
      `/users/${encodeURIComponent(userId)}/notifications/stream${qs}`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.addEventListener("open", () => resolve(ws));
      ws.addEventListener("error", () =>
        reject(new Error(`Failed to connect to ${wsUrl}`)),
      );
    });
  }
}
