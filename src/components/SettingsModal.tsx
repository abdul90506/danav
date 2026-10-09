import React, { useRef, useState } from 'react';
import { useEscapeToClose, useFocusTrap } from '../utils/useDismissOnOutside';
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
  Database,
  Copy,
  Download,
  Upload,
  RotateCcw,
  Loader2,
} from 'lucide-react';
import { QuotaPanel } from './QuotaPanel';
import { AgentSummaryModelSelection, ApiType, Conversation, Model, Provider, Theme } from '../types';
import {
  fetchConversationsBackup,
  fetchProviderModels,
  restoreConversationsBackup,
  testProviderConnection,
} from '../services/api';
import { buildEditedProvider, parseKeyFile } from './providerSettings.js';
import RunLog from './RunLog';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  providers: Provider[];
  onSaveProviders: (providers: Provider[]) => Promise<boolean> | boolean | void;
  agentSummaryModel: AgentSummaryModelSelection | null;
  onSaveAgentSummaryModel: (selection: AgentSummaryModelSelection | null) => Promise<boolean> | boolean;
  /** The chats this browser is showing, for the export and the Data tab counts. */
  conversations: Conversation[];
  /** Re-read the server's store after a restore, so the UI shows what came back. */
  onConversationsRestored: () => void | Promise<void>;
  /** The open chat, whose recorded runs the Run Log shows. */
  activeChatId: string | null;
  /** Its agent workspace, whose project memory is shown with them. */
  activeWorkspaceId: string | null;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  theme,
  onThemeChange,
  providers,
  onSaveProviders,
  agentSummaryModel,
  onSaveAgentSummaryModel,
  conversations,
  onConversationsRestored,
  activeChatId,
  activeWorkspaceId,
}) => {
  const [activeTab, setActiveTab] = useState<'appearance' | 'providers' | 'limits' | 'agent' | 'runlog' | 'data'>('appearance');
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, isOpen);

  // Escape closes Settings — through the shared rule, so the key never also stops
  // a running agent turn. This must only register while the modal is actually open.
  useEscapeToClose(onClose, isOpen);

  // Provider Form State
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);

  // Form Fields
  const [formName, setFormName] = useState('');
  const [formBaseUrl, setFormBaseUrl] = useState('');
  const [formApiKeys, setFormApiKeys] = useState<string[]>(['']);
  /** Result of the last import or export, shown under the key list. */
  const [keyFileNotice, setKeyFileNotice] = useState('');
  const keyFileInput = useRef<HTMLInputElement>(null);
  /** The exported list, held on screen so it can be copied even if a download is blocked. */
  const [exportedKeys, setExportedKeys] = useState<{ text: string; count: number; name: string; url: string } | null>(null);
  const [copiedKeys, setCopiedKeys] = useState(false);
  const exportedKeysField = useRef<HTMLTextAreaElement>(null);
  const [formSavedApiKeyCount, setFormSavedApiKeyCount] = useState(0);
  const [clearSavedApiKeys, setClearSavedApiKeys] = useState(false);
  const [savingProvider, setSavingProvider] = useState(false);
  const [providerSaveError, setProviderSaveError] = useState('');
  const [formApiType, setFormApiType] = useState<ApiType>('openai');
  const [formQuotaEnabled, setFormQuotaEnabled] = useState(false);
  const [formQuotaRpm, setFormQuotaRpm] = useState('5');
  const [formQuotaRpd, setFormQuotaRpd] = useState('20');
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
  const [summarySaveStatus, setSummarySaveStatus] = useState<{
    loading: boolean;
    success?: boolean;
    message?: string;
  }>({ loading: false });

  // Chat Data tab
  const [backupStatus, setBackupStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  /** Set while the user is being asked to confirm a restore, with its size. */
  const [pendingRestore, setPendingRestore] = useState<{ count: number } | null>(null);
  const [exportStatus, setExportStatus] = useState('');

  /**
   * Step one: look at the backup and ask. Restoring replaces what is on screen,
   * so it is confirmed in the page rather than with `window.confirm` — a modal
   * dialog is blocked inside a sandboxed preview iframe (the button would silently
   * do nothing there) and cannot describe the copy it is about to restore.
   */
  const handleCheckBackup = async () => {
    setBackupBusy(true);
    setBackupStatus(null);
    try {
      const backup = await fetchConversationsBackup();
      if (!backup.success) {
        setBackupStatus({ ok: false, message: backup.error || 'No backup available' });
        return;
      }
      setPendingRestore({ count: backup.conversations?.length || 0 });
    } finally {
      setBackupBusy(false);
    }
  };

  /** Step two: the confirmed restore, then re-read the store the app displays. */
  const handleConfirmRestore = async () => {
    setBackupBusy(true);
    setBackupStatus(null);
    try {
      const result = await restoreConversationsBackup();
      if (!result.success) {
        setBackupStatus({ ok: false, message: result.error || 'Restore failed' });
        return;
      }
      await onConversationsRestored();
      setPendingRestore(null);
      setBackupStatus({
        ok: true,
        message: `Restored ${result.restored ?? pendingRestore?.count ?? 0} conversations`,
      });
    } finally {
      setBackupBusy(false);
    }
  };

  const handleExportConversations = () => {
    const payload = JSON.stringify(
      { exportedAt: new Date().toISOString(), conversations },
      null,
      2
    );
    const fileName = `blackdesi-chats-${new Date().toISOString().slice(0, 10)}.json`;
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Revoke on the next tick: some browsers cancel the download if the object
    // URL disappears in the same frame as the click.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    // Say what was handed to the browser: a sandboxed preview frame (or a
    // blocked-download setting) can swallow it silently, and then the button
    // looks broken rather than blocked.
    setExportStatus(
      `Prepared ${fileName} (${conversations.length} conversation${conversations.length === 1 ? '' : 's'}). ` +
        'If nothing downloads, open the app in its own browser tab and try again.'
    );
  };

  const handleSummaryModelChange = async (event: React.ChangeEvent<HTMLSelectElement>) => {
    const raw = event.currentTarget.value;
    let selection: AgentSummaryModelSelection | null = null;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed?.providerId === 'string' && typeof parsed?.modelId === 'string') {
          selection = { providerId: parsed.providerId, modelId: parsed.modelId };
        }
      } catch {
        setSummarySaveStatus({ loading: false, success: false, message: 'That model choice was not valid.' });
        return;
      }
    }
    setSummarySaveStatus({ loading: true });
    try {
      const saved = await onSaveAgentSummaryModel(selection);
      setSummarySaveStatus({
        loading: false,
        success: saved,
        message: saved ? 'Saved.' : 'Could not save this setting. Check the server connection and try again.',
      });
    } catch {
      setSummarySaveStatus({ loading: false, success: false, message: 'Could not save this setting. Check the server connection and try again.' });
    }
  };

  if (!isOpen) return null;

  const summaryModelOptions = providers.flatMap((provider) =>
    provider.enabled !== false && provider.apiType !== 'mock' && provider.baseUrl.trim()
      ? (provider.models || []).map((model) => ({
          value: JSON.stringify({ providerId: provider.id, modelId: model.id }),
          label: `${model.name || model.id} · ${provider.name}`,
        }))
      : []
  );
  const requestedSummaryValue = agentSummaryModel ? JSON.stringify(agentSummaryModel) : '';
  const selectedSummaryValue = summaryModelOptions.some((option) => option.value === requestedSummaryValue)
    ? requestedSummaryValue
    : '';

  const startAddNewProvider = () => {
    // Never carry one provider's exported keys into another provider's form.
    setExportedKeys(null);
    setKeyFileNotice('');
    setIsAddingNew(true);
    setEditingProviderId(null);
    setFormName('');
    setFormBaseUrl('https://vyceai.com/v1');
    setFormApiKeys(['']);
    setFormSavedApiKeyCount(0);
    setClearSavedApiKeys(false);
    setShowApiKey(false);
    setFormApiType('openai');
    setFormQuotaEnabled(false);
    setFormQuotaRpm('5');
    setFormQuotaRpd('20');
    setFormModels([]);
    setFetchedCandidateModels([]);
    setSelectedCandidateModelIds(new Set());
    setIsModelPickerOpen(false);
    setModelFilterQuery('');
    setTestingStatus({ loading: false });
    setFetchingStatus({ loading: false });
    setProviderSaveError('');
  };

  const startEditProvider = (p: Provider) => {
    setExportedKeys(null);
    setKeyFileNotice('');
    setEditingProviderId(p.id);
    setIsAddingNew(false);
    setFormName(p.name);
    setFormBaseUrl(p.baseUrl);
    // Saved values never leave the server; new keys are added as blank form rows.
    setFormApiKeys(['']);
    setFormSavedApiKeyCount(p.apiKeyCount ?? (p.apiKeyConfigured || p.apiKey ? 1 : 0));
    setClearSavedApiKeys(false);
    setShowApiKey(false);
    setFormApiType(p.apiType);
    setFormQuotaEnabled(p.quota?.enabled === true);
    setFormQuotaRpm(String(p.quota?.limits?.['*']?.rpm ?? 5));
    setFormQuotaRpd(String(p.quota?.limits?.['*']?.rpd ?? 20));
    // The router's entry is offered by the server for budgeted providers; it is
    // not a model anyone configures, so the editor never shows or saves it.
    const editable = (p.models || []).filter((m) => m.id !== 'auto');
    setFormModels(editable);
    setFetchedCandidateModels(editable);
    setSelectedCandidateModelIds(new Set(editable.map((m) => m.id)));
    setIsModelPickerOpen(false);
    setModelFilterQuery('');
    setTestingStatus({ loading: false });
    setFetchingStatus({ loading: false });
    setProviderSaveError('');
  };

  const cancelProviderForm = () => {
    setExportedKeys(null);
    setIsAddingNew(false);
    setEditingProviderId(null);
    setIsModelPickerOpen(false);
    setTestingStatus({ loading: false });
    setFetchingStatus({ loading: false });
    setProviderSaveError('');
  };

  const enteredApiKeys = () => [...new Set(formApiKeys.map((key) => key.trim()).filter(Boolean))];

  /** Read a .txt of keys into the form; anything already listed is not added twice. */
  const handleImportKeys = async (file: File | null | undefined) => {
    if (!file) return;
    setKeyFileNotice('');
    try {
      const found = parseKeyFile(await file.text());
      if (!found.length) {
        setKeyFileNotice(`${file.name} has no keys in it.`);
        return;
      }
      const existing = new Set(enteredApiKeys());
      const added = found.filter((key) => !existing.has(key));
      setFormApiKeys((prev) => [...prev.filter((key) => key.trim()), ...added]);
      setKeyFileNotice(
        added.length === found.length
          ? `Added ${added.length} key${added.length === 1 ? '' : 's'} from ${file.name}. Save to keep them.`
          : `Added ${added.length} of ${found.length} from ${file.name}; the rest were already in the list.`
      );
    } catch {
      setKeyFileNotice(`Could not read ${file.name}.`);
    }
  };

  /**
   * Fetch this provider's saved keys and offer them every way that can work.
   *
   * A generated download is the obvious route and it is the one that silently
   * fails: inside a sandboxed preview frame the browser drops the click with
   * no event and no error, so the only sign of life was the "Exported 8 keys"
   * notice and no file. So the keys are also put on screen, where copying
   * them always works, and the download link is a real anchor the user clicks
   * themselves rather than a synthetic click that can be ignored.
   */
  const handleExportKeys = async () => {
    if (!editingProviderId) return;
    setKeyFileNotice('');
    try {
      const res = await fetch(`/api/settings/providers/${encodeURIComponent(editingProviderId)}/keys.txt`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setKeyFileNotice(body?.error || `Could not export the keys (HTTP ${res.status}).`);
        return;
      }
      const text = await res.text();
      if (exportedKeys?.url) URL.revokeObjectURL(exportedKeys.url);
      const count = text.split('\n').filter((line) => line.trim()).length;
      setExportedKeys({
        text,
        count,
        name: `${(formName || 'provider').replace(/[^a-z0-9._-]+/gi, '-')}-api-keys.txt`,
        url: URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })),
      });
      setKeyFileNotice('');
      setCopiedKeys(false);
    } catch {
      setKeyFileNotice('Could not export the keys.');
    }
  };

  /** Copy the exported list, with the old command as a fallback for locked-down frames. */
  const handleCopyExportedKeys = async () => {
    if (!exportedKeys) return;
    try {
      await navigator.clipboard.writeText(exportedKeys.text);
      setCopiedKeys(true);
      return;
    } catch {
      /* Clipboard access is refused in some embedded frames; select instead. */
    }
    const field = exportedKeysField.current;
    if (!field) return;
    field.focus();
    field.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { copied = false; }
    setCopiedKeys(copied);
    if (!copied) setKeyFileNotice('Copying is blocked here — the keys are selected, press Ctrl+C.');
  };

  const handleTestConnection = async () => {
    setTestingStatus({ loading: true });
    const result = await testProviderConnection({
      id: editingProviderId || undefined,
      baseUrl: formBaseUrl,
      apiKeys: enteredApiKeys(),
      clearApiKeys: clearSavedApiKeys,
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
      apiKeys: enteredApiKeys(),
      clearApiKeys: clearSavedApiKeys,
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

  const handleSaveProvider = async () => {
    if (!formName.trim() || !formBaseUrl.trim() || savingProvider) return;

    let updatedProviders: Provider[];
    if (isAddingNew) {
      const providerId = `provider-${Date.now()}`;
      const newProvider: Provider = {
        id: providerId,
        name: formName.trim(),
        baseUrl: formBaseUrl.trim(),
        apiKeyAdditions: enteredApiKeys(),
        apiType: formApiType,
        quota: formQuotaEnabled
          ? { enabled: true, limits: { '*': { rpm: Number(formQuotaRpm) || 5, rpd: Number(formQuotaRpd) || 20 } } }
          : { enabled: false },
        isCustom: true,
        enabled: true,
        models:
          formModels.length > 0
            ? formModels.map((model) => ({ ...model, providerId }))
            : [{ id: 'default-model', name: `${formName.trim()} Default`, providerId }],
      };
      updatedProviders = [...providers, newProvider];
    } else if (editingProviderId) {
      updatedProviders = providers.map((p) =>
        p.id === editingProviderId
          ? buildEditedProvider(p, {
              name: formName,
              baseUrl: formBaseUrl,
              apiKeys: enteredApiKeys(),
              apiType: formApiType,
              models: formModels,
              clearSavedApiKeys,
              quota: { enabled: formQuotaEnabled, rpm: formQuotaRpm, rpd: formQuotaRpd },
            })
          : p
      );
    } else {
      return;
    }

    setSavingProvider(true);
    setProviderSaveError('');
    try {
      const saved = await onSaveProviders(updatedProviders);
      if (saved === false) {
        setProviderSaveError('Could not save provider settings. Check the server connection and try again.');
        return;
      }
      cancelProviderForm();
    } catch {
      setProviderSaveError('Could not save provider settings. Check the server connection and try again.');
    } finally {
      setSavingProvider(false);
    }
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
  const filteredCandidates = fetchedCandidateModels.filter((m) => {
    const q = modelFilterQuery.toLowerCase();
    return (
      m.id.toLowerCase().includes(q) ||
      (m.name && m.name.toLowerCase().includes(q)) ||
      (m.description || '').toLowerCase().includes(q)
    );
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-900/40 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="w-full max-w-2xl bg-white dark:bg-zinc-900 rounded-2xl shadow-xl border border-zinc-200 dark:border-zinc-800 flex flex-col overflow-hidden max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        tabIndex={-1}
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200/80 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <h2 id="settings-dialog-title" className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
              Settings
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            title="Close settings"
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex px-6 pt-3 border-b border-zinc-200/60 dark:border-zinc-800 gap-4 text-xs font-medium">
          <button
            type="button"
            data-dialog-initial-focus
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
          <button
            onClick={() => {
              setActiveTab('limits');
              cancelProviderForm();
            }}
            className={`pb-2.5 transition-colors border-b-2 ${
              activeTab === 'limits'
                ? 'border-zinc-900 dark:border-zinc-100 text-zinc-900 dark:text-zinc-100 font-semibold'
                : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-300'
            }`}
          >
            Limits
          </button>
          <button
            onClick={() => {
              setActiveTab('agent');
              cancelProviderForm();
            }}
            className={`pb-2.5 transition-colors border-b-2 ${
              activeTab === 'agent'
                ? 'border-zinc-900 dark:border-zinc-100 text-zinc-900 dark:text-zinc-100 font-semibold'
                : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-300'
            }`}
          >
            Agent
          </button>
          <button
            onClick={() => {
              setActiveTab('runlog');
              cancelProviderForm();
            }}
            className={`pb-2.5 transition-colors border-b-2 ${
              activeTab === 'runlog'
                ? 'border-zinc-900 dark:border-zinc-100 text-zinc-900 dark:text-zinc-100 font-semibold'
                : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-300'
            }`}
          >
            Memory &amp; Inspector
          </button>
          <button
            onClick={() => {
              setActiveTab('data');
              cancelProviderForm();
            }}
            className={`pb-2.5 transition-colors border-b-2 ${
              activeTab === 'data'
                ? 'border-zinc-900 dark:border-zinc-100 text-zinc-900 dark:text-zinc-100 font-semibold'
                : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-300'
            }`}
          >
            Chat Data
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
                          <div className="text-[11px] text-zinc-500 mt-1 flex items-center gap-1.5">
                            <Layers className="w-3 h-3 opacity-60" />
                            <span>{prov.models.length} model(s)</span>
                            {(prov.apiKeyCount ?? (prov.apiKeyConfigured ? 1 : 0)) > 0 && (
                              <>
                                <span aria-hidden="true">·</span>
                                <Key className="w-3 h-3 opacity-60" />
                                <span>{prov.apiKeyCount ?? 1} saved key{(prov.apiKeyCount ?? 1) === 1 ? '' : 's'}</span>
                              </>
                            )}
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

                  <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-2.5">
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formQuotaEnabled}
                        onChange={(e) => setFormQuotaEnabled(e.target.checked)}
                        className="mt-0.5 w-3.5 h-3.5 accent-zinc-900 dark:accent-zinc-100"
                      />
                      <span>
                        <span className="block text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                          Spread requests across keys and models
                        </span>
                        <span className="block text-[10px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                          For providers with a published free tier, such as Gemini. BlackDesi counts
                          requests per key and per model, moves to the next pair before a limit is
                          reached, and keeps a refused pair out of rotation.
                        </span>
                      </span>
                    </label>
                    {formQuotaEnabled && (
                      <div className="grid grid-cols-2 gap-2 mt-2.5 pl-[22px]">
                        <div>
                          <label className="block text-[10px] font-medium text-zinc-600 dark:text-zinc-400 mb-1">
                            Requests per minute
                          </label>
                          <input
                            type="number"
                            min="1"
                            value={formQuotaRpm}
                            onChange={(e) => setFormQuotaRpm(e.target.value)}
                            className="w-full h-7 px-2 text-xs bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-md focus:outline-none focus:ring-1 focus:ring-zinc-400 text-zinc-900 dark:text-zinc-100"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] font-medium text-zinc-600 dark:text-zinc-400 mb-1">
                            Requests per day
                          </label>
                          <input
                            type="number"
                            min="1"
                            value={formQuotaRpd}
                            onChange={(e) => setFormQuotaRpd(e.target.value)}
                            className="w-full h-7 px-2 text-xs bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-md focus:outline-none focus:ring-1 focus:ring-zinc-400 text-zinc-900 dark:text-zinc-100"
                          />
                        </div>
                        <p className="col-span-2 text-[10px] text-zinc-500 dark:text-zinc-400">
                          Per key, per model &mdash; the shape every free tier uses. Live usage is in
                          the Limits tab.
                        </p>
                      </div>
                    )}
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
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <label className="block text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                        API Keys / Tokens
                      </label>
                      <button
                        type="button"
                        onClick={() => setShowApiKey((value) => !value)}
                        className="inline-flex items-center gap-1 text-[10px] text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                        aria-label={showApiKey ? 'Hide API keys' : 'Show API keys'}
                      >
                        {showApiKey ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                        {showApiKey ? 'Hide' : 'Show'}
                      </button>
                    </div>
                    {formSavedApiKeyCount > 0 && (
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[10px] text-zinc-500 dark:text-zinc-400">
                        <span>
                          {clearSavedApiKeys
                            ? `${formSavedApiKeyCount} saved key${formSavedApiKeyCount === 1 ? '' : 's'} will be removed when you save.`
                            : `${formSavedApiKeyCount} key${formSavedApiKeyCount === 1 ? '' : 's'} stored securely. New keys are added to this list.`}
                        </span>
                        <button
                          type="button"
                          onClick={() => setClearSavedApiKeys((value) => !value)}
                          className="shrink-0 underline hover:text-zinc-800 dark:hover:text-zinc-200"
                        >
                          {clearSavedApiKeys ? 'Undo' : 'Remove all saved keys'}
                        </button>
                      </div>
                    )}
                    <div className="space-y-1.5">
                      {formApiKeys.map((key, index) => (
                        <div key={index} className="flex items-center gap-1.5">
                          <div className="relative min-w-0 flex-1">
                            {index === 0 && <Key className="absolute left-2.5 top-2 w-3.5 h-3.5 text-zinc-400" />}
                            <input
                              type={showApiKey ? 'text' : 'password'}
                              value={key}
                              autoComplete="new-password"
                              spellCheck={false}
                              onChange={(e) => setFormApiKeys((prev) => prev.map((item, at) => at === index ? e.target.value : item))}
                              placeholder={`New API key ${index + 1}`}
                              className={`w-full h-8 ${index === 0 ? 'pl-8' : 'pl-2.5'} pr-2.5 text-xs bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-lg focus:outline-none focus:ring-1 focus:ring-zinc-400 text-zinc-900 dark:text-zinc-100 font-mono`}
                            />
                          </div>
                          <button
                            type="button"
                            onClick={() => setFormApiKeys((prev) => prev.filter((_, at) => at !== index))}
                            className="p-1.5 rounded-md text-zinc-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
                            aria-label={`Remove new API key ${index + 1}`}
                            title="Remove this unsaved key"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <button
                        type="button"
                        onClick={() => setFormApiKeys((prev) => [...prev, ''])}
                        className="inline-flex items-center gap-1 text-[10px] text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                      >
                        <Plus className="w-3 h-3" /> Add another key
                      </button>
                      <button
                        type="button"
                        onClick={() => keyFileInput.current?.click()}
                        className="inline-flex items-center gap-1 text-[10px] text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                        title="Read a .txt file with one API key per line"
                      >
                        <Upload className="w-3 h-3" /> Import .txt
                      </button>
                      {editingProviderId && formSavedApiKeyCount > 0 && (
                        <button
                          type="button"
                          onClick={handleExportKeys}
                          className="inline-flex items-center gap-1 text-[10px] text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                          title="Download the saved keys, one per line"
                        >
                          <Download className="w-3 h-3" /> Export .txt
                        </button>
                      )}
                      <span className="ml-auto text-[10px] text-zinc-400">Keys stay private and are tried in order.</span>
                      <input
                        ref={keyFileInput}
                        type="file"
                        accept=".txt,text/plain"
                        className="hidden"
                        onChange={(e) => { void handleImportKeys(e.target.files?.[0]); e.target.value = ''; }}
                      />
                    </div>
                    {keyFileNotice && (
                      <p className="mt-1 text-[10px] text-zinc-500 dark:text-zinc-400">{keyFileNotice}</p>
                    )}
                    {exportedKeys && (
                      <div className="mt-2 rounded-lg border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-800 dark:bg-zinc-900/60">
                        <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="text-[10px] font-medium text-zinc-600 dark:text-zinc-300">
                            {exportedKeys.count} key{exportedKeys.count === 1 ? '' : 's'}, one per line
                          </span>
                          <button
                            type="button"
                            onClick={handleCopyExportedKeys}
                            className="inline-flex items-center gap-1 rounded-md border border-zinc-300 px-1.5 py-0.5 text-[10px] text-zinc-700 hover:bg-white dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
                          >
                            {copiedKeys ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                            {copiedKeys ? 'Copied' : 'Copy all'}
                          </button>
                          {/* A real link the user clicks: a synthetic click is what the preview frame refuses. */}
                          <a
                            href={exportedKeys.url}
                            download={exportedKeys.name}
                            className="inline-flex items-center gap-1 rounded-md border border-zinc-300 px-1.5 py-0.5 text-[10px] text-zinc-700 hover:bg-white dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
                          >
                            <Download className="h-3 w-3" /> Save {exportedKeys.name}
                          </a>
                          <button
                            type="button"
                            onClick={() => {
                              URL.revokeObjectURL(exportedKeys.url);
                              setExportedKeys(null);
                              setCopiedKeys(false);
                            }}
                            className="ml-auto text-[10px] text-zinc-400 underline hover:text-zinc-700 dark:hover:text-zinc-200"
                          >
                            Hide
                          </button>
                        </div>
                        <textarea
                          ref={exportedKeysField}
                          readOnly
                          value={exportedKeys.text}
                          onFocus={(e) => e.currentTarget.select()}
                          rows={Math.min(8, Math.max(2, exportedKeys.count))}
                          spellCheck={false}
                          aria-label="Exported API keys"
                          className="w-full resize-y rounded-md border border-zinc-200 bg-white p-1.5 font-mono text-[10px] leading-5 text-zinc-800 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200"
                        />
                        <p className="mt-1 text-[10px] text-zinc-400">
                          If the Save link does nothing, this view is embedded in a frame that blocks downloads — copy
                          the list and paste it into a .txt file. Importing reads exactly this format back.
                        </p>
                      </div>
                    )}
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
                  {providerSaveError && (
                    <div role="alert" className="flex items-center gap-2 p-2 rounded-lg text-xs bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800">
                      <AlertCircle className="w-4 h-4 shrink-0" />
                      <span>{providerSaveError}</span>
                    </div>
                  )}
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
                                <span className="min-w-0">
                                  <span className="block font-mono text-[11px] truncate">{m.id}</span>
                                  {m.description && (
                                    <span className="block text-[10px] text-zinc-400 truncate max-w-[340px]">
                                      {m.description}
                                    </span>
                                  )}
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
                                <span className="flex items-center gap-0.5 text-[10px] px-1 py-0.2 rounded bg-amber-100 dark:bg-amber-900/60 text-amber-700 dark:text-amber-300">
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
                      disabled={savingProvider}
                      className="h-8 px-3.5 rounded-lg border border-zinc-300 dark:border-zinc-700 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleSaveProvider}
                      disabled={savingProvider}
                      className="h-8 px-4 rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-xs font-medium hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-colors shadow-sm disabled:opacity-50"
                    >
                      {savingProvider ? 'Saving…' : 'Save Provider'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {/* TAB 3: AGENT MEMORY */}
          {activeTab === 'limits' && (
            <div className="space-y-4">
              <div>
                <h3 className="text-[15px] font-semibold text-zinc-900 dark:text-zinc-100">Request limits</h3>
                <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400">
                  Keys are budgeted per model, not per key, so BlackDesi picks the key and model that still have room
                  before it sends anything — and moves on the moment one is refused.
                </p>
              </div>
              <QuotaPanel />
            </div>
          )}

          {activeTab === 'agent' && (
            <div className="space-y-5">
              <div>
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Task-step memory</h3>
                <p className="text-xs text-zinc-500 mt-1">
                  BlackDesi keeps short notes about meaningful progress so long tasks can continue without replaying old work.
                </p>
              </div>

              <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 space-y-3">
                <div>
                  <label htmlFor="agent-summary-model" className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                    Background summary model
                  </label>
                  <p className="text-xs text-zinc-500 mb-3">
                    Choose a provider/model independently from the chat. Only compact, redacted step summaries, findings,
                    file paths and check results are sent—not the full chat or file contents. Notes stay in this server's
                    private run journal; if the provider is unavailable, local checkpoints are kept.
                  </p>
                  <select
                    id="agent-summary-model"
                    value={selectedSummaryValue}
                    onChange={handleSummaryModelChange}
                    disabled={summarySaveStatus.loading}
                    className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm text-zinc-800 dark:text-zinc-200 disabled:opacity-60"
                  >
                    <option value="">Use the model running this task (default)</option>
                    {summaryModelOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  {!summaryModelOptions.length && (
                    <p className="text-xs text-amber-700 dark:text-amber-300 mt-2">
                      Add an enabled provider with a model to choose a separate summary model.
                    </p>
                  )}
                </div>
                {(summarySaveStatus.message || summarySaveStatus.loading) && (
                  <div className={`flex items-center gap-1.5 text-xs ${summarySaveStatus.success ? 'text-emerald-600 dark:text-emerald-400' : summarySaveStatus.loading ? 'text-zinc-500' : 'text-rose-600 dark:text-rose-400'}`}>
                    {summarySaveStatus.loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : summarySaveStatus.success ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
                    <span>{summarySaveStatus.loading ? 'Saving…' : summarySaveStatus.message}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 5: MEMORY & RUN LOG — what the agent remembers, and what it did */}
          {activeTab === 'runlog' && (
            <RunLog chatId={activeChatId} workspaceId={activeWorkspaceId} />
          )}

          {/* TAB 4: CHAT DATA */}
          {activeTab === 'data' && (
            <div className="space-y-5">
              <div>
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Where your chats live</h3>
                <p className="text-xs text-zinc-500 mt-1">
                  Every conversation is kept on this server (<code className="font-mono">server/data/conversations.json</code>)
                  and mirrored in this browser, so a closed tab or a restart never loses history.
                </p>
                <div className="mt-3 flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
                  <Database className="w-3.5 h-3.5 text-zinc-400" />
                  <span>
                    {conversations.length} conversation{conversations.length === 1 ? '' : 's'} ·{' '}
                    {conversations.reduce((n, c) => n + (c.messages?.length || 0), 0)} messages
                  </span>
                </div>
              </div>

              <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 space-y-3">
                <div>
                  <h4 className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">Restore an older copy</h4>
                  <p className="text-xs text-zinc-500 mt-1">
                    Before the server ever lets the chat store shrink — a stale tab saving over newer data, an
                    accidental wipe — it keeps the previous version aside. Restoring brings that copy back and
                    leaves it in place, so this can be undone by restoring again.
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {pendingRestore ? (
                    <div className="w-full rounded-lg border border-amber-300/70 dark:border-amber-800/70 bg-amber-50/60 dark:bg-amber-950/20 px-3 py-2.5 space-y-2">
                      <p
                        className="text-xs text-amber-800 dark:text-amber-200"
                        data-testid="restore-confirm"
                      >
                        Restore the backup? It holds {pendingRestore.count} conversation
                        {pendingRestore.count === 1 ? '' : 's'}. The chats you have now are replaced by that
                        copy — the backup itself is kept, so this can be undone by restoring again.
                      </p>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={handleConfirmRestore}
                          disabled={backupBusy}
                          className="h-7 px-3 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium transition-colors disabled:opacity-50 flex items-center gap-1.5"
                        >
                          {backupBusy && <Loader2 className="w-3 h-3 animate-spin" />}
                          <span>Restore {pendingRestore.count} conversations</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setPendingRestore(null)}
                          disabled={backupBusy}
                          className="h-7 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={handleCheckBackup}
                      disabled={backupBusy}
                      className="h-8 px-3.5 rounded-lg border border-zinc-300 dark:border-zinc-700 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                    >
                      {backupBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                      <span>{backupBusy ? 'Working…' : 'Restore previous backup'}</span>
                    </button>
                  )}
                  {backupStatus?.message && (
                    <span
                      className={`text-xs ${
                        backupStatus.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'
                      }`}
                    >
                      {backupStatus.message}
                    </span>
                  )}
                </div>
              </div>

              <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 space-y-3">
                <div>
                  <h4 className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">Export</h4>
                  <p className="text-xs text-zinc-500 mt-1">
                    Download every chat as a single JSON file — a copy you hold, independent of this machine.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleExportConversations}
                  disabled={conversations.length === 0}
                  className="h-8 px-3.5 rounded-lg border border-zinc-300 dark:border-zinc-700 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download chats (JSON)</span>
                </button>
                {exportStatus && (
                  <p className="text-[11px] text-zinc-500" data-testid="export-status">
                    {exportStatus}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
