import { Scenes } from 'telegraf';

export interface BotSession extends Scenes.WizardSessionData {
  mode?: 'client' | 'admin';
}

export type BotContext = Scenes.WizardContext<BotSession>;
