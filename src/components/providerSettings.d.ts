import type { ApiType, Model, Provider } from '../types';

export function buildEditedProvider(
  provider: Provider,
  fields: {
    name: string;
    baseUrl: string;
    apiType: ApiType;
    apiKey: string;
    models: Model[];
    clearSavedApiKey?: boolean;
  },
): Provider;
