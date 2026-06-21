declare global {
  interface ImportMetaEnv {
    VITE_DATA_SOURCE?: string;
    VITE_API_URL?: string;
  }
}

export const DATA_SOURCE: 'indexeddb' | 'api' =
  import.meta.env.VITE_DATA_SOURCE === 'api' ? 'api' : 'indexeddb';

export const API_BASE_URL: string =
  import.meta.env.VITE_API_URL ?? 'http://localhost:3001';
