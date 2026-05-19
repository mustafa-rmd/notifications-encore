ALTER TABLE notifications
  ADD COLUMN delivery_status TEXT        NOT NULL DEFAULT 'pending',
  ADD COLUMN attempt_count   INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN last_error      TEXT,
  ADD COLUMN next_attempt_at TIMESTAMPTZ;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_delivery_status_check
  CHECK (delivery_status IN ('pending', 'sent', 'failed'));

-- Rows inserted before the outbox existed were delivered synchronously.
UPDATE notifications SET delivery_status = 'sent' WHERE sent_at IS NOT NULL;

CREATE INDEX notifications_email_pending_idx
  ON notifications (created_at)
  WHERE delivery_status = 'pending' AND channel = 'email';
