import type { ApiType, Model, Provider } from '../types';

export function parseKeyFile(text: string): string[];

export function buildEditedProvider(
  provider: Provider,
  fields: {
    name: string;
    baseUrl: string;
    apiType: ApiType;
    apiKeys: string[];
    models: Model[];
    clearSavedApiKeys?: boolean;
    quota?: { enabled: boolean; rpm: number | string; rpd: number | string };
  },
): Provider;
