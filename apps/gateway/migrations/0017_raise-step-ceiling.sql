-- Twelve steps is fewer than one ordinary errand takes: a run that reached it had done the
-- work and was thrown away. Raise the profiles that still hold the old default; a ceiling the
-- owner chose is left alone.
UPDATE "profiles"
SET "context_policy" = jsonb_set("context_policy", '{maxSteps}', '200')
WHERE "context_policy" ->> 'maxSteps' = '12';
