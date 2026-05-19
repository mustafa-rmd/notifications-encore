-- UNIQUE on a nullable column still allows multiple NULL rows, which
-- matches the "email is optional" contract. This migration will fail if
-- the existing data contains duplicate non-null emails — dedupe (or
-- `encore db reset notifications`) before retrying.
ALTER TABLE users
  ADD CONSTRAINT users_email_key UNIQUE (email);
