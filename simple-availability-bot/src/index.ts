import { appConfig } from './config';
import { AvailabilityStore } from './storage/availabilityStore';
import { AvailabilityService } from './services/availabilityService';
import { createBot } from './bot';

async function bootstrap() {
  const store = new AvailabilityStore(appConfig.storageFile);
  const service = new AvailabilityService(store, appConfig);
  const bot = createBot(appConfig, service);

  await bot.launch();
  console.log('🚀 Simple availability bot запущено');

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

bootstrap().catch((error) => {
  console.error('Не вдалося запустити бота', error);
  process.exitCode = 1;
});
