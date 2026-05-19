import { api } from "encore.dev/api";
import log from "encore.dev/log";
import { db } from "../../db";
import type { ClaimedRow } from "./claimed-row";
import type { UserEmailRow } from "./user-email-row";
import type { OutboxResult } from "./outbox-result";

const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 50;
// Long enough that a worker process can't be mid-send when another claim runs;
// short enough that a crashed worker's rows are picked up by the next cycle.
const CLAIM_TIMEOUT_MS = 5 * 60 * 1000;

// 30s, 2m, 8m, 32m, capped at 2h
function backoffSeconds(prevAttempts: number): number {
  return Math.min(2 * 60 * 60, 30 * Math.pow(4, prevAttempts));
}

// Swap for a real provider (Resend, SES, etc.) under this same signature.
async function deliverEmail(
  to: string,
  userId: string,
  notificationId: string,
  title: string,
): Promise<void> {
  log.info("simulated email send", { to, userId, notificationId, title });
}

export const processEmailOutbox = api(
  { method: "POST", path: "/internal/process-email-outbox", expose: false },
  async (): Promise<OutboxResult> => {
    // Claim a batch by pushing next_attempt_at into the future. Until that
    // window expires no other run picks these rows up, so a process that dies
    // mid-send simply releases them when CLAIM_TIMEOUT_MS elapses.
    const claimUntil = new Date(Date.now() + CLAIM_TIMEOUT_MS);
    const claimed: ClaimedRow[] = [];
    for await (const row of db.query<ClaimedRow>`
      UPDATE notifications
      SET next_attempt_at = ${claimUntil}
      WHERE id IN (
        SELECT id FROM notifications
        WHERE channel = 'email'
          AND delivery_status = 'pending'
          AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        ORDER BY created_at ASC
        LIMIT ${BATCH_SIZE}
      )
      RETURNING id, user_id, title, body, attempt_count
    `) {
      claimed.push(row);
    }

    let sent = 0;
    let failed = 0;
    for (const row of claimed) {
      try {
        const user = await db.queryRow<UserEmailRow>`
          SELECT email FROM users WHERE id = ${row.user_id}
        `;
        if (!user?.email) {
          throw new Error("user has no email address on file");
        }
        await deliverEmail(user.email, row.user_id, row.id, row.title);
        await db.exec`
          UPDATE notifications
          SET delivery_status = 'sent',
              sent_at = now(),
              attempt_count = attempt_count + 1,
              last_error = NULL,
              next_attempt_at = NULL
          WHERE id = ${row.id}
        `;
        sent++;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const nextAttempts = row.attempt_count + 1;
        const giveUp = nextAttempts >= MAX_ATTEMPTS;
        const nextAttemptAt = giveUp
          ? null
          : new Date(Date.now() + backoffSeconds(nextAttempts - 1) * 1000);
        await db.exec`
          UPDATE notifications
          SET delivery_status = ${giveUp ? "failed" : "pending"},
              attempt_count = ${nextAttempts},
              last_error = ${message},
              next_attempt_at = ${nextAttemptAt}
          WHERE id = ${row.id}
        `;
        failed++;
        log.warn("email delivery attempt failed", {
          notificationId: row.id,
          attempt: nextAttempts,
          giveUp,
          error: message,
        });
      }
    }

    return { processed: claimed.length, sent, failed };
  },
);
