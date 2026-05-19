import type { Query } from "encore.dev/api";

export interface ListRequest {
  userId: string;
  page?: Query<number>;
  size?: Query<number>;
}
