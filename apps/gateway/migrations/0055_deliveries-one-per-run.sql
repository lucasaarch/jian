-- Keep the oldest outbound row when a race already queued two for the same run.
DELETE FROM "deliveries" d
USING "deliveries" older
WHERE d.run_id IS NOT NULL
  AND older.run_id = d.run_id
  AND (
    older.created_at < d.created_at
    OR (older.created_at = d.created_at AND older.id < d.id)
  );
--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_one_per_run" ON "deliveries" USING btree ("run_id") WHERE "run_id" is not null;
