CREATE TABLE "sales_campaign_metrics" (
	"profile_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"campaign_name" text NOT NULL,
	"day" date NOT NULL,
	"lookups" integer DEFAULT 0 NOT NULL,
	"qualified" integer DEFAULT 0 NOT NULL,
	"not_qualified" integer DEFAULT 0 NOT NULL,
	"escalated" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "sales_campaign_metrics_profile_id_campaign_id_day_pk" PRIMARY KEY("profile_id","campaign_id","day"),
	CONSTRAINT "sales_campaign_metrics_nonnegative" CHECK ("sales_campaign_metrics"."lookups" >= 0 and "sales_campaign_metrics"."qualified" >= 0 and "sales_campaign_metrics"."not_qualified" >= 0 and "sales_campaign_metrics"."escalated" >= 0)
);
--> statement-breakpoint
ALTER TABLE "sales_campaigns" ADD COLUMN "rules" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_campaigns" ADD COLUMN "playbook" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_campaigns" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_campaigns" ADD COLUMN "starts_on" date;--> statement-breakpoint
ALTER TABLE "sales_campaigns" ADD COLUMN "ends_on" date;--> statement-breakpoint
ALTER TABLE "sales_campaign_metrics" ADD CONSTRAINT "sales_campaign_metrics_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sales_campaign_metrics_profile_day" ON "sales_campaign_metrics" USING btree ("profile_id","day" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "sales_campaigns" ADD CONSTRAINT "sales_campaigns_valid_dates" CHECK ("sales_campaigns"."starts_on" is null or "sales_campaigns"."ends_on" is null or "sales_campaigns"."ends_on" >= "sales_campaigns"."starts_on");