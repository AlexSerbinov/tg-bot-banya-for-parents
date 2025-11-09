import { Markup } from 'telegraf';
import { formatDate, formatTime, dateToISO } from '../core/time';
import { Slot } from '../core/rules';

// Main menu keyboards
export function getMainMenuKeyboard() {
  return Markup.keyboard([
    ['📅 Переглянути вільні слоти'],
    ['📞 Контакти власників', '🔐 Вхід для адміністратора'],
  ])
    .resize()
    .persistent();
}

export function getAdminMenuKeyboard() {
  return Markup.keyboard([
    ['📋 Заявки (нові)', '➕ Додати бронювання'],
    ['📊 Список бронювань', '⚙️ Налаштування'],
    ['📢 Розсилка', '👤 Режим клієнта'],
  ])
    .resize()
    .persistent();
}

// Inline keyboards for date selection
export function getDateSelectionKeyboard(days: Date[], offset: number = 0, maxOffset: number = 4) {
  const tz = 'Europe/Kyiv';
  const buttons = days.map((day, index) => {
    const label = index === 0 && offset === 0 ? 'Сьогодні' : index === 1 && offset === 0 ? 'Завтра' : formatDate(day, tz);
    return [
      Markup.button.callback(
        label,
        `DATE:${dateToISO(day)}`
      ),
    ];
  });

  // Додаємо навігаційні кнопки
  const navRow = [];
  if (offset > 0) {
    navRow.push(
      Markup.button.callback('⬅️ Попередній тиждень', `DATES_WEEK|${offset - 1}`)
    );
  }
  if (offset < maxOffset) {
    navRow.push(
      Markup.button.callback('Наступний тиждень ➡️', `DATES_WEEK|${offset + 1}`)
    );
  }

  const rows = [...buttons];
  if (navRow.length > 0) {
    rows.push(navRow);
  }
  rows.push([Markup.button.callback('« Назад', 'BACK_TO_MAIN')]);

  return Markup.inlineKeyboard(rows);
}

// Duration selection
export function getDurationKeyboard(dateISO: string, durations: number[]) {
  const buttons = durations.map((dur) =>
    Markup.button.callback(`${dur} години`, `DUR:${dateISO}:${dur}`)
  );

  return Markup.inlineKeyboard([
    buttons,
    [Markup.button.callback('« Назад', 'BACK_TO_DATE')],
  ]);
}

// Slots selection
export function getSlotsKeyboard(
  slots: Slot[],
  dateISO: string,
  duration: number,
  tz: string,
  page: number = 0,
  perPage: number = 6
) {
  const start = page * perPage;
  const end = start + perPage;
  const pageSlots = slots.slice(start, end);

  const buttons = pageSlots.map((slot) => {
    const timeLabel = `${formatTime(slot.start, tz)} - ${formatTime(slot.end, tz)}`;
    return [
      Markup.button.callback(
        timeLabel,
        `SLOT|${dateISO}|${formatTime(slot.start, tz)}|${duration}`
      ),
    ];
  });

  const navButtons = [];
  if (page > 0) {
    navButtons.push(
      Markup.button.callback('◀️ Попередня', `PAGE:${dateISO}:${duration}:${page - 1}`)
    );
  }
  if (end < slots.length) {
    navButtons.push(
      Markup.button.callback('Наступна ▶️', `PAGE:${dateISO}:${duration}:${page + 1}`)
    );
  }

  return Markup.inlineKeyboard([
    ...buttons,
    navButtons.length > 0 ? navButtons : [],
    [Markup.button.callback('« Назад до тривалості', `DATE:${dateISO}`)],
  ]);
}

// Booking confirmation
export function getBookingConfirmKeyboard(
  dateISO: string,
  time: string,
  duration: number
) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        '✅ Підтвердити заявку',
        `CONFIRM_BOOKING|${dateISO}|${time}|${duration}`
      ),
    ],
    [
      Markup.button.callback(
        '💬 Залишити коментар',
        `ADD_COMMENT|${dateISO}|${time}|${duration}`
      ),
    ],
    [Markup.button.callback('« Назад', `DUR:${dateISO}:${duration}`)],
  ]);
}

// Booking submitted keyboard (for customer after submission)
export function getBookingSubmittedKeyboard(bookingId: string) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('🟢 🏠 Головне меню', 'BACK_TO_MAIN'),
    ],
    [
      Markup.button.callback('✏️ Редагувати заявку', `EDIT_BOOKING:${bookingId}`),
    ],
    [
      Markup.button.callback('❌ Скасувати заявку', `CANCEL_BOOKING:${bookingId}`),
    ],
  ]);
}

// Booking keyboard without main menu button (after returning to main menu)
export function getBookingKeyboard(bookingId: string) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✏️ Редагувати заявку', `EDIT_BOOKING:${bookingId}`),
    ],
    [
      Markup.button.callback('❌ Скасувати заявку', `CANCEL_BOOKING:${bookingId}`),
    ],
  ]);
}

// Booking keyboard with comment (shows "Change comment" instead of "Edit booking")
export function getBookingKeyboardWithComment(bookingId: string) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✏️ Змінити коментар', `EDIT_BOOKING:${bookingId}`),
    ],
    [
      Markup.button.callback('❌ Скасувати заявку', `CANCEL_BOOKING:${bookingId}`),
    ],
  ]);
}

// Admin approval keyboard
export function getApprovalKeyboard(bookingId: string) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Підтвердити', `APPROVE:${bookingId}`),
      Markup.button.callback('❌ Відхилити', `REJECT_ASK:${bookingId}`),
    ],
  ]);
}

// Rejection reason keyboard
export function getRejectionReasonKeyboard(bookingId: string) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        'Час вже зайнятий',
        `REJECT_REASON:${bookingId}:busy`
      ),
    ],
    [
      Markup.button.callback(
        'Технічні роботи',
        `REJECT_REASON:${bookingId}:maintenance`
      ),
    ],
    [
      Markup.button.callback(
        'Інша причина (ввести вручну)',
        `REJECT_CUSTOM:${bookingId}`
      ),
    ],
    [Markup.button.callback('« Назад', `BACK_TO_APPROVAL:${bookingId}`)],
  ]);
}

// Booking management keyboard
export function getBookingManagementKeyboard(bookingId: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('❌ Скасувати', `CANCEL:${bookingId}`)],
    [Markup.button.callback('« Назад', 'BACK_TO_BOOKINGS')],
  ]);
}

// Admin booking customer input keyboard
export function getAdminBookingCustomerKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📝 Ввести дані клієнта', 'ADMIN_INPUT_CUSTOMER')],
    [Markup.button.callback('✅ Підтвердити', 'ADMIN_CONFIRM_BOOKING')],
    [Markup.button.callback('❌ Скасувати', 'ADMIN_CANCEL')],
  ]);
}

// Admin booking phone input keyboard
export function getAdminBookingPhoneKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📞 Ввести телефон клієнта', 'ADMIN_INPUT_PHONE')],
    [Markup.button.callback('✅ Підтвердити бронювання', 'ADMIN_FINAL_CONFIRM')],
    [Markup.button.callback('❌ Скасувати', 'ADMIN_CANCEL')],
  ]);
}

// Contact buttons
export function getContactsKeyboard(svitlana: string, stanislav: string) {
  return Markup.inlineKeyboard([
    [Markup.button.url(`📞 Світлана`, `tel:${svitlana}`)],
    [Markup.button.url(`📞 Станіслав`, `tel:${stanislav}`)],
    [Markup.button.callback('« Назад', 'BACK_TO_MAIN')],
  ]);
}

// Phone request keyboard
export function getPhoneRequestKeyboard(dateISO: string, time: string, duration: number) {
  return Markup.keyboard([
    [Markup.button.contactRequest('📱 Поділитися контактом')],
    ['« Назад до вибору слотів'],
  ])
    .resize()
    .oneTime();
}

export function getScheduleNavigationKeyboard(offset: number, maxOffset: number = 4) {
  const navRow = [];
  if (offset > 0) {
    navRow.push(
      Markup.button.callback('⬅️ Попередній тиждень', `SCHEDULE_WEEK|${offset - 1}`)
    );
  }
  if (offset < maxOffset) {
    navRow.push(
      Markup.button.callback('Наступний тиждень ➡️', `SCHEDULE_WEEK|${offset + 1}`)
    );
  }

  const rows = [];
  if (navRow.length) {
    rows.push(navRow);
  }
  rows.push([Markup.button.callback('📅 Обрати дату', 'SHOW_DATES')]);
  rows.push([Markup.button.callback('« Назад', 'BACK_TO_MAIN')]);

  return Markup.inlineKeyboard(rows);
}

// Phone confirmation keyboard (for existing users)
export function getPhoneConfirmKeyboard(dateISO: string, time: string, duration: number) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        '✅ Залишити цей номер',
        `KEEP_PHONE|${dateISO}|${time}|${duration}`
      ),
    ],
    [
      Markup.button.callback(
        '📝 Ввести новий номер',
        `CHANGE_PHONE|${dateISO}|${time}|${duration}`
      ),
    ],
    [Markup.button.callback('« Назад', `DUR:${dateISO}:${duration}`)],
  ]);
}

// Broadcast confirmation keyboard
export function getBroadcastConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Відправити всім', 'BROADCAST_CONFIRM')],
    [Markup.button.callback('❌ Скасувати', 'BROADCAST_CANCEL')],
  ]);
}

// Admin manual booking keyboards
export function getAdminDateSelectionKeyboard(days: Date[], offset: number = 0, maxOffset: number = 4) {
  const tz = 'Europe/Kyiv';
  const buttons = days.map((day, index) => {
    const label = index === 0 && offset === 0 ? 'Сьогодні' : index === 1 && offset === 0 ? 'Завтра' : formatDate(day, tz);
    return [
      Markup.button.callback(
        label,
        `ADMIN_DATE:${dateToISO(day)}`
      ),
    ];
  });

  // Навігація
  const navRow = [];
  if (offset > 0) {
    navRow.push(
      Markup.button.callback('⬅️ Попередній тиждень', `ADMIN_DATES_WEEK|${offset - 1}`)
    );
  }
  if (offset < maxOffset) {
    navRow.push(
      Markup.button.callback('Наступний тиждень ➡️', `ADMIN_DATES_WEEK|${offset + 1}`)
    );
  }

  const rows = [...buttons];
  if (navRow.length > 0) {
    rows.push(navRow);
  }
  rows.push([Markup.button.callback('❌ Скасувати', 'ADMIN_CANCEL')]);

  return Markup.inlineKeyboard(rows);
}

export function getAdminDurationKeyboard(dateISO: string, durations: number[]) {
  const buttons = durations.map((dur) =>
    Markup.button.callback(`${dur} години`, `ADMIN_DUR:${dateISO}:${dur}`)
  );

  return Markup.inlineKeyboard([
    buttons,
    [Markup.button.callback('« Назад', `ADMIN_BACK_TO_DATE`)],
    [Markup.button.callback('❌ Скасувати', 'ADMIN_CANCEL')],
  ]);
}

export function getAdminTimeSelectionKeyboard(dateISO: string, duration: number) {
  // Генеруємо всі можливі часи з 09:00 до 22:00 з інтервалом 1 година
  const times = [];
  for (let hour = 9; hour <= 22 - duration; hour++) {
    const timeStr = `${hour.toString().padStart(2, '0')}:00`;
    const endHour = hour + duration;
    const endTimeStr = `${endHour.toString().padStart(2, '0')}:00`;
    times.push({
      label: `${timeStr} - ${endTimeStr}`,
      value: timeStr,
    });
  }

  const buttons = times.map((time) => [
    Markup.button.callback(time.label, `ADMIN_TIME:${dateISO}:${time.value}:${duration}`)
  ]);

  return Markup.inlineKeyboard([
    ...buttons,
    [Markup.button.callback('« Назад', `ADMIN_DATE:${dateISO}`)],
    [Markup.button.callback('❌ Скасувати', 'ADMIN_CANCEL')],
  ]);
}

export function getAdminBookingConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Підтвердити і створити', 'ADMIN_CONFIRM_CREATE')],
    [Markup.button.callback('« Назад', 'ADMIN_BACK_TO_PREVIOUS')],
    [Markup.button.callback('❌ Скасувати', 'ADMIN_CANCEL')],
  ]);
}
