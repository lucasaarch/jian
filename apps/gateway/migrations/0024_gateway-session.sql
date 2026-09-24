CREATE UNIQUE INDEX sessions_gateway ON sessions (profile_id) WHERE channel = 'gateway';
