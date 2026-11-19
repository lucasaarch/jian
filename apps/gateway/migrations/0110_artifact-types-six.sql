-- Six kinds of Artifact remain. A picture (svg) becomes a web page: every version of it is wrapped
-- in a minimal page so it still draws, scaled to fit. A whiteboard (board) is deleted, and its
-- versions with it.
UPDATE "session_artifact_versions" SET "content" = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;height:100%}body{display:grid;place-items:center}body>svg{max-width:100%;max-height:100%}</style></head><body>' || "content" || '</body></html>' WHERE "artifact_id" IN (SELECT "id" FROM "session_artifacts" WHERE "type" = 'svg');--> statement-breakpoint
UPDATE "session_artifacts" SET "type" = 'html' WHERE "type" = 'svg';--> statement-breakpoint
DELETE FROM "session_artifacts" WHERE "type" = 'board';
