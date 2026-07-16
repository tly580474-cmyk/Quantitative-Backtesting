declare global {
  interface ImportMetaEnv {
    VITE_DATA_SOURCE?: string;
    VITE_ALLOW_INDEXEDDB_MIGRATION?: string;
    VITE_API_URL?: string;
  }
}

const requestedDataSource = import.meta.env.VITE_DATA_SOURCE?.trim().toLowerCase() || 'api';
const allowIndexedDbMigration =
  import.meta.env.VITE_ALLOW_INDEXEDDB_MIGRATION?.trim().toLowerCase() === 'true';

if (requestedDataSource !== 'api' && requestedDataSource !== 'indexeddb') {
  throw new Error(`不支持的数据源 VITE_DATA_SOURCE=${requestedDataSource}，仅允许 api 或 indexeddb。`);
}

if (requestedDataSource === 'indexeddb' && !allowIndexedDbMigration) {
  throw new Error(
    'IndexedDB 仅允许用于只读迁移。请同时设置 VITE_ALLOW_INDEXEDDB_MIGRATION=true，'
    + '完成导出后立即恢复 VITE_DATA_SOURCE=api。',
  );
}

export const DATA_SOURCE: 'indexeddb' | 'api' = requestedDataSource;
export const INDEXEDDB_MIGRATION_MODE = DATA_SOURCE === 'indexeddb';

export const API_BASE_URL: string =
  import.meta.env.VITE_API_URL ?? 'http://localhost:3001';
