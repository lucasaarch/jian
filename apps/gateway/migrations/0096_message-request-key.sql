ALTER TABLE "messages" ADD COLUMN "request_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_request_key" ON "messages" USING btree ("session_id","request_key") WHERE "messages"."request_key" IS NOT NULL;
