import { Scenes } from 'telegraf';

export interface BotSession extends Scenes.WizardSessionData {
  mode?: 'client' | 'admin';
  awaitingBroadcast?: boolean;
  broadcastDraft?: string;
}

export type BotContext = Scenes.WizardContext<BotSession>;
