-- AlterTable
ALTER TABLE "batch_upload_jobs" ADD COLUMN     "failed_faces" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "failed_gemini" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "failed_watermarks" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "face_files" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "gemini_files" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "watermark_files" INTEGER NOT NULL DEFAULT 0;