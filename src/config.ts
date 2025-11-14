import dotenv from 'dotenv';

dotenv.config();

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) {
    return fallback;
  }
  return value.toLowerCase() === 'true';
};

export const config = {
  botToken: process.env.BOT_TOKEN || '',
  timeZone: process.env.TZ || 'Europe/Kyiv',
  adminCodes: (process.env.ADMIN_CODES || '14031995,svitlana2025,stanislav2025').split(','),
  adminTelegramIds: process.env.ADMIN_TELEGRAM_IDS
    ? process.env.ADMIN_TELEGRAM_IDS.split(',')
    : [],
  contacts: {
    svitlana: {
      name: process.env.PUBLIC_CONTACT_SVITLANA_NAME || 'Світлана',
      phone: process.env.PUBLIC_CONTACT_SVITLANA_PHONE || '+380000000000',
    },
    stanislav: {
      name: process.env.PUBLIC_CONTACT_STANISLAV_NAME || 'Станіслав',
      phone: process.env.PUBLIC_CONTACT_STANISLAV_PHONE || '+380000000000',
    },
  },
  workingDays: process.env.WORKING_DAYS || '1,2,3,4,5,6,7',
  dayOpenTime: process.env.DAY_OPEN_TIME || '09:00',
  dayCloseTime: process.env.DAY_CLOSE_TIME || '23:00',
  // Відповідно до правил: 2..6 год
  allowedDurations: process.env.ALLOWED_DURATIONS || '2,3,4,5,6',
  cleaningBufferMin: parseInt(process.env.CLEANING_BUFFER_MIN || '60', 10),
  apiPort: parseInt(process.env.API_PORT || '3000', 10),
  apiBasicToken: process.env.API_BASIC_TOKEN || 'supersecretapitoken',
  webhookUrl: process.env.WEBHOOK_URL || '',
  slotAggregationEnabled: parseBoolean(process.env.SLOT_AGGREGATION_ENABLED, true),
  bookedAsUnavailable: parseBoolean(process.env.BOOKED_AS_UNAVAILABLE, false),
};
