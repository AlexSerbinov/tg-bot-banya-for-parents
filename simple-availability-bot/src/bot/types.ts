import { Scenes } from 'telegraf';

export interface BotSession extends Scenes.WizardSessionData {
  mode?: 'client' | 'admin';
  awaitingBroadcast?: boolean;
  broadcastDraft?: string;
  scheduleWeekOffset?: number;
  editingSettings?: 'clientInfoText';
}

export type BotContext = Scenes.WizardContext<BotSession>;
