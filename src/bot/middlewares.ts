import { Context, Middleware } from 'telegraf';
import prisma from '../db/prismaClient';
import { config } from '../config';

export interface BotContext extends Context {
  session?: {
    isAdmin?: boolean;
    userId?: string;
    awaitingInput?: string;
    bookingData?: any;
    forceCustomerMode?: boolean; // Тимчасово працювати як клієнт
    awaitingComment?: boolean; // Очікується коментар до бронювання
    pendingRejectionBookingId?: string; // ID бронювання для відхилення
    broadcastMessage?: string; // Текст повідомлення для розсилки
    adminBookingData?: { // Дані для ручного додавання бронювання адміном
      dateISO?: string;
      duration?: number;
      time?: string;
      customerName?: string;
      customerPhone?: string;
    };
  };
}

// Simple in-memory session storage (for demo, use Redis in production)
const sessions = new Map<string, any>();

export function getSession(tgId: string) {
  if (!sessions.has(tgId)) {
    sessions.set(tgId, {});
  }
  return sessions.get(tgId);
}

export function setSession(tgId: string, data: any) {
  sessions.set(tgId, data);
}

export const sessionMiddleware: Middleware<BotContext> = async (ctx, next) => {
  const tgId = ctx.from?.id.toString();
  if (!tgId) return next();

  ctx.session = getSession(tgId);
  await next();
};

export const ensureUserMiddleware: Middleware<BotContext> = async (ctx, next) => {
  const tgId = ctx.from?.id.toString();
  if (!tgId) return next();

  let user = await prisma.user.findUnique({ where: { tgId } });

  if (!user) {
    user = await prisma.user.create({
      data: {
        tgId,
        role: 'CUSTOMER',
      },
    });
  }

  ctx.session!.userId = user.id;

  // Якщо увімкнений режим клієнта, примусово встановлюємо isAdmin = false
  if (ctx.session!.forceCustomerMode) {
    ctx.session!.isAdmin = false;
  } else {
    ctx.session!.isAdmin = user.role === 'ADMIN';
  }

  await next();
};

export async function checkAdminAccess(tgId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { tgId } });
  return user?.role === 'ADMIN';
}

export async function setAdminRole(tgId: string): Promise<void> {
  await prisma.user.upsert({
    where: { tgId },
    update: { role: 'ADMIN' },
    create: { tgId, role: 'ADMIN' },
  });
}

export function isValidAdminCode(code: string): boolean {
  return config.adminCodes.includes(code.trim());
}
