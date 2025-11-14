import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AvailabilitySlot } from '../types';

export class AvailabilityStore {
  private slots: AvailabilitySlot[] = [];
  private initialized = false;

  constructor(private readonly filePath: string) {}

  private async ensureLoaded(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      this.slots = JSON.parse(raw) as AvailabilitySlot[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.slots = [];
        await this.persist();
      } else {
        throw error;
      }
    }

    this.initialized = true;
  }

  private async persist(): Promise<void> {
    const payload = JSON.stringify(this.slots, null, 2);
    await fs.writeFile(this.filePath, payload, 'utf8');
  }

  async list(): Promise<AvailabilitySlot[]> {
    await this.ensureLoaded();
    return [...this.slots].sort((a, b) => {
      if (a.dateISO !== b.dateISO) {
        return a.dateISO.localeCompare(b.dateISO);
      }
      return a.startTime.localeCompare(b.startTime);
    });
  }

  async listByDate(dateISO: string): Promise<AvailabilitySlot[]> {
    const all = await this.list();
    return all.filter((slot) => slot.dateISO === dateISO);
  }

  async add(slot: AvailabilitySlot): Promise<void> {
    await this.ensureLoaded();
    this.slots.push(slot);
    await this.persist();
  }

  async remove(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const prevLength = this.slots.length;
    this.slots = this.slots.filter((slot) => slot.id !== id);
    if (this.slots.length !== prevLength) {
      await this.persist();
      return true;
    }
    return false;
  }

  async clearDay(dateISO: string): Promise<number> {
    await this.ensureLoaded();
    const before = this.slots.length;
    this.slots = this.slots.filter((slot) => slot.dateISO !== dateISO);
    if (before !== this.slots.length) {
      await this.persist();
    }
    return before - this.slots.length;
  }

  async setSlotsForDate(dateISO: string, slots: AvailabilitySlot[]): Promise<void> {
    await this.ensureLoaded();
    this.slots = this.slots.filter((slot) => slot.dateISO !== dateISO).concat(slots);
    await this.persist();
  }
}
