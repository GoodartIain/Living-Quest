-- Campaign chat. Append-only: moderation adds a row to chat_deletions instead of changing the message.
CREATE TABLE messages (
  id text PRIMARY KEY, ord bigserial,
  world_id text NOT NULL REFERENCES worlds DEFERRABLE INITIALLY DEFERRED,
  campaign_id text NOT NULL REFERENCES campaigns DEFERRABLE INITIALLY DEFERRED,
  channel text NOT NULL CHECK (channel IN ('table', 'whisper', 'gm', 'audience')),
  from_user_id text NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED,
  from_name text NOT NULL,
  as_character text,
  to_user_ids jsonb NOT NULL,
  to_names jsonb NOT NULL,
  text text NOT NULL,
  at timestamptz NOT NULL
);
CREATE INDEX messages_campaign ON messages (campaign_id, ord);

CREATE TABLE chat_deletions (
  id text PRIMARY KEY, ord bigserial,
  message_id text NOT NULL REFERENCES messages DEFERRABLE INITIALLY DEFERRED,
  by text NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED,
  at timestamptz NOT NULL
);
