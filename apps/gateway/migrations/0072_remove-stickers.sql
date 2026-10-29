-- Stickers are gone: the collection, the flag that sent a file as one, and the model that
-- described them. A sticker someone sends now arrives as an ordinary picture.
DROP TABLE stickers;
--> statement-breakpoint
ALTER TABLE media_assets DROP COLUMN sticker;
--> statement-breakpoint
DELETE FROM model_defaults WHERE role = 'sticker';
