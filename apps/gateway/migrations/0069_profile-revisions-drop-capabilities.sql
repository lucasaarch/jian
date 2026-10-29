-- 0068 dropped the capability columns, but every profile revision still carries them in its
-- document, and the strict profile schema refuses a document with keys it does not know: each
-- run that froze one of those revisions failed to read.
UPDATE profile_revisions
SET document = document
  - 'allowSelfManagement'
  - 'allowWebSearch'
  - 'learnFromWork'
  - 'reachableByAgents'
WHERE document ?| ARRAY['allowSelfManagement', 'allowWebSearch', 'learnFromWork', 'reachableByAgents'];
