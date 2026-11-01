CREATE TABLE "x_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"x_user_id" text NOT NULL,
	"handle" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"connected_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "x_accounts_x_user_id" ON "x_accounts" USING btree ("x_user_id");
--> statement-breakpoint
CREATE TABLE "x_connect_states" (
	"hash" text PRIMARY KEY NOT NULL,
	"verifier" text NOT NULL,
	"return_to" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
