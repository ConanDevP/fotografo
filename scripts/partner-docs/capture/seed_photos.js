const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({ datasources: { db: { url: 'postgresql://postgres:docs@localhost:55433/lm_docs_test' } } });
(async () => {
  const [eventId, workspaceId] = process.argv.slice(2);
  const out = [];
  for (let i = 1; i <= 3; i++) {
    const photo = await prisma.photo.create({ data: {
      eventId, photographerWorkspaceId: workspaceId, cloudinaryId: `docs-${i}`, originalUrl: `r2://docs-private/events/${eventId}/photo-${i}.jpg`,
      thumbUrl: `https://pub.docs.example/events/${eventId}/photo-${i}-thumb.jpg`, watermarkUrl: `https://pub.docs.example/events/${eventId}/photo-${i}-wm.jpg`,
      watermarkThumbUrl: `https://pub.docs.example/events/${eventId}/photo-${i}-wm-thumb.jpg`, width: 4000, height: 2667, originalBytes: 4200000, derivedBytes: 380000,
      status: 'PROCESSED', publicationStatus: i === 3 ? 'PENDING_REVIEW' : 'APPROVED', takenAt: new Date(), derivativesProcessedAt: new Date(), ocrProcessedAt: new Date(), faceProcessedAt: new Date(), processingCompletedAt: new Date(),
    } });
    await prisma.photoBib.create({ data: { photoId: photo.id, eventId, bib: String(1000 + i), confidence: i === 3 ? 0.62 : 0.97, bbox: [812, 1340, 220, 120], source: 'GEMINI' } });
    out.push(photo.id);
  }
  console.log(JSON.stringify(out));
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
