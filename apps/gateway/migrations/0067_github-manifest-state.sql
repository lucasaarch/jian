ALTER TABLE github_installation_states
  ADD COLUMN purpose text NOT NULL DEFAULT 'installation';
