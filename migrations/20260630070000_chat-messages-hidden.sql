-- Add hidden flag to chat_messages so auto-kickoff messages persist correctly
ALTER TABLE chat_messages ADD COLUMN hidden boolean NOT NULL DEFAULT false;
