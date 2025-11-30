import { promises as fs } from 'node:fs';
import { BotSettings } from '../types';

const DEFAULT_CLIENT_INFO_TEXT = `Ласкаво просимо до нашої бані в Болотні! 🌿

🔥 Тарифи:
• Баня — 500 грн/год
• Мінімальний час бронювання — 2 години
• Чан — +1000 грн одноразово (незалежно від того, на скільки годин ви бронюєте баню)

📅 Бронювання часу
Нижче ви побачите наш графік вільних годин.
Усі години автоматично вважаються зайнятими, окрім тих, які ми спеціально відкрили як вільні для бронювання.

⚡ Світло та генератор
Ми працюємо навіть у разі відключення світла — у нас є генератор.
Якщо немає світла, додається 100 грн/год за використання генератора.

🍖 Мангал
За вашим бажанням можемо розпалити мангал — 100 грн.

📍 Як нас знайти
с Болотня, вул Богдана Хмельницького 139 (Великі металеві зелені ворота)
Показати локацію на Google Maps https://maps.app.goo.gl/QM479qdn33iQBVBh9

📞 Контакти власників
• Світлана  —  +380673909067
• Станіслав — +380973879204

Чекаємо на вас у нашій бані для теплого відпочинку! 🧖‍♂️🧖‍♀️🔥`;

export class SettingsStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<BotSettings> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      // Якщо файл не існує, повертаємо дефолтні налаштування
      const defaultSettings: BotSettings = {
        clientInfoText: DEFAULT_CLIENT_INFO_TEXT,
      };
      await this.save(defaultSettings);
      return defaultSettings;
    }
  }

  async save(settings: BotSettings): Promise<void> {
    await fs.writeFile(this.filePath, JSON.stringify(settings, null, 2), 'utf-8');
  }

  async updateClientInfoText(text: string): Promise<void> {
    const settings = await this.load();
    settings.clientInfoText = text;
    await this.save(settings);
  }

  async getClientInfoText(): Promise<string> {
    const settings = await this.load();
    return settings.clientInfoText;
  }

  async getShowUnavailableSlots(): Promise<boolean> {
    const settings = await this.load();
    return settings.showUnavailableSlots ?? true; // default: true
  }

  async setShowUnavailableSlots(value: boolean): Promise<void> {
    const settings = await this.load();
    settings.showUnavailableSlots = value;
    await this.save(settings);
  }

  async toggleShowUnavailableSlots(): Promise<boolean> {
    const current = await this.getShowUnavailableSlots();
    const newValue = !current;
    await this.setShowUnavailableSlots(newValue);
    return newValue;
  }
}
