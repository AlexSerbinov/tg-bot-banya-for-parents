export interface AvailabilitySlot {
  id: string;
  dateISO: string; // yyyy-MM-dd
  startTime: string; // HH:mm
  endTime: string; // HH:mm
  durationMinutes: number;
  createdBy: number;
  createdAt: string; // ISO string
  note?: string;
  chanAvailable: boolean;
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
}

export interface SlotCreationPayload {
  dateISO: string;
  startTime: string;
  endTime: string;
  note?: string;
  createdBy: number;
  chanAvailable?: boolean;
}
