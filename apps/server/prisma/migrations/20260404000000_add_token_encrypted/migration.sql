-- AlterTable
ALTER TABLE "service_tokens" ADD COLUMN "token_encrypted" TEXT;
ALTER TABLE "service_tokens" ADD COLUMN "token_prefix" VARCHAR(12);
