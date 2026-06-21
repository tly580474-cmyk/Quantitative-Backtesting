import type { IDataRepository } from './repository';
import * as marketRepo from '@/db/marketDataRepository';
import * as strategyRepo from '@/db/strategyRepository';
import * as resultRepo from '@/db/resultRepository';
import * as visualRepo from '@/db/visualStrategyRepository';

export class IndexedDBRepository implements IDataRepository {
  getSource(): 'indexeddb' { return 'indexeddb'; }
  async isAvailable(): Promise<boolean> { return true; }

  async getDatasets() { return marketRepo.getDatasets(); }
  async getDataset(id: string) { return marketRepo.getDataset(id); }
  async saveDataset(dataset: never, candles: never[]) { return marketRepo.saveDataset(dataset, candles); }
  async deleteDataset(id: string) { return marketRepo.deleteDataset(id); }
  async getCandlesByDataset(datasetId: string) { return marketRepo.getCandlesByDataset(datasetId); }
  async findDuplicateByChecksum(checksum: string) { return marketRepo.findDuplicateByChecksum(checksum); }
  async datasetExists(id: string) { return marketRepo.datasetExists(id); }

  async getStrategyConfigs() { return strategyRepo.getStrategyConfigs(); }
  async saveStrategyConfig(config: never) { return strategyRepo.saveStrategyConfig(config); }
  async getStrategyConfig(id: string) { return strategyRepo.getStrategyConfig(id); }
  async deleteStrategyConfig(id: string) { return strategyRepo.deleteStrategyConfig(id); }

  async getResults() { return resultRepo.getResults(); }
  async getResult(id: string) { return resultRepo.getResult(id); }
  async saveResult(result: never, equityCurve: never[]) { return resultRepo.saveResult(result, equityCurve); }
  async deleteResult(id: string) { return resultRepo.deleteResult(id); }
  async deleteResults(ids: string[]) { return resultRepo.deleteResults(ids); }
  async getEquityPoints(resultId: string) { return resultRepo.getEquityPoints(resultId); }

  async getAllVisualStrategies() { return visualRepo.getAllVisualStrategies(); }
  async getVisualStrategyById(id: string) { return visualRepo.getVisualStrategyById(id); }
  async saveVisualStrategy(strategy: never) { return visualRepo.saveVisualStrategy(strategy); }
  async deleteVisualStrategy(id: string) { return visualRepo.deleteVisualStrategy(id); }
  async publishVisualStrategy(id: string, document: never) { return visualRepo.publishVisualStrategy(id, document); }
  async getVersionsForStrategy(strategyId: string) { return visualRepo.getVersionsForStrategy(strategyId); }
  async getStrategyVersion(strategyId: string, version: number) { return visualRepo.getStrategyVersion(strategyId, version); }
  async saveDraft(draft: never) { return visualRepo.saveDraft(draft); }
  async getDraftForStrategy(strategyId: string) { return visualRepo.getDraftForStrategy(strategyId); }
  async deleteDraft(strategyId: string) { return visualRepo.deleteDraft(strategyId); }
}
