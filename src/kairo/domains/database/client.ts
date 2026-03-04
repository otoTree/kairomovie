const LOCAL_DATABASE_REMOVED_MESSAGE =
  'Kairo local SQLite 特性已移除。请改用云端数据库实现。'

let dbInstance: any | null = null

export function bindDatabase(database: any) {
  dbInstance = database
}

export function getDatabase(): any {
  if (!dbInstance) {
    throw new Error(LOCAL_DATABASE_REMOVED_MESSAGE)
  }
  return dbInstance
}

export function initDatabase(_dbPath: string): never {
  throw new Error(LOCAL_DATABASE_REMOVED_MESSAGE)
}

export async function closeDatabase() {
  if (dbInstance && typeof dbInstance.destroy === 'function') {
    await dbInstance.destroy()
  }
  dbInstance = null
}
