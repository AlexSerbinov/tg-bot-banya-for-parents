import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface UserRecord {
  tgId: number;
  firstName?: string;
  lastName?: string;
  username?: string;
  joinedAt: string;
}

export class UserStore {
  private users: UserRecord[] = [];
  private initialized = false;

  constructor(private readonly filePath: string) {}

  private async ensureLoaded() {
    if (this.initialized) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      this.users = JSON.parse(raw) as UserRecord[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.users = [];
        await this.persist();
      } else {
        throw error;
      }
    }
    this.initialized = true;
  }

  private async persist() {
    await fs.writeFile(this.filePath, JSON.stringify(this.users, null, 2), 'utf8');
  }

  async addUser(record: { tgId: number; firstName?: string; lastName?: string; username?: string }) {
    await this.ensureLoaded();
    if (this.users.some((user) => user.tgId === record.tgId)) {
      return;
    }
    this.users.push({
      tgId: record.tgId,
      firstName: record.firstName,
      lastName: record.lastName,
      username: record.username,
      joinedAt: new Date().toISOString(),
    });
    await this.persist();
  }

  async list(): Promise<UserRecord[]> {
    await this.ensureLoaded();
    return [...this.users];
  }

  async count(): Promise<number> {
    await this.ensureLoaded();
    return this.users.length;
  }
}
