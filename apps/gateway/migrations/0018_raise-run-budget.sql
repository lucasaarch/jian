-- A hundred thousand is what twelve steps of real tool work spend, so the budget was ending
-- turns that were going fine. Raise the profiles that still hold the old default; a budget the
-- owner chose is left alone.
UPDATE "profiles"
SET "context_policy" = jsonb_set("context_policy", '{maxRunTokens}', '500000')
WHERE "context_policy" ->> 'maxRunTokens' = '100000';
