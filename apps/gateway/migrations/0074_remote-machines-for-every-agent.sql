-- Every agent may use every Remote Control machine; the per-machine list of agents is gone.
ALTER TABLE remote_machines DROP COLUMN allowed_profile_ids;
