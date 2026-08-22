import { PlanAudience, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const GB = BigInt(1024) * BigInt(1024) * BigInt(1024);

/**
 * Catálogo de planes de LucilaMon.
 *
 * Cada plan lleva los dos modos y es el evento quien elige cuál usa:
 *
 *   · MODO VENTA — las fotografías se venden y la plataforma retiene una
 *     comisión sobre cada una.
 *   · MODO COMPARTIR — las fotografías se regalan y se cobra por fotografía
 *     subida, que es cuando se incurre el coste real (OCR, reconocimiento
 *     facial, derivadas y almacenamiento).
 *
 * Cobrar el modo compartir por foto y no por evento evita castigar a quien
 * conserva eventos antiguos, y le da al organizador una cifra que puede
 * presupuestar antes de la carrera.
 *
 * Sobre las cifras: el almacenamiento en R2 cuesta ~0,015 $/GB/mes sin cargo
 * por descarga, así que 25 GB salen por ~0,38 $/mes. Es barato ser generoso
 * ahí y firme en la comisión, que es donde está el ingreso real.
 */
const PLANS = [
  {
    slug: 'arranque',
    name: 'Arranque',
    audience: PlanAudience.ANY,
    description: 'Una forma sencilla de empezar. Sin mensualidad.',
    priceCents: 0,
    commissionPercent: 20,
    sharePhotoCents: 2, // 0,02 $ por fotografía subida
    includedStorageBytes: BigInt(25) * GB,
    extraStorageBlockBytes: null,
    extraStorageBlockCents: null,
    sponsoredEventFeeCents: 0,
    maxAdmins: 1,
    allowsCustomDomain: false,
    allowsSponsors: false,
    allowsAdvancedMetrics: false,
    isDefault: true,
    sortOrder: 0,
  },
  {
    slug: 'profesional',
    name: 'Profesional',
    audience: PlanAudience.ANY,
    description: 'Para cuando cubres eventos cada fin de semana.',
    priceCents: 1900,
    commissionPercent: 14,
    sharePhotoCents: 1.2, // 0,012 $ por fotografía subida
    includedStorageBytes: BigInt(150) * GB,
    extraStorageBlockBytes: BigInt(100) * GB,
    extraStorageBlockCents: 900,
    sponsoredEventFeeCents: 0,
    maxAdmins: 3,
    allowsCustomDomain: true,
    allowsSponsors: true,
    allowsAdvancedMetrics: true,
    isDefault: false,
    sortOrder: 1,
  },
  {
    slug: 'organizacion',
    name: 'Organización',
    audience: PlanAudience.ANY,
    description: 'Para circuitos y equipos que invitan fotógrafos y gestionan patrocinadores.',
    priceCents: 3900,
    commissionPercent: 10,
    sharePhotoCents: 0.8, // 0,008 $ por fotografía subida
    includedStorageBytes: BigInt(600) * GB,
    extraStorageBlockBytes: BigInt(100) * GB,
    extraStorageBlockCents: 900,
    sponsoredEventFeeCents: 0,
    maxAdmins: 10,
    allowsCustomDomain: true,
    allowsSponsors: true,
    allowsAdvancedMetrics: true,
    isDefault: false,
    sortOrder: 2,
  },
];

async function main() {
  console.log('🌱 Sembrando planes...');

  for (const plan of PLANS) {
    const saved = await prisma.plan.upsert({
      where: { slug: plan.slug },
      create: plan,
      // No se pisa `isActive` ni `stripePriceId`: si alguien retiró un plan de
      // la venta o lo enlazó con Stripe, volver a sembrar no debe deshacerlo.
      update: {
        name: plan.name,
        audience: plan.audience,
        description: plan.description,
        priceCents: plan.priceCents,
        commissionPercent: plan.commissionPercent,
        sharePhotoCents: plan.sharePhotoCents,
        includedStorageBytes: plan.includedStorageBytes,
        extraStorageBlockBytes: plan.extraStorageBlockBytes,
        extraStorageBlockCents: plan.extraStorageBlockCents,
        sponsoredEventFeeCents: plan.sponsoredEventFeeCents,
        maxAdmins: plan.maxAdmins,
        allowsCustomDomain: plan.allowsCustomDomain,
        allowsSponsors: plan.allowsSponsors,
        allowsAdvancedMetrics: plan.allowsAdvancedMetrics,
        isDefault: plan.isDefault,
        sortOrder: plan.sortOrder,
      },
    });

    const gb = Number(saved.includedStorageBytes / GB);
    console.log(
      `   ✅ ${saved.name.padEnd(14)} ${(saved.priceCents / 100).toFixed(2).padStart(6)} $/mes · ` +
        `venta ${Number(saved.commissionPercent)}% · compartir $${(Number(saved.sharePhotoCents) / 100).toFixed(4)}/foto · ${gb} GB`,
    );
  }

  const defaults = await prisma.plan.count({ where: { isDefault: true, isActive: true } });
  if (defaults !== 1) {
    throw new Error(
      `Debe haber exactamente un plan por defecto activo y hay ${defaults}. ` +
        'Sin él no se puede calcular la comisión de los espacios sin suscripción.',
    );
  }

  console.log('🌱 Planes listos.');
}

main()
  .catch(error => {
    console.error('❌ Error sembrando planes:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
