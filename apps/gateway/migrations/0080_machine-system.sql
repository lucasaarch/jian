-- The OS by name and version each machine's worker reports on every poll, or its creator gave:
-- "macOS 27.2", "Windows 11 (26100)". Null until either says.
ALTER TABLE "remote_machines" ADD COLUMN "system" text;
