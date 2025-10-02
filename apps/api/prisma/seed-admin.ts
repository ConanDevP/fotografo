import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Creando usuario administrador...');

  // Datos del admin
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@fotografo.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'Admin123456!';
  const adminName = process.env.ADMIN_NAME || 'Super Admin';

  // Verificar si ya existe
  const existingAdmin = await prisma.user.findUnique({
    where: { email: adminEmail },
  });

  if (existingAdmin) {
    console.log('⚠️  El usuario admin ya existe:', adminEmail);
    console.log('Usuario ID:', existingAdmin.id);
    console.log('Rol:', existingAdmin.role);
    return;
  }

  // Hash de la contraseña
  const passwordHash = await argon2.hash(adminPassword);

  // Crear admin
  const admin = await prisma.user.create({
    data: {
      email: adminEmail,
      passwordHash,
      name: adminName,
      role: 'ADMIN',
      isVerified: true,
      isFeatured: false,
    },
  });

  console.log('✅ Usuario administrador creado exitosamente!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📧 Email:', admin.email);
  console.log('🔑 Password:', adminPassword);
  console.log('👤 Nombre:', admin.name);
  console.log('🆔 ID:', admin.id);
  console.log('⚡ Rol:', admin.role);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('⚠️  IMPORTANTE: Cambia la contraseña después del primer login!');
}

main()
  .catch((e) => {
    console.error('❌ Error creando admin:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
