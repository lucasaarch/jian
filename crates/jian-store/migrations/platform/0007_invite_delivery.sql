-- An invitation's id stops being its token's hash, and it records how its e-mail went.
--
-- "Copy the link" and "send it again" both issue a NEW token for the same invitation: the admin
-- holds one invitation per address, and its id must not change when its token does. So the id
-- is a column of its own (an existing row keeps its old id, the hash it had, so a page open
-- during the upgrade still names it), and the rotation replaces `token_hash` in the same row.
ALTER TABLE invites ADD COLUMN id text;
UPDATE invites SET id = token_hash;
ALTER TABLE invites ALTER COLUMN id SET NOT NULL;
ALTER TABLE invites ADD CONSTRAINT invites_id_key UNIQUE (id);

-- How sending the e-mail went, for the admin to see:
--   none     nothing was sent (a link only, or the link was copied while a send was waiting);
--   pending  a job is to send it;
--   sent     the provider took it (`sent_at`, and `provider_message_id` when it said one);
--   failed   it will not be sent (`send_error`: a short reason, never a key or a body).
-- `send_error` is cleared by the next send. The status belongs to the token issued for that
-- send: the job writes it only while that token is still the invitation's (see `invites.rs`).
ALTER TABLE invites
    ADD COLUMN send_status text NOT NULL DEFAULT 'none'
        CHECK (send_status IN ('none', 'pending', 'sent', 'failed')),
    ADD COLUMN send_error text,
    ADD COLUMN sent_at timestamptz,
    ADD COLUMN provider_message_id text;
