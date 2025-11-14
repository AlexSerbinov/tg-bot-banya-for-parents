import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { AppConfig } from './types';

loadEnv();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is required`);
  }
  return value;
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseAdminIds(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number(part))
    .filter((id) => Number.isFinite(id));
}

const projectRoot = process.cwd();

export const appConfig: AppConfig = {
  botToken: requireEnv('BOT_TOKEN'),
  adminIds: parseAdminIds(process.env.ADMIN_IDS),
  storageFile: process.env.STORAGE_FILE ?? path.join(projectRoot, 'data', 'availability.json'),
  contactMessage:
    process.env.CONTACT_MESSAGE ??
    'Щоб записатися, напишіть адміну у Telegram або зателефонуйте нам напряму 📞',
  schedule: {
    timeZone: process.env.TIME_ZONE ?? 'Europe/Kyiv',
    dayOpenTime: process.env.DAY_OPEN_TIME ?? '09:00',
    dayCloseTime: process.env.DAY_CLOSE_TIME ?? '23:00',
    scheduleDays: parseNumber(process.env.SCHEDULE_DAYS, 7),
    slotStepMinutes: parseNumber(process.env.SLOT_STEP_MINUTES, 60),
    allowedDurationsHours: (process.env.ALLOWED_DURATIONS_HOURS ?? '2,3,4')
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
  },
};

if (!appConfig.adminIds.length) {
  console.warn('⚠️  No ADMIN_IDS provided. Only public features will be available.');
}
