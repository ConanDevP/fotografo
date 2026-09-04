/**
 * Limpia los price_id de Stripe guardados en los planes para que
 * `POST /admin/billing/sync-plans` los regenere bajo la clave de Stripe que
 * esté activa en ese momento.
 *
 * Hace falta cuando `STRIPE_SECRET_KEY` cambió de modo (test → live o al
 * revés): un price_id creado bajo una clave no existe para la otra, y Stripe
 * responde "No such price" al intentar cobrar. `sync-plans` no lo arregla
 * solo porque salta cualquier plan que ya tenga un price_id guardado, sea
 * válido o no.
 *
 * Uso (necesita DATABASE_URL de producción en el entorno):
 *   npx ts-node apps/api/prisma/reset-plan-stripe-ids.ts
 *   npx ts-node apps/api/prisma/reset-plan-stripe-ids.ts profesional   # solo ese plan
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const slug = process.argv[2];
  const where = slug ? { slug } : {};

  const before = await prisma.plan.findMany({
    where,
    select: { slug: true, name: true, stripePriceId: true, stripeStoragePriceId: true },
  });

  if (before.length === 0) {
    console.log(slug ? `No existe ningún plan con slug "${slug}".` : 'No hay planes en la base de datos.');
    return;
  }

  console.log('Planes antes de limpiar:');
  for (const plan of before) {
    console.log(`  ${plan.name.padEnd(14)} stripePriceId=${plan.stripePriceId ?? '(vacío)'} stripeStoragePriceId=${plan.stripeStoragePriceId ?? '(vacío)'}`);
  }

  const result = await prisma.plan.updateMany({
    where,
    data: { stripePriceId: null, stripeStoragePriceId: null },
  });

  console.log(`\n✅ ${result.count} plan(es) limpiados. Ahora corre POST /admin/billing/sync-plans para regenerar los precios en Stripe.`);
}

main()
  .catch(error => {
    console.error('❌ Error limpiando price_id:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
