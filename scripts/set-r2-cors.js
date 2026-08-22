/**
 * Configura CORS en el bucket de R2 para permitir la subida directa desde el
 * navegador. Sin esta política el navegador bloquea la respuesta del PUT aunque
 * la URL firmada sea válida y R2 acepte el objeto.
 *
 * Los orígenes salen de CORS_ORIGINS, la misma lista que autoriza la API.
 *
 *   node scripts/set-r2-cors.js
 */
require('dotenv').config();
const { S3Client, PutBucketCorsCommand, GetBucketCorsCommand } = require('@aws-sdk/client-s3');

const accountId = process.env.R2_ACCOUNT_ID;
const bucket = process.env.R2_BUCKET_NAME;
const origins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim().replace(/\/$/, ''))
  .filter(Boolean);

if (!accountId || !bucket) {
  console.error('Faltan R2_ACCOUNT_ID o R2_BUCKET_NAME');
  process.exit(1);
}
if (!origins.length) {
  console.error('CORS_ORIGINS está vacío: no hay orígenes que autorizar');
  process.exit(1);
}

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

(async () => {
  await client.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: origins,
            // PUT para subir; GET y HEAD porque el navegador también lee
            // miniaturas y verifica objetos.
            AllowedMethods: ['PUT', 'GET', 'HEAD'],
            AllowedHeaders: ['content-type'],
            ExposeHeaders: ['ETag'],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    }),
  );

  const current = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
  console.log(`CORS aplicado en "${bucket}":`);
  for (const rule of current.CORSRules || []) {
    console.log(`  orígenes: ${rule.AllowedOrigins.join(', ')}`);
    console.log(`  métodos : ${rule.AllowedMethods.join(', ')}`);
  }
})().catch(error => {
  console.error('No se pudo aplicar CORS:', error.message);
  process.exit(1);
});
