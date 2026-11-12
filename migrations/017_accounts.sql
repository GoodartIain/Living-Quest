-- Milestone 13: real accounts. Email + scrypt password on users; sessions that expire and can be revoked.
-- Development (display-name) accounts have no email or password and may have a legacy token.
ALTER TABLE users ALTER COLUMN token_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN email text UNIQUE;
ALTER TABLE users ADD COLUMN password_hash text;

CREATE TABLE sessions (
  id text PRIMARY KEY, ord bigserial,
  user_id text NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED,
  token_hash text NOT NULL UNIQUE,
  expires_at text NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);
