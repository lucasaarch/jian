-- An installation of the GitHub App a member of an organization asked its owners for, by the
-- GitHub user who asked, until an owner approves it and the App's webhook connects it here.
CREATE TABLE "github_installation_requests" (
	"github_user_id" bigint PRIMARY KEY NOT NULL,
	"login" text NOT NULL,
	"return_origin" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
