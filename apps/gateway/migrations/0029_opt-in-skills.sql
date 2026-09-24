-- The discernment nudge becomes opt-in: every profile starts without it, and turns it on in Skills.
UPDATE profiles
SET disabled_skills = disabled_skills || '["discernment-nudge"]'::jsonb
WHERE NOT disabled_skills @> '["discernment-nudge"]'::jsonb;
