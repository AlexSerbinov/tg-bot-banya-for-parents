import { appConfig } from './config';
import { AvailabilityStore } from './storage/availabilityStore';
import { AvailabilityService } from './services/availabilityService';
import { createBot } from './bot';
import { UserStore } from './storage/userStore';
import { SettingsStore } from './storage/settingsStore';

async function bootstrap() {
  const store = new AvailabilityStore(appConfig.storageFile);
  const service = new AvailabilityService(store, appConfig);
  const userStore = new UserStore(appConfig.userStorageFile);
  const settingsStore = new SettingsStore(appConfig.settingsStorageFile);
  const bot = createBot(appConfig, service, userStore, settingsStore);

  // Встановлюємо опис бота (показується перед натисканням START)
  try {
    await bot.telegram.setMyDescription(
      'Ласкаво просимо до нашої бані та чану в Болотні 🌿\n' +
      'Тут ви зможете подивитися вільні години та забронювати баню й чан.'
    );
    console.log('✅ Опис бота встановлено');
  } catch (error) {
    console.error('⚠️ Не вдалося встановити опис бота:', error);
  }

  await bot.launch();
  console.log('🚀 Simple availability bot запущено');

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

bootstrap().catch((error) => {
  console.error('Не вдалося запустити бота', error);
  process.exitCode = 1;
});
