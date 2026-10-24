-- Additive, inactive foundation: existing rows stay unclassified; no historical JSON is rewritten.
-- The generated snapshot also catches up to migrations 0055–0062, already applied separately.
ALTER TABLE "profiles" ADD COLUMN "profession_id" text;
--> statement-breakpoint
CREATE FUNCTION "preserve_profile_profession"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.profession_id IS NOT NULL AND NEW.profession_id IS DISTINCT FROM OLD.profession_id THEN
    RAISE EXCEPTION 'Profile profession is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "profiles_profession_immutable"
BEFORE UPDATE OF "profession_id" ON "profiles"
FOR EACH ROW EXECUTE FUNCTION "preserve_profile_profession"();
