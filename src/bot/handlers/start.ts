import { Telegraf } from 'telegraf';
import { BotContext, isValidAdminCode, setAdminRole, getSession, setSession } from '../middlewares';
import { getMainMenuKeyboard, getAdminMenuKeyboard } from '../keyboards';
import { getWelcomeMessage, getAdminWelcomeMessage } from '../../core/notifications';
import prisma from '../../db/prismaClient';

export function registerStartHandlers(bot: Telegraf<BotContext>) {
  bot.command('start', async (ctx) => {
    const tgId = ctx.from.id.toString();
    const args = ctx.message.text.split(' ').slice(1);

    // Check if admin code provided
    if (args.length > 0) {
      const code = args[0];
      if (isValidAdminCode(code)) {
        await setAdminRole(tgId);
        const session = getSession(tgId);
        session.isAdmin = true;
        session.forceCustomerMode = false; // Вимикаємо режим клієнта
        setSession(tgId, session);

        await ctx.reply(getAdminWelcomeMessage(), getAdminMenuKeyboard());
        return;
      } else {
        await ctx.reply('❌ Невірний код доступу');
      }
    }

    // Regular start - перевіряємо роль в базі
    const user = await prisma.user.findUnique({ where: { tgId } });
    const session = getSession(tgId);

    // Якщо користувач адмін в базі і не увімкнений режим клієнта
    if (user?.role === 'ADMIN' && !session.forceCustomerMode) {
      session.isAdmin = true;
      setSession(tgId, session);
      await ctx.reply(getAdminWelcomeMessage(), getAdminMenuKeyboard());
    } else {
      await ctx.reply(getWelcomeMessage(), getMainMenuKeyboard());
    }
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      `🔥 Допомога

📅 Переглянути вільні слоти - показує доступні часи для бронювання
📞 Контакти власників - телефони для зв'язку

Якщо у вас виникли питання, зв'яжіться з нами!`
    );
  });

  // Admin login button
  bot.hears('🔐 Вхід для адміністратора', async (ctx) => {
    const tgId = ctx.from.id.toString();

    // Перевіряємо чи користувач вже є адміном в базі
    const user = await prisma.user.findUnique({ where: { tgId } });

    if (user && user.role === 'ADMIN') {
      // Якщо вже адмін, просто вимикаємо режим клієнта
      const session = getSession(tgId);
      session.forceCustomerMode = false;
      session.isAdmin = true;
      setSession(tgId, session);

      await ctx.reply(getAdminWelcomeMessage(), getAdminMenuKeyboard());
      return;
    }

    // Якщо не адмін, запитуємо код
    const session = getSession(tgId);
    session.awaitingInput = 'admin_code';
    setSession(tgId, session);

    await ctx.reply('🔐 Введіть код доступу адміністратора:\n\n(Якщо не знаєте код - зверніться до власників)');
  });

  // Old admin login command (kept for compatibility)
  bot.hears('🔐 Увійти', async (ctx) => {
    const session = getSession(ctx.from.id.toString());
    session.awaitingInput = 'admin_code';
    setSession(ctx.from.id.toString(), session);

    await ctx.reply('Введіть код доступу:');
  });

  // Switch to customer mode
  bot.hears('👤 Режим клієнта', async (ctx) => {
    const tgId = ctx.from.id.toString();
    const session = getSession(tgId);
    session.forceCustomerMode = true;
    session.isAdmin = false;
    setSession(tgId, session);

    await ctx.reply(getWelcomeMessage(), getMainMenuKeyboard());
  });

  // Handle admin code input
  bot.on('text', async (ctx, next) => {
    const tgId = ctx.from.id.toString();
    const session = getSession(tgId);

    if (session.awaitingInput === 'admin_code') {
      const code = ctx.message.text;

      if (isValidAdminCode(code)) {
        await setAdminRole(tgId);
        session.isAdmin = true;
        session.forceCustomerMode = false; // Вимикаємо режим клієнта
        session.awaitingInput = undefined;
        setSession(tgId, session);

        await ctx.reply('✅ Успішний вхід!', getAdminMenuKeyboard());
      } else {
        await ctx.reply('❌ Невірний код доступу. Спробуйте ще раз або натисніть /start');
        session.awaitingInput = undefined;
        setSession(tgId, session);
      }
      return;
    }

    await next();
  });
}
