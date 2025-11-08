import { Booking } from '@prisma/client';
import { formatDateTime } from './time';
import { config } from '../config';

export function getBookingRequestMessage(
  booking: Booking,
  tz: string
): string {
  const dateTime = formatDateTime(booking.dateStart, tz);
  const duration = Math.floor(booking.durationMin / 60);

  let message = `🆕 Нова заявка

📅 Дата: ${dateTime}
⏱ Тривалість: ${duration} год
👤 Клієнт: ${booking.customerName || 'Не вказано'}
📞 Телефон: ${booking.customerPhone || 'Не вказано'}`;

  if (booking.note) {
    message += `\n💬 Коментар: ${booking.note}`;
  }

  message += `\n\nОберіть дію:`;

  return message;
}

export function getBookingConfirmedMessage(
  booking: Booking,
  tz: string
): string {
  const dateTime = formatDateTime(booking.dateStart, tz);
  const duration = Math.floor(booking.durationMin / 60);

  return `✅ Підтверджено!

Чекаємо на вас:
📅 ${dateTime}
⏱ Тривалість: ${duration} год

До зустрічі! 🔥`;
}

export function getBookingRejectedMessage(booking: Booking): string {
  return `❌ На жаль, цей час недоступний.

Будь ласка, оберіть інший слот або зателефонуйте нам:
📞 ${config.contacts.svitlana.name}: ${config.contacts.svitlana.phone}
📞 ${config.contacts.stanislav.name}: ${config.contacts.stanislav.phone}`;
}

export function getBookingPendingMessage(
  booking: Booking,
  tz: string
): string {
  const dateTime = formatDateTime(booking.dateStart, tz);
  const duration = Math.floor(booking.durationMin / 60);

  return `📝 Заявку надіслано!

📅 Дата: ${dateTime}
⏱ Тривалість: ${duration} год

⏳ Очікуйте підтвердження від адміністратора.`;
}

export function getContactsMessage(): string {
  return `📞 Контакти власників:

${config.contacts.svitlana.name}: ${config.contacts.svitlana.phone}
${config.contacts.stanislav.name}: ${config.contacts.stanislav.phone}

Дзвоніть у будь-який час!`;
}

export function getWelcomeMessage(): string {
  return `🔥 Вітаємо у «Баня»!

Тут ви можете:
• Переглянути вільні слоти
• Забронювати зручний час
• Зв'язатися з власниками

Оберіть дію:`;
}

export function getAdminWelcomeMessage(): string {
  return `🔐 Адміністраторська панель

Оберіть дію:`;
}
