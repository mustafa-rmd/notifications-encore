import type { User } from "@notify/shared";
import type { UserRow } from "./user-row";

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    createdAt: row.created_at.toISOString(),
  };
}
