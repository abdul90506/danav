import React, { useState } from 'react';
import {
  X,
  Sun,
  Moon,
  Monitor,
  Plus,
  Trash2,
  Edit2,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Key,
  Globe,
  Eye,
  EyeOff,
  Layers,
  Brain,
  Check,
  Search,
} from 'lucide-react';
import { ApiType, Model, Provider, Theme } from '../types';
import { fetchProviderModels, testProviderConnection } from '../services/api';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  providers: Provider[];
  onSaveProviders: (providers: Provider[]) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  theme,
  onThemeChange,
  providers,
  onSaveProviders,
}) => {
  const [activeTab, setActiveTab] = useState<'appearance' | 'providers'>('appearance');

  // Provider Form State
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);

  // Form Fields
  const [formName, setFormName] = useState('');
  const [formBaseUrl, setFormBaseUrl] = useState('');
  const [formApiKey, setFormApiKey] = useState('');
  const [formApiType, setFormApiType] = useState<ApiType>('openai');
  const [formModels, setFormModels] = useState<Model[]>([]);

  // Fetched models selection state (checkbox picker)
  const [fetchedCandidateModels, setFetchedCandidateModels] = useState<Model[]>([]);
  const [selectedCandidateModelIds, setSelectedCandidateModelIds] = useState<Set<string>>(new Set());
  const [isModelPickerOpen, setIsModelPickerOpen] = useState(false);
  const [modelFilterQuery, setModelFilterQuery] = useState('');

  // Testing & Fetching state
  const [testingStatus, setTestingStatus] = useState<{
    loading: boolean;
    success?: boolean;
    message?: string;
  }>({ loading: false });

  const [fetchingStatus, setFetchingStatus] = useState<{
    loading: boolean;
    success?: boolean;
    message?: string;
  }>({ loading: false });

  if (!isOpen) return null;

  const startAddNewProvider = () => {
    setIsAddingNew(true);
    setEditingProviderId(null);
    setFormName('');
    setFormBaseUrl('https://vyceai.com/v1');
    setFormApiKey('');
    setFormApiType('openai');
    setFormModels([]);
    setFetchedCandidateModels([]);
    setSelectedCandidateModelIds(new Set());
    setIsModelPickerOpen(false);
    setModelFilterQuery('');
    setTestingStatus({ loading: false });
    setFetchingStatus({ loading: false });
  };

  const startEditProvider = (p: Provider) => {
    setEditingProviderId(p.id);
    setIsAddingNew(false);
    setFormName(p.name);
    setFormBaseUrl(p.baseUrl);
    setFormApiKey(p.apiKey || '');
    setFormApiType(p.apiType);
    setFormModels(p.models || []);
    setFetchedCandidateModels(p.models || []);
    setSelectedCandidateModelIds(new Set((p.models || []).map((m) => m.id)));
    setIsModelPickerOpen(false);
    setModelFilterQuery('');
    setTestingStatus({ loading: false });
    setFetchingStatus({ loading: false });
  };

  const cancelProviderForm = () => {
    setIsAddingNew(false);
    setEditingProviderId(null);
    setIsModelPickerOpen(false);
    setTestingStatus({ loading: false });
    setFetchingStatus({ loading: false });
  };

  const handleTestConnection = async () => {
    setTestingStatus({ loading: true });
    const result = await testProviderConnection({
      baseUrl: formBaseUrl,
      apiKey: formApiKey,
      apiType: formApiType,
    });
    setTestingStatus({
      loading: false,
      success: result.success,
      message: result.success ? result.message : result.error,
    });
  };

  const handleFetchModels = async () => {
    setFetchingStatus({ loading: true });
    const providerId = editingProviderId || `provider-${Date.now()}`;
    const result = await fetchProviderModels({
      id: providerId,
      baseUrl: formBaseUrl,
      apiKey: formApiKey,
      apiType: formApiType,
    });

    if (result.success && result.models) {
      setFetchedCandidateModels(result.models);

      // Pre-select models that are already added, or all if none
      const existingIds = new Set(formModels.map((m) => m.id));
      let initialSelected: Set<string>;
      if (existingIds.size > 0) {
        initialSelected = new Set(
          result.models.filter((m) => existingIds.has(m.id)).map((m) => m.id)
        );
        if (initialSelected.size === 0) {
          initialSelected = new Set(result.models.map((m) => m.id));
        }
      } else {
        initialSelected = new Set(result.models.map((m) => m.id));
      }

      setSelectedCandidateModelIds(initialSelected);
      setIsModelPickerOpen(true);

      setFetchingStatus({
        loading: false,
        success: true,
        message: `Found ${result.models.length} model(s). Tick the models you want to add below.`,
      });
    } else {
      setFetchingStatus({
        loading: false,
        success: false,
        message: result.error || 'Failed to fetch models',
      });
    }
  };

  const toggleModelCheck = (id: string) => {
    setSelectedCandidateModelIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSelectAllCandidateModels = () => {
    setSelectedCandidateModelIds(new Set(fetchedCandidateModels.map((m) => m.id)));
  };

  const handleDeselectAllCandidateModels = () => {
    setSelectedCandidateModelIds(new Set());
  };

  const handleApplySelectedModels = () => {
    const selected = fetchedCandidateModels.filter((m) =>
      selectedCandidateModelIds.has(m.id)
    );
    setFormModels(selected);
    setIsModelPickerOpen(false);
  };

  const handleRemoveSingleModel = (id: string) => {
    setFormModels((prev) => prev.filter((m) => m.id !== id));
  };

  const handleSaveProvider = () => {
    if (!formName.trim() || !formBaseUrl.trim()) return;

    if (isAddingNew) {
      const newProvider: Provider = {
        id: `provider-${Date.now()}`,
        name: formName.trim(),
        baseUrl: formBaseUrl.trim(),
        apiKey: formApiKey.trim(),
        apiType: formApiType,
        isCustom: true,
        enabled: true,
        models:
          formModels.length > 0
            ? formModels
            : [
                {
                  id: 'default-model',
                  name: `${formName.trim()} Default`,
                  providerId: `provider-${Date.now()}`,
                },
              ],
      };
      onSaveProviders([...providers, newProvider]);
    } else if (editingProviderId) {
      const updated = providers.map((p) => {
        if (p.id === editingProviderId) {
          return {
            ...p,
            name: formName.trim(),
            baseUrl: formBaseUrl.trim(),
            apiKey: formApiKey.trim(),
            apiType: formApiType,
            models: formModels.map((m) => ({ ...m, providerId: p.id })),
          };
        }
        return p;
      });
      onSaveProviders(updated);
    }

    cancelProviderForm();
  };

  const handleDeleteProvider = (providerId: string) => {
    const updated = providers.filter((p) => p.id !== providerId);
    onSaveProviders(updated);
    if (editingProviderId === providerId) {
      cancelProviderForm();
    }
  };

  const handleQuickRefreshProviderModels = async (p: Provider) => {
    const result = await fetchProviderModels(p);
    if (result.success && result.models) {
      const updated = providers.map((item) =>
        item.id === p.id ? { ...item, models: result.models! } : item
      );
      onSaveProviders(updated);
    }
  };

  // Filtered candidate models in picker
  const filteredCandidates = fetchedCandidateModels.filter((m) =>
    m.id.toLowerCase().includes(modelFilterQuery.toLowerCase()) ||
    (m.name && m.name.toLowerCase().includes(modelFilterQuery.toLowerCase()))
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-900/40 backdrop-blur-sm animate-in fade-in duration-150">
      <div
        className="w-full max-w-2xl bg-white dark:bg-zinc-900 rounded-2xl shadow-xl border border-zinc-200 dark:border-zinc-800 flex flex-col overflow-hidden max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200/80 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
              Settings
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex px-6 pt-3 border-b border-zinc-200/60 dark:border-zinc-800 gap-4 text-xs font-medium">
          <button
            onClick={() => {
              setActiveTab('appearance');
              cancelProviderForm();
            }}
            className={`pb-2.5 transition-colors border-b-2 ${
              activeTab === 'appearance'
                ? 'border-zinc-900 dark:border-zinc-100 text-zinc-900 dark:text-zinc-100 font-semibold'
                : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-300'
            }`}
          >
            Appearance
          </button>
          <button
            onClick={() => setActiveTab('providers')}
            className={`pb-2.5 transition-colors border-b-2 ${
              activeTab === 'providers'
                ? 'border-zinc-900 dark:border-zinc-100 text-zinc-900 dark:text-zinc-100 font-semibold'
                : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-300'
            }`}
          >
            Providers & Models
          </button>
        </div>

        {/* Modal Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* TAB 1: APPEARANCE */}
          {activeTab === 'appearance' && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                  Theme
                </label>
                <p className="text-xs text-zinc-500 mb-3">
                  Choose your interface appearance. Default is Light.
                </p>

                <div className="grid grid-cols-3 gap-3">
                  <button
                    onClick={() => onThemeChange('light')}
                    className={`flex flex-col items-center justify-center p-4 rounded-xl border text-xs font-medium transition-all ${
                      theme === 'light'
                        ? 'border-zinc-900 dark:border-zinc-100 bg-zinc-50 dark:bg-zinc-800/80 text-zinc-900 dark:text-white ring-1 ring-zinc-900 dark:ring-zinc-100'
                        : 'border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 text-zinc-600 dark:text-zinc-400'
                    }`}
                  >
                    <Sun className="w-5 h-5 mb-2 text-amber-500" />
                    <span>Light</span>
                  </button>

                  <button
                    onClick={() => onThemeChange('dark')}
                    className={`flex flex-col items-center justify-center p-4 rounded-xl border text-xs font-medium transition-all ${
                      theme === 'dark'
                        ? 'border-zinc-900 dark:border-zinc-100 bg-zinc-50 dark:bg-zinc-800/80 text-zinc-900 dark:text-white ring-1 ring-zinc-900 dark:ring-zinc-100'
                        : 'border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 text-zinc-600 dark:text-zinc-400'
                    }`}
                  >
                    <Moon className="w-5 h-5 mb-2 text-indigo-400" />
                    <span>Dark</span>
                  </button>

                  <button
                    onClick={() => onThemeChange('system')}
                    className={`flex flex-col items-center justify-center p-4 rounded-xl border text-xs font-medium transition-all ${
                      theme === 'system'
                        ? 'border-zinc-900 dark:border-zinc-100 bg-zinc-50 dark:bg-zinc-800/80 text-zinc-900 dark:text-white ring-1 ring-zinc-900 dark:ring-zinc-100'
                        : 'border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 text-zinc-600 dark:text-zinc-400'
                    }`}
                  >
                    <Monitor className="w-5 h-5 mb-2 text-zinc-400" />
                    <span>System</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: PROVIDERS & MODELS */}
          {activeTab === 'providers' && (
            <div className="space-y-5">
              {!isAddingNew && !editingProviderId ? (
                <>
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                        Configured Providers
                      </h3>
                      <p className="text-xs text-zinc-500">
                        Add OpenAI-compatible, Ollama, or custom API endpoints.
                      </p>
                    </div>
                    <button
                      onClick={startAddNewProvider}
                      className="flex items-center gap-1.5 h-8 px-3 rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-xs font-medium hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Add Provider</span>
                    </button>
                  </div>

                  <div className="space-y-2.5">
                    {providers.map((prov) => (
                      <div
                        key={prov.id}
                        className="flex items-center justify-between p-3.5 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30"
                      >
                        <div className="min-w-0 pr-3">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-xs text-zinc-900 dark:text-zinc-100">
                              {prov.name}
                            </span>
                            <span className="text-[10px] px-1.5 py-0.2 rounded bg-zinc-200/80 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300 uppercase">
                              {prov.apiType}
                            </span>
                          </div>
                          <div className="text-[11px] text-zinc-400 truncate mt-0.5">
                            {prov.baseUrl}
                          </div>
                          <div className="text-[11px] text-zinc-500 mt-1 flex items-center gap-1">
                            <Layers className="w-3 h-3 opacity-60" />
                            <span>{prov.models.length} model(s) selected</span>
                          </div>
                        </div>

                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={() => handleQuickRefreshProviderModels(prov)}
                            title="Refresh models"
                            className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-700/60 transition-colors"
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => startEditProvider(prov)}
                            title="Edit provider & models"
                            className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-700/60 transition-colors"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          {providers.length > 1 && (
                            <button
                              onClick={() => handleDeleteProvider(prov.id)}
                              title="Delete provider"
                              className="p-1.5 rounded-md text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                /* Add / Edit Provider Form */
                <div className="space-y-4 rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 bg-zinc-50/30 dark:bg-zinc-800/20">
                  <div className="flex items-center justify-between pb-2 border-b border-zinc-200/60 dark:border-zinc-800">
                    <h3 className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                      {isAddingNew ? 'Add Custom Provider' : `Edit ${formName}`}
                    </h3>
                    <button
                      onClick={cancelProviderForm}
                      className="text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                    >
                      Cancel
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                        Provider Name
                      </label>
                      <input
                        type="text"
                        value={formName}
                        onChange={(e) => setFormName(e.target.value)}
                        placeholder="e.g. Vyce AI, OpenAI, DeepSeek"
                        className="w-full h-8 px-2.5 text-xs bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-lg focus:outline-none focus:ring-1 focus:ring-zinc-400 text-zinc-900 dark:text-zinc-100"
                      />
                    </div>

                    <div>
                      <label className="block text-[11px] font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                        API Type / Protocol
                      </label>
                      <select
                        value={formApiType}
                        onChange={(e) => setFormApiType(e.target.value as ApiType)}
                        className="w-full h-8 px-2.5 text-xs bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-lg focus:outline-none focus:ring-1 focus:ring-zinc-400 text-zinc-900 dark:text-zinc-100"
                      >
                        <option value="openai">OpenAI Compatible (/v1)</option>
                        <option value="ollama">Ollama (/api)</option>
                        <option value="mock">Demo / Mock Provider</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                      Base Endpoint URL
                    </label>
                    <div className="relative">
                      <Globe className="absolute left-2.5 top-2 w-3.5 h-3.5 text-zinc-400" />
                      <input
                        type="text"
                        value={formBaseUrl}
                        onChange={(e) => setFormBaseUrl(e.target.value)}
                        placeholder="https://vyceai.com/v1"
                        className="w-full h-8 pl-8 pr-2.5 text-xs bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-lg focus:outline-none focus:ring-1 focus:ring-zinc-400 text-zinc-900 dark:text-zinc-100"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                      API Key / Token
                    </label>
                    <div className="relative">
                      <Key className="absolute left-2.5 top-2 w-3.5 h-3.5 text-zinc-400" />
                      <input
                        type={showApiKey ? 'text' : 'password'}
                        value={formApiKey}
                        onChange={(e) => setFormApiKey(e.target.value)}
                        placeholder="sk-..."
                        className="w-full h-8 pl-8 pr-8 text-xs bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-lg focus:outline-none focus:ring-1 focus:ring-zinc-400 text-zinc-900 dark:text-zinc-100 font-mono"
                      />
                      <button
                        type="button"
                        onClick={() => setShowApiKey(!showApiKey)}
                        className="absolute right-2.5 top-2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
                      >
                        {showApiKey ? (
                          <EyeOff className="w-3.5 h-3.5" />
                        ) : (
                          <Eye className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Actions: Test Connection & Fetch Models */}
                  <div className="flex flex-wrap items-center gap-2 pt-2">
                    <button
                      type="button"
                      onClick={handleTestConnection}
                      disabled={testingStatus.loading}
                      className="h-7 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50"
                    >
                      {testingStatus.loading ? 'Testing...' : 'Test Connection'}
                    </button>

                    <button
                      type="button"
                      onClick={handleFetchModels}
                      disabled={fetchingStatus.loading}
                      className="h-7 px-3 rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-xs font-medium hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                    >
                      <RefreshCw
                        className={`w-3 h-3 ${fetchingStatus.loading ? 'animate-spin' : ''}`}
                      />
                      <span>{fetchingStatus.loading ? 'Fetching...' : 'Fetch Models from Endpoint'}</span>
                    </button>
                  </div>

                  {/* Status feedback */}
                  {testingStatus.message && (
                    <div
                      className={`flex items-center gap-2 p-2 rounded-lg text-xs ${
                        testingStatus.success
                          ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
                          : 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800'
                      }`}
                    >
                      {testingStatus.success ? (
                        <CheckCircle2 className="w-4 h-4 shrink-0" />
                      ) : (
                        <AlertCircle className="w-4 h-4 shrink-0" />
                      )}
                      <span>{testingStatus.message}</span>
                    </div>
                  )}

                  {fetchingStatus.message && (
                    <div
                      className={`flex items-center gap-2 p-2 rounded-lg text-xs ${
                        fetchingStatus.success
                          ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
                          : 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800'
                      }`}
                    >
                      {fetchingStatus.success ? (
                        <CheckCircle2 className="w-4 h-4 shrink-0" />
                      ) : (
                        <AlertCircle className="w-4 h-4 shrink-0" />
                      )}
                      <span>{fetchingStatus.message}</span>
                    </div>
                  )}

                  {/* INTERACTIVE MODEL PICKER (Checkboxes to select only desired models) */}
                  {isModelPickerOpen && fetchedCandidateModels.length > 0 && (
                    <div className="p-3.5 rounded-xl border border-indigo-200 dark:border-indigo-900/60 bg-indigo-50/30 dark:bg-indigo-950/20 space-y-3 animate-in fade-in duration-200">
                      <div className="flex items-center justify-between flex-wrap gap-2">
                        <div className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
                          <span>Select Models to Add</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300">
                            {selectedCandidateModelIds.size} of {fetchedCandidateModels.length} selected
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={handleSelectAllCandidateModels}
                            className="text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline"
                          >
                            Select All
                          </button>
                          <span className="text-zinc-300 dark:text-zinc-700">|</span>
                          <button
                            type="button"
                            onClick={handleDeselectAllCandidateModels}
                            className="text-[11px] text-zinc-500 hover:underline"
                          >
                            Deselect All
                          </button>
                        </div>
                      </div>

                      {/* Filter Search */}
                      {fetchedCandidateModels.length > 5 && (
                        <div className="relative">
                          <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-zinc-400" />
                          <input
                            type="text"
                            value={modelFilterQuery}
                            onChange={(e) => setModelFilterQuery(e.target.value)}
                            placeholder="Filter fetched models..."
                            className="w-full h-7 pl-8 pr-2.5 text-xs bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-400 text-zinc-900 dark:text-zinc-100"
                          />
                        </div>
                      )}

                      {/* Checkbox List */}
                      <div className="max-h-48 overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-1.5 space-y-0.5">
                        {filteredCandidates.map((m) => {
                          const isChecked = selectedCandidateModelIds.has(m.id);
                          return (
                            <label
                              key={m.id}
                              className={`flex items-center justify-between text-xs py-1.5 px-2.5 rounded-md cursor-pointer transition-colors ${
                                isChecked
                                  ? 'bg-indigo-50/70 dark:bg-indigo-950/40 text-zinc-900 dark:text-zinc-100'
                                  : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60 text-zinc-600 dark:text-zinc-400'
                              }`}
                            >
                              <div className="flex items-center gap-2.5 min-w-0">
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={() => toggleModelCheck(m.id)}
                                  className="w-3.5 h-3.5 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-400 cursor-pointer"
                                />
                                <span className="font-mono text-[11px] truncate">
                                  {m.id}
                                </span>
                              </div>
                              {m.supportsThinking && (
                                <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/60 text-amber-700 dark:text-amber-300 shrink-0">
                                  <Brain className="w-2.5 h-2.5" />
                                  <span>Reasoning</span>
                                </span>
                              )}
                            </label>
                          );
                        })}
                      </div>

                      {/* Add Button */}
                      <div className="flex items-center justify-end gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => setIsModelPickerOpen(false)}
                          className="h-7 px-3 text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={handleApplySelectedModels}
                          disabled={selectedCandidateModelIds.size === 0}
                          className="h-7 px-3.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium transition-colors disabled:opacity-50 shadow-sm flex items-center gap-1.5"
                        >
                          <Check className="w-3 h-3" />
                          <span>Add Selected Models ({selectedCandidateModelIds.size})</span>
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Confirmed Added Models List */}
                  {formModels.length > 0 && !isModelPickerOpen && (
                    <div className="pt-2">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
                          Added Models ({formModels.length})
                        </span>
                        {fetchedCandidateModels.length > 0 && (
                          <button
                            type="button"
                            onClick={() => setIsModelPickerOpen(true)}
                            className="text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline"
                          >
                            Change selection
                          </button>
                        )}
                      </div>
                      <div className="max-h-36 overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-1.5 space-y-1">
                        {formModels.map((m) => (
                          <div
                            key={m.id}
                            className="flex items-center justify-between text-xs py-1 px-2.5 rounded hover:bg-zinc-50 dark:hover:bg-zinc-800 group"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-zinc-800 dark:text-zinc-200 font-mono text-[11px] truncate">
                                {m.name || m.id}
                              </span>
                              {m.supportsThinking && (
                                <span className="flex items-center gap-0.5 text-[9px] px-1 py-0.2 rounded bg-amber-100 dark:bg-amber-900/60 text-amber-700 dark:text-amber-300">
                                  <Brain className="w-2.5 h-2.5" />
                                  <span>Reasoning</span>
                                </span>
                              )}
                            </div>
                            <button
                              type="button"
                              onClick={() => handleRemoveSingleModel(m.id)}
                              title="Remove model"
                              className="text-zinc-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity p-0.5"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Form Footer Save / Cancel */}
                  <div className="flex items-center justify-end gap-2 pt-3 border-t border-zinc-200/60 dark:border-zinc-800">
                    <button
                      type="button"
                      onClick={cancelProviderForm}
                      className="h-8 px-3.5 rounded-lg border border-zinc-300 dark:border-zinc-700 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleSaveProvider}
                      className="h-8 px-4 rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-xs font-medium hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-colors shadow-sm"
                    >
                      Save Provider
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
