-- Búsqueda facial con pgvector.
--
-- Antes, buscar por selfie traía TODOS los embeddings del evento desde Postgres
-- y comparaba en Node: ~37 MB por búsqueda en una carrera de 3 000 fotografías,
-- y un fallo en firme por encima de 100 000 embeddings. Con un índice HNSW el
-- filtrado ocurre dentro de Postgres y no se transfiere nada que no sea el
-- resultado.
--
-- La columna `embedding` (float8[]) se conserva: la usa el índice KNN en memoria
-- del worker y sirve de origen para reconstruir el vector si hiciera falta.

CREATE EXTENSION IF NOT EXISTS vector;

-- buffalo_l (ArcFace r100) produce 512 dimensiones.
ALTER TABLE "face_embeddings" ADD COLUMN "embedding_vec" vector(512);

-- Relleno de lo ya existente. Se filtra por longitud porque un vector de otra
-- dimensión haría fallar la conversión y abortaría la migración entera.
UPDATE "face_embeddings"
SET "embedding_vec" = "embedding"::vector
WHERE "embedding_vec" IS NULL
  AND array_length("embedding", 1) = 512;

-- `vector_cosine_ops` es la clase que corresponde al operador `<=>`, que es la
-- misma distancia coseno que ya usaba el código en Node.
CREATE INDEX "face_embeddings_embedding_vec_hnsw_idx"
  ON "face_embeddings" USING hnsw ("embedding_vec" vector_cosine_ops);
