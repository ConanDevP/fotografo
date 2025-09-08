-- Migration: Convert face_embeddings table from Decimal[] to float8[]
-- This migration supports the upgrade to InsightFace 512-dimensional embeddings

BEGIN;

-- Step 1: Add new column with float8[] type
ALTER TABLE face_embeddings 
ADD COLUMN embedding_new float8[];

-- Step 2: Migrate existing data (if any exists)
-- Convert Decimal[] to float8[] for existing records
UPDATE face_embeddings 
SET embedding_new = ARRAY(
  SELECT CAST(unnest(embedding) AS float8)
);

-- Step 3: Drop old column and rename new column
ALTER TABLE face_embeddings 
DROP COLUMN embedding;

ALTER TABLE face_embeddings 
RENAME COLUMN embedding_new TO embedding;

-- Step 4: Update the column to be NOT NULL (since it's required)
ALTER TABLE face_embeddings 
ALTER COLUMN embedding SET NOT NULL;

-- Step 5: Add comment for documentation
COMMENT ON COLUMN face_embeddings.embedding IS 'Face embedding vector - 512-dimensional float array from InsightFace/ArcFace model';

COMMIT;