import { Telegraf } from 'telegraf';
import { config } from './config';
import { sessionMiddleware, ensureUserMiddleware } from './bot/middlewares';
import { registerStartHandlers } from './bot/handlers/start';
import { registerCustomerHandlers } from './bot/handlers/customer';
import { registerAdminHandlers } from './bot/handlers/admin';

async function main() {
  console.log('🚀 Starting Telegram Banya Bot...');

  if (!config.botToken) {
    console.error('❌ BOT_TOKEN is not set in environment variables');
    process.exit(1);
  }

  const bot = new Telegraf(config.botToken);

  // Middlewares
  bot.use(sessionMiddleware);
  bot.use(ensureUserMiddleware);

  // Register handlers
  console.log('📝 Registering handlers...');
  registerStartHandlers(bot);
  console.log('✅ Start handlers registered');
  registerCustomerHandlers(bot);
  console.log('✅ Customer handlers registered');
  registerAdminHandlers(bot);
  console.log('✅ Admin handlers registered');

  // Error handling
  bot.catch((err, ctx) => {
    console.error('❌ Bot error:', err);
    ctx.reply('Вибачте, сталася помилка. Спробуйте ще раз або зв\'яжіться з адміністратором.');
  });

  // Start bot
  if (config.webhookUrl) {
    console.log('🌐 Starting with webhook:', config.webhookUrl);
    await bot.launch({
      webhook: {
        domain: config.webhookUrl,
        port: config.apiPort,
      },
    });
  } else {
    console.log('📡 Starting with long polling...');
    await bot.launch();
  }

  console.log('✅ Bot started successfully!');
  console.log(`👤 Bot username: @${bot.botInfo?.username}`);

  // Enable graceful stop
  process.once('SIGINT', () => {
    console.log('Stopping bot...');
    bot.stop('SIGINT');
  });
  process.once('SIGTERM', () => {
    console.log('Stopping bot...');
    bot.stop('SIGTERM');
  });
}

main().catch((error) => {
  console.error('❌ Failed to start bot:', error);
  process.exit(1);
});
