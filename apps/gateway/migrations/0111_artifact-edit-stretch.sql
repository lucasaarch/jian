-- One editing stretch of the owner is one version: the panel names the stretch with a key it makes
-- itself, and the gateway replaces a version's content only while the key matches the latest
-- version, written by the owner. Null for every version the agent wrote and every one made before.
ALTER TABLE "session_artifact_versions" ADD COLUMN "edit_key" text;
