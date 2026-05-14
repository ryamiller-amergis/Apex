-- Migration: purge-anonymous-chat-threads
--
-- All chat threads created before the getUserId() bug fix were stored with
-- user_id = 'anonymous' because req.user.profile.oid was being read from the
-- wrong level of the Passport user object (req.user.oid vs req.user.profile.oid).
-- This caused every user's thread list to show every other user's threads.
--
-- This migration permanently deletes those leaked threads. Cascade on the FK
-- relationships handles chat_messages and chat_message_attachments automatically.

-- Up
DELETE FROM chat_threads WHERE user_id = 'anonymous';

-- Down (irreversible — deleted rows cannot be recovered)
-- SELECT 1;
