-- An email `send_email` queues may copy other addresses and carry files: both wait with the
-- delivery until it is sent, as the media ids of the files and the bare addresses copied.
ALTER TABLE "deliveries" ADD COLUMN "email" jsonb;
