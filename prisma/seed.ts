import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Create default settings
  await prisma.settings.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      timeZone: 'Europe/Kyiv',
      workingDays: '1,2,3,4,5,6,7',
      dayOpenTime: '09:00',
      dayCloseTime: '23:00',
      allowedDurations: '2,3,4',
      cleaningBufferMin: 0,
    },
  });

  console.log('✅ Database seeded successfully!');
}

main()
  .catch((e) => {
    console.error('❌ Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
