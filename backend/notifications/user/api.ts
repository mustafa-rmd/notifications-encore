import { api, APIError } from "encore.dev/api";
import type {
  CreateUserRequest,
  ListUsersResponse,
  User,
} from "@notify/shared";
import { db } from "../db";
import type { UserRow } from "./user-row";
import { toUser } from "./mapper";

export const create = api(
  { method: "POST", path: "/users", expose: true },
  async (req: CreateUserRequest): Promise<User> => {
    const name = req.name?.trim();
    if (!name) {
      throw APIError.invalidArgument("name is required");
    }
    const email = req.email?.trim() || null;

    if (email !== null) {
      const existing = await db.queryRow<{ id: string }>`
        SELECT id FROM users WHERE email = ${email}
      `;
      if (existing) {
        throw APIError.alreadyExists(
          `a user with email "${email}" already exists`,
        ).withDetails({ field: "email", value: email });
      }
    }

    let row: UserRow | null;
    try {
      row = await db.queryRow<UserRow>`
        INSERT INTO users (name, email)
        VALUES (${name}, ${email})
        RETURNING id, name, email, created_at
      `;
    } catch (e) {
      // Race-safe net: another request may have inserted the same email
      // between our pre-check and this INSERT. Match by SQLSTATE if it
      // survives Encore's napi wrapper, or by message text as a fallback.
      const err = e as { code?: string; message?: string };
      const msg = err.message ?? "";
      const isUniqueViolation =
        err.code === "23505" ||
        msg.includes("duplicate key value") ||
        msg.includes("violates unique constraint");
      if (isUniqueViolation && email !== null) {
        throw APIError.alreadyExists(
          `a user with email "${email}" already exists`,
        ).withDetails({ field: "email", value: email });
      }
      throw e;
    }
    if (!row) throw APIError.internal("failed to insert user");
    return toUser(row);
  },
);

export const list = api(
  { method: "GET", path: "/users", expose: true },
  async (): Promise<ListUsersResponse> => {
    const users: User[] = [];
    for await (const row of db.query<UserRow>`
      SELECT id, name, email, created_at
      FROM users
      ORDER BY created_at DESC
    `) {
      users.push(toUser(row));
    }
    return { users };
  },
);
