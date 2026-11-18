-- A file is no longer an Artifact: what the owner cannot change goes as a sent file again. Its
-- versions go with it; the file itself stays in its conversation's media.
DELETE FROM "session_artifacts" WHERE "type" = 'file';
