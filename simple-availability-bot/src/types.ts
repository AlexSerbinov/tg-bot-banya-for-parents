export interface Booking {
  id: string;
  dateISO: string; // yyyy-MM-dd
  startTime: string; // HH:mm
  endTime: string; // HH:mm
  durationMinutes: number;
  createdBy: number;
  createdAt: string; // ISO string
  note?: string;
  withChan: boolean;
  chanAvailable?: boolean; // Alias для зворотної сумісності
}

export interface ScheduleSettings {
  timeZone: string;
  dayOpenTime: string;
  dayCloseTime: string;
  allowedDurationsHours: number[];
  slotStepMinutes: number;
  scheduleDays: number;
}

export interface AppConfig {
  botToken: string;
  adminIds: number[];
  storageFile: string;
  schedule: ScheduleSettings;
  contactMessage: string;
  userStorageFile: string;
  settingsStorageFile: string;
}

export interface BookingCreationPayload {
  dateISO: string;
  startTime: string;
  endTime: string;
  note?: string;
  createdBy: number;
  withChan?: boolean;
  chanAvailable?: boolean; // Alias для зворотної сумісності
  forceChan?: boolean; // Дозволити чан навіть якщо він вже зайнятий на інших бронюваннях
}

export interface BotSettings {
  clientInfoText: string;
}

// Alias для зворотної сумісності
export type AvailabilitySlot = Booking;
export type SlotCreationPayload = BookingCreationPayload;
