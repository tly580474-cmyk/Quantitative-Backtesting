import { create } from 'zustand';
import type { DatasetAssetType } from '@/features/dataLibrary/datasetAssetType';

interface DataLibraryViewState {
  activeType: DatasetAssetType;
  search: string;
  stockPage: number;
  stockPageSize: number;
  selectedIndustry: string;
  excludeDelisted: boolean;
  excludeSt: boolean;
  scrollTop: number;
  setActiveType: (activeType: DatasetAssetType) => void;
  setSearch: (search: string) => void;
  setStockPage: (stockPage: number) => void;
  setStockPageSize: (stockPageSize: number) => void;
  setSelectedIndustry: (selectedIndustry: string) => void;
  setExcludeDelisted: (excludeDelisted: boolean) => void;
  setExcludeSt: (excludeSt: boolean) => void;
  setScrollTop: (scrollTop: number) => void;
}

export const useDataLibraryViewStore = create<DataLibraryViewState>((set) => ({
  activeType: 'index',
  search: '',
  stockPage: 1,
  stockPageSize: 20,
  selectedIndustry: 'all',
  excludeDelisted: true,
  excludeSt: true,
  scrollTop: 0,
  setActiveType: (activeType) => set({ activeType }),
  setSearch: (search) => set({ search }),
  setStockPage: (stockPage) => set({ stockPage }),
  setStockPageSize: (stockPageSize) => set({ stockPageSize }),
  setSelectedIndustry: (selectedIndustry) => set({ selectedIndustry }),
  setExcludeDelisted: (excludeDelisted) => set({ excludeDelisted }),
  setExcludeSt: (excludeSt) => set({ excludeSt }),
  setScrollTop: (scrollTop) => set({ scrollTop }),
}));
