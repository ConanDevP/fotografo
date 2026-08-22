/**
 * Diagnóstico de la cadena rostro↔dorsal para un evento.
 *
 * Recorre los cinco eslabones y dice en cuál se corta, en vez de dejarte
 * adivinando por qué una fotografía no aparece al buscar por número.
 *
 *   node scripts/diagnostico-inferencia.js <eventId|slug>
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const dist = (a, b) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return 1 - d / (Math.sqrt(na) * Math.sqrt(nb));
};

(async () => {
  const arg = process.argv[2];
  if (!arg) { console.error('Falta el evento: node scripts/diagnostico-inferencia.js <eventId|slug>'); process.exit(1); }

  const event = await prisma.event.findFirst({
    where: { OR: [{ slug: arg }, ...(/^[0-9a-f-]{36}$/i.test(arg) ? [{ id: arg }] : [])] },
    select: { id: true, name: true },
  });
  if (!event) { console.error(`No encuentro el evento "${arg}"`); process.exit(1); }

  console.log(`\n  EVENTO: ${event.name}\n  ${'─'.repeat(64)}`);

  const photos = await prisma.photo.findMany({
    where: { eventId: event.id },
    select: {
      id: true, status: true, width: true, height: true,
      faces: { select: { id: true, embedding: true } },
      bibs: { select: { bib: true, source: true, confidence: true, geminiImageWidth: true } },
      faceBibAssociations: { select: { bib: true, method: true } },
      inferredBibs: { select: { bib: true, confidence: true, faceDistance: true, verified: true, rejected: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (!photos.length) { console.log('  Sin fotografías.'); await prisma.$disconnect(); return; }

  console.log('\n  ESLABÓN 1 — ¿se detectaron caras y dorsales?\n');
  for (const p of photos) {
    const short = p.id.slice(0, 8);
    const dims = p.width && p.height ? `${p.width}×${p.height}` : '⚠ SIN DIMENSIONES';
    const bibs = p.bibs.map(b => `${b.bib}(${b.source === 'GEMINI' ? 'ocr' : 'inf'})`).join(' ') || '—';
    console.log(`    ${short}  ${String(p.status).padEnd(9)} ${dims.padEnd(16)} caras:${String(p.faces.length).padEnd(3)} dorsales: ${bibs}`);
  }

  console.log('\n  ESLABÓN 2 — ¿hay puente (rostro atado a dorsal en la misma foto)?\n');
  const bridges = photos.filter(p => p.faceBibAssociations.some(a => a.method === 'SPATIAL'));
  if (!bridges.length) {
    console.log('    ✗ NINGUNO. Sin puente no hay nada que propagar.');
    console.log('      Causas: ninguna foto tiene rostro y dorsal a la vez, o el');
    console.log('      emparejamiento espacial no los ató (revisa las dimensiones arriba).');
  } else {
    bridges.forEach(p => console.log(`    ✓ ${p.id.slice(0, 8)} → ${p.faceBibAssociations.map(a => a.bib).join(', ')}`));
  }

  console.log('\n  ESLABÓN 3 — caras sin dorsal, y a qué distancia están del puente\n');
  const indexed = photos.flatMap(p => p.faceBibAssociations.length ? p.faces.map(f => ({ ...f, photoId: p.id, bib: p.faceBibAssociations[0].bib })) : []);
  const orphans = photos.filter(p => !p.faceBibAssociations.length && p.faces.length);

  if (!orphans.length) console.log('    (ninguna: todas las caras tienen dorsal)');
  for (const p of orphans) {
    for (const f of p.faces) {
      const best = indexed
        .filter(i => i.photoId !== p.id)
        .map(i => ({ bib: i.bib, d: dist(f.embedding, i.embedding) }))
        .sort((a, b) => a.d - b.d)[0];
      if (!best) { console.log(`    ${p.id.slice(0, 8)}  sin nada con qué comparar`); continue; }
      const verdict = best.d <= 0.30 ? '✓ debería ASIGNARSE'
        : best.d <= 0.45 ? '~ debería quedar PENDIENTE'
        : '✗ FUERA DE RANGO (umbral 0.45)';
      console.log(`    ${p.id.slice(0, 8)}  más parecida: dorsal ${best.bib} a ${best.d.toFixed(3)}   ${verdict}`);
    }
  }

  console.log('\n  ESLABÓN 4 — lo que la inferencia guardó de verdad\n');
  const inferred = photos.flatMap(p => p.inferredBibs.map(i => ({ ...i, photo: p.id.slice(0, 8) })));
  if (!inferred.length) console.log('    (nada)');
  inferred.forEach(i => console.log(`    ${i.photo}  dorsal ${i.bib}  distancia ${Number(i.faceDistance).toFixed(3)}  ${i.rejected ? 'RECHAZADA' : i.verified ? 'verificada' : 'pendiente'}`));

  console.log('\n  ESLABÓN 5 — qué devolvería buscar cada dorsal\n');
  const allBibs = [...new Set(photos.flatMap(p => p.bibs.map(b => b.bib)))];
  for (const bib of allBibs) {
    const direct = photos.filter(p => p.bibs.some(b => b.bib === bib)).length;
    const pending = photos.filter(p => p.inferredBibs.some(i => i.bib === bib && !i.verified && !i.rejected && Number(i.confidence) >= 0.55)).length;
    console.log(`    "${bib}" → ${direct + pending} fotografías (${direct} directas + ${pending} marcadas)`);
  }

  console.log('');
  await prisma.$disconnect();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
