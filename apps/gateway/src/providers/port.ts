import type {
  ModelCapabilities,
  ModelConfig,
  ModelSelection,
  ProviderRecord,
} from '@jian/contracts';
import type { Queryable } from '../storage/database.js';
import type { ContextPolicy } from './service.js';

export interface ProviderAdmin {
  providers(): Promise<ProviderRecord[]>;
  configureCodexProvider(secret: string): Promise<ProviderRecord>;
}

export interface ProviderSelection {
  warmCatalog?(): Promise<void>;
  capabilities?(config: ModelConfig): Pick<ModelCapabilities, 'reasoningEfforts'>;
  selectedModel(
    selection: ModelSelection,
    reader: Queryable,
  ): Promise<{ config: ModelConfig; policy: ContextPolicy }>;
}
