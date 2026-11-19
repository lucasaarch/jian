-- The password a public Artifact's link asks for, as a salted scrypt hash (artifacts/password.ts);
-- null for one anyone with the link opens. It outlives the link: made private and public again, an
-- Artifact's new link asks for the same password.
ALTER TABLE "session_artifacts" ADD COLUMN "public_password" text;
