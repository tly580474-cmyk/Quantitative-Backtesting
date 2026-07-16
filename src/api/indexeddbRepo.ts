import type { IDataRepository } from './repository';
import * as marketRepo from '@/db/marketDataRepository';
import * as strategyRepo from '@/db/strategyRepository';
import * as resultRepo from '@/db/resultRepository';
import * as visualRepo from '@/db/visualStrategyRepository';

export const INDEXEDDB_READONLY_ERROR =
  'IndexedDB 当前仅作为历史数据只读迁移源，禁止新增、修改或删除。'
  + '请先导出迁移工作簿，再切换到 MySQL/API 完成导入。';

export function rejectIndexedDbMutation(): Promise<never> {
  return Promise.reject(new Error(INDEXEDDB_READONLY_ERROR));
}

export class IndexedDBRepository implements IDataRepository {
  getSource(): 'indexeddb' { return 'indexeddb'; }
  async isAvailable(): Promise<boolean> { return true; }

  async getDatasets() { return marketRepo.getDatasets(); }
  async getDataset(id: string) { return marketRepo.getDataset(id); }
  async saveDataset(_dataset: never, _candles: never[]) { return rejectIndexedDbMutation(); }
  async deleteDataset(_id: string) { return rejectIndexedDbMutation(); }
  async getCandlesByDataset(datasetId: string) { return marketRepo.getCandlesByDataset(datasetId); }
  async findDuplicateByChecksum(checksum: string) { return marketRepo.findDuplicateByChecksum(checksum); }
  async datasetExists(id: string) { return marketRepo.datasetExists(id); }

  async getStrategyConfigs() { return strategyRepo.getStrategyConfigs(); }
  async saveStrategyConfig(_config: never) { return rejectIndexedDbMutation(); }
  async getStrategyConfig(id: string) { return strategyRepo.getStrategyConfig(id); }
  async deleteStrategyConfig(_id: string) { return rejectIndexedDbMutation(); }

  async getResults() { return resultRepo.getResults(); }
  async getResult(id: string) { return resultRepo.getResult(id); }
  async saveResult(_result: never, _equityCurve: never[]) { return rejectIndexedDbMutation(); }
  async deleteResult(_id: string) { return rejectIndexedDbMutation(); }
  async deleteResults(_ids: string[]) { return rejectIndexedDbMutation(); }
  async getEquityPoints(resultId: string) { return resultRepo.getEquityPoints(resultId); }

  async getAllVisualStrategies() { return visualRepo.getAllVisualStrategies(); }
  async getVisualStrategyById(id: string) { return visualRepo.getVisualStrategyById(id); }
  async saveVisualStrategy(_strategy: never) { return rejectIndexedDbMutation(); }
  async deleteVisualStrategy(_id: string) { return rejectIndexedDbMutation(); }
  async publishVisualStrategy(_id: string, _document: never) { return rejectIndexedDbMutation(); }
  async getVersionsForStrategy(strategyId: string) { return visualRepo.getVersionsForStrategy(strategyId); }
  async getStrategyVersion(strategyId: string, version: number) { return visualRepo.getStrategyVersion(strategyId, version); }
  async saveDraft(_draft: never) { return rejectIndexedDbMutation(); }
  async getDraftForStrategy(strategyId: string) { return visualRepo.getDraftForStrategy(strategyId); }
  async deleteDraft(_strategyId: string) { return rejectIndexedDbMutation(); }
}
