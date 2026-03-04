import type { Plugin } from '../../core/plugin';
import { closeDatabase } from './client';

export class DatabasePlugin implements Plugin {
  name = 'database-plugin';

  async setup(_app: any) {
    console.warn('[Database] 本地 SQLite 插件已禁用。请使用云端数据库。');
  }

  async stop() {
    console.log('[Database] Closing connection...');
    await closeDatabase();
  }
}
