ALTER TABLE "app_settings"
ADD COLUMN "sender_name" TEXT NOT NULL DEFAULT 'Brian Woodson',
ADD COLUMN "sender_email" TEXT NOT NULL DEFAULT 'leads@brianwoodson.dev';
