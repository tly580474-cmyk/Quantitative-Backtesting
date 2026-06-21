import { DATA_SOURCE } from './config';
import { IndexedDBRepository } from './indexeddbRepo';
import { ApiRepository } from './apiRepo';
import type { IDataRepository } from './repository';

let instance: IDataRepository | null = null;

export function getRepository(): IDataRepository {
  if (!instance) {
    instance = DATA_SOURCE === 'api' ? new ApiRepository() : new IndexedDBRepository();
  }
  return instance;
}

export function useRepository(): IDataRepository {
  return getRepository();
}
