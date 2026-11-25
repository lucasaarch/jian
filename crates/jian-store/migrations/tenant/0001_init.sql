-- The first tenant migration creates nothing: no table is needed yet. It makes the migration
-- table of every tenant schema exist from the start, and gives a later migration a version to
-- follow. Domain tables arrive in their own files.
SELECT 1;
