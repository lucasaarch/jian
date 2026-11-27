-- The session of a chat account: the many small records a provider like WhatsApp keeps between
-- runs (identity, ratchets, pre-keys, sync state).
--
-- The vault (`secrets`) holds one text per owner and cannot list or count, and a session has
-- thousands of records that must be read by prefix, so they get a table of their own. The VALUE
-- is never plain: `envelope` is sealed with the tenant's data key exactly like a vault secret
-- (`jian_store::secrets`), bound to the tenant, the account and the key, so a row copied to
-- another account or tenant does not open. `key` is the record's name (a namespace and an
-- address such as `session/5511...@s.whatsapp.net`): metadata, not key material.
--
-- Deleting the account deletes its session; so does disconnecting with log-out.
CREATE TABLE channel_session (
    account_id text NOT NULL REFERENCES channel_accounts (id) ON DELETE CASCADE,
    key text NOT NULL CHECK (btrim(key) <> ''),
    envelope bytea NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, key)
);
