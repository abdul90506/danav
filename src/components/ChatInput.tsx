import React, { useRef, useEffect, useState, useMemo, KeyboardEvent } from 'react';
import {
  ArrowUp,
  Sparkles,
  ChevronDown,
  Brain,
  Check,
  Search,
  X,
  Zap,
  Plus,
  File,
  Folder,
} from 'lucide-react';
import { Attachment, Provider, ThinkingLevel } from '../types';

interface ChatInputProps {
  input: string;
  setInput: (value: string) => void;
  onSend: (attachments?: Attachment[], webSearch?: boolean) => void;
  isLoading: boolean;
  onStop: () => void;
  placeholder?: string;
  disabled?: boolean;
  isCentered?: boolean;
  providers: Provider[];
  selectedProviderId: string;
  selectedModelId: string;
  thinkingLevel: ThinkingLevel;
  onSelectModel: (providerId: string, modelId: string) => void;
  onSelectThinkingLevel: (level: ThinkingLevel) => void;
  /** Agent switch + workspace picker, shown in a row above the message box. */
  agentControls?: React.ReactNode;
}

// Compact, responsive Model Selector Popup with Provider Tabs and Search Filter
interface ModelSelectorDropdownProps {
  providers: Provider[];
  selectedProviderId: string;
  selectedModelId: string;
  onSelectModel: (providerId: string, modelId: string) => void;
  onClose: () => void;
}

const ModelSelectorDropdown: React.FC<ModelSelectorDropdownProps> = ({
  providers,
  selectedProviderId,
  selectedModelId,
  onSelectModel,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<string>('all');
  const [search, setSearch] = useState('');

  // Collect and filter models
  const filteredItems = useMemo(() => {
    const list: Array<{ provider: Provider; model: { id: string; name: string } }> = [];
    const targetProviders =
      activeTab === 'all' ? providers : providers.filter((p) => p.id === activeTab);

    for (const prov of targetProviders) {
      for (const m of prov.models) {
        if (!search.trim()) {
          list.push({ provider: prov, model: m });
        } else {
          const q = search.toLowerCase();
          const matchesName = (m.name || '').toLowerCase().includes(q);
          const matchesId = m.id.toLowerCase().includes(q);
          const matchesProv = prov.name.toLowerCase().includes(q);
          if (matchesName || matchesId || matchesProv) {
            list.push({ provider: prov, model: m });
          }
        }
      }
    }
    return list;
  }, [providers, activeTab, search]);

  const totalModelsCount = useMemo(() => {
    return providers.reduce((acc, p) => acc + (p.models?.length || 0), 0);
  }, [providers]);

  const isThinkingCapable = (modelId: string) => {
    const id = modelId.toLowerCase();
    return (
      id.includes('reason') ||
      id.includes('r1') ||
      id.includes('think') ||
      id.includes('gemini-2.5') ||
      id.includes('gemini-3') ||
      id.includes('gemma-4') ||
      id.includes('o1') ||
      id.includes('o3')
    );
  };

  const isFastModel = (modelId: string) => {
    const id = modelId.toLowerCase();
    return (
      id.includes('flash') ||
      id.includes('lite') ||
      id.includes('mini') ||
      id.includes('turbo') ||
      id.includes('instant')
    );
  };

  return (
    <div className="w-[280px] sm:w-[330px] max-w-[calc(100vw-28px)] max-h-[340px] flex flex-col bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-800 text-xs overflow-hidden animate-in fade-in zoom-in-95 duration-150 select-none z-50">
      {/* Header: Compact Search Box */}
      <div className="p-2 border-b border-zinc-100 dark:border-zinc-800/80">
        <div className="relative flex items-center bg-zinc-100/90 dark:bg-zinc-800/70 rounded-lg px-2 py-1 focus-within:ring-1 focus-within:ring-zinc-400 dark:focus-within:ring-zinc-600 transition-all">
          <Search className="w-3 h-3 text-zinc-400 shrink-0 mr-1.5" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search models..."
            autoFocus
            className="w-full bg-transparent text-[11.5px] text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 outline-none border-none focus:outline-none focus:ring-0 p-0"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 ml-1 cursor-pointer"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* Provider Tabs with Horizontal Scroll */}
        {providers.length > 1 && (
          <div className="flex items-center gap-1 mt-1.5 overflow-x-auto no-scrollbar pb-0.5">
            <button
              type="button"
              onClick={() => setActiveTab('all')}
              className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded-md text-[10.5px] font-medium transition-colors shrink-0 cursor-pointer ${
                activeTab === 'all'
                  ? 'bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 shadow-sm'
                  : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'
              }`}
            >
              <span>All</span>
              <span className="opacity-60 text-[9.5px]">({totalModelsCount})</span>
            </button>
            {providers.map((p) => {
              const isTabActive = activeTab === p.id;
              const count = p.models?.length || 0;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setActiveTab(p.id)}
                  className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded-md text-[10.5px] font-medium transition-colors shrink-0 cursor-pointer ${
                    isTabActive
                      ? 'bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 shadow-sm'
                      : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                  }`}
                >
                  <span className="truncate max-w-[80px]">{p.name}</span>
                  <span className="opacity-60 text-[9.5px]">({count})</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Model List */}
      <div className="flex-1 overflow-y-auto p-1 space-y-0.5 panel-scroll max-h-[260px]">
        {filteredItems.length === 0 ? (
          <div className="py-6 text-center text-zinc-400 text-xs">
            No models found
          </div>
        ) : (
          filteredItems.map(({ provider, model }) => {
            const isSelected = selectedProviderId === provider.id && selectedModelId === model.id;
            const hasThinking = isThinkingCapable(model.id);
            const isFast = isFastModel(model.id);
            const cleanDisplayName = (model.name || model.id).replace(/^models\//, '');

            return (
              <button
                key={`${provider.id}-${model.id}`}
                type="button"
                onClick={() => {
                  onSelectModel(provider.id, model.id);
                  onClose();
                }}
                className={`w-full flex items-center justify-between px-2 py-1.5 rounded-lg text-left transition-all cursor-pointer ${
                  isSelected
                    ? 'bg-zinc-100 dark:bg-zinc-800/90 text-zinc-900 dark:text-white font-medium ring-1 ring-zinc-300/60 dark:ring-zinc-700'
                    : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
                }`}
              >
                <div className="min-w-0 pr-1.5 flex-1">
                  <div className="flex items-center gap-1 flex-wrap">
                    <span className="truncate font-medium text-[11.5px] text-zinc-900 dark:text-zinc-100">
                      {cleanDisplayName}
                    </span>
                    {hasThinking && (
                      <span className="inline-flex items-center gap-0.5 px-1 py-0.2 rounded text-[9px] bg-purple-50 dark:bg-purple-950/60 text-purple-600 dark:text-purple-300 font-medium shrink-0">
                        <Brain className="w-2.5 h-2.5" />
                        Think
                      </span>
                    )}
                    {isFast && (
                      <span className="inline-flex items-center gap-0.5 px-1 py-0.2 rounded text-[9px] bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-300 font-medium shrink-0">
                        <Zap className="w-2.5 h-2.5" />
                        Fast
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 text-[10px] text-zinc-400">
                    <span className="truncate max-w-[90px]">{provider.name}</span>
                    <span>•</span>
                    <span className="truncate">{model.id}</span>
                  </div>
                </div>

                {isSelected && (
                  <div className="w-4 h-4 rounded-full bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 flex items-center justify-center shrink-0 ml-1">
                    <Check className="w-2.5 h-2.5 stroke-[3]" />
                  </div>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
};

export const ChatInput: React.FC<ChatInputProps> = ({
  input,
  setInput,
  onSend,
  isLoading,
  onStop,
  placeholder = 'Ask anything...',
  disabled = false,
  isCentered = false,
  providers,
  selectedProviderId,
  selectedModelId,
  thinkingLevel,
  onSelectModel,
  onSelectThinkingLevel,
  agentControls,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [thinkingDropdownOpen, setThinkingDropdownOpen] = useState(false);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isInputExpanded, setIsInputExpanded] = useState(false);

  const modelMenuRef = useRef<HTMLDivElement>(null);
  const thinkingMenuRef = useRef<HTMLDivElement>(null);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // Close menus on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setModelDropdownOpen(false);
      }
      if (thinkingMenuRef.current && !thinkingMenuRef.current.contains(e.target as Node)) {
        setThinkingDropdownOpen(false);
      }
      if (plusMenuRef.current && !plusMenuRef.current.contains(e.target as Node)) {
        setPlusMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Process files/folders into Attachment objects
  const processFiles = async (fileList: FileList | File[], isFolder = false) => {
    const newAttachments: Attachment[] = [];
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      if (file.size > 15 * 1024 * 1024) continue; // skip oversized files >15MB

      const isImage = file.type.startsWith('image/');
      let content = '';
      let previewUrl = '';

      if (isImage) {
        previewUrl = URL.createObjectURL(file);
        try {
          content = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve((reader.result as string) || '');
            reader.onerror = () => resolve('');
            reader.readAsDataURL(file);
          });
        } catch (e) {}
      } else {
        try {
          content = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve((reader.result as string) || '');
            reader.onerror = () => resolve('');
            reader.readAsText(file);
          });
        } catch (e) {}
      }

      newAttachments.push({
        id: `att-${Date.now()}-${Math.random().toString(36).substr(2, 5)}-${i}`,
        name: file.name,
        type: isImage ? 'image' : isFolder ? 'folder' : 'file',
        size: file.size,
        content: content.slice(0, 100000),
        previewUrl,
        path: (file as any).webkitRelativePath || file.name,
      });
    }

    setAttachments((prev) => [...prev, ...newAttachments]);
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(e.target.files, false);
      e.target.value = '';
    }
  };

  const handleFolderInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(e.target.files, true);
      e.target.value = '';
    }
  };

  const handleRemoveAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await processFiles(e.dataTransfer.files);
    }
  };

  // Fluid Auto-Grow Textarea: expands smoothly as the user writes more lines
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

    const minHeight = isCentered ? 44 : 32;
    const maxHeight = isCentered ? 220 : 160;

    el.style.height = 'auto';
    const scrollHeight = el.scrollHeight;
    const targetHeight = Math.min(Math.max(scrollHeight, minHeight), maxHeight);
    el.style.height = `${targetHeight}px`;
    el.style.overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden';

    setIsInputExpanded(scrollHeight > minHeight + 6);
  }, [input, isCentered]);

  const canSend = (Boolean(input.trim()) || attachments.length > 0) && !isLoading && !disabled;

  const handleTriggerSend = () => {
    if (!canSend) return;
    onSend(attachments, true);
    setAttachments([]);
    // Reset textarea height back to minimum
    if (textareaRef.current) {
      textareaRef.current.style.height = isCentered ? '44px' : '32px';
      textareaRef.current.style.overflowY = 'hidden';
      setIsInputExpanded(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleTriggerSend();
    }
  };

  // Active provider and model
  const activeProvider = providers.find((p) => p.id === selectedProviderId) || providers[0];
  const activeModel =
    activeProvider?.models.find((m) => m.id === selectedModelId) ||
    activeProvider?.models[0];

  const cleanModelName = (activeModel?.name || activeModel?.id || 'Select Model').replace(
    /^models\//,
    ''
  );

  const thinkingOptions: Array<{ level: ThinkingLevel; iconClass: string; desc: string }> = [
    { level: 'Low', iconClass: 'text-zinc-400', desc: 'Fast, concise answers' },
    { level: 'Medium', iconClass: 'text-zinc-600 dark:text-zinc-300', desc: 'Balanced depth' },
    { level: 'High', iconClass: 'text-indigo-500 dark:text-indigo-400', desc: 'Deep thorough reasoning' },
  ];

  const currentDisplayThinking =
    thinkingLevel === 'Auto' ? 'Med' : thinkingLevel === 'Medium' ? 'Med' : thinkingLevel;

  // --------------------------------------------------------------------------
  // CENTERED MODE: Clean Card in Center of Screen (Welcome Screen)
  // --------------------------------------------------------------------------
  if (isCentered) {
    return (
      <div className="relative w-full max-w-2xl sm:max-w-3xl mx-auto px-4 select-none">
        {agentControls}
        {/* Hidden File and Folder Inputs */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileInputChange}
        />
        <input
          ref={folderInputRef}
          type="file"
          multiple
          {...({ webkitdirectory: '', directory: '' } as any)}
          className="hidden"
          onChange={handleFolderInputChange}
        />

        {/* Centered Card Container */}
        <div
          onDragOver={handleDragOver}
          onDragEnter={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`relative flex flex-col bg-white dark:bg-zinc-900 rounded-2xl sm:rounded-3xl border border-zinc-200/90 dark:border-zinc-800 shadow-[0_4px_24px_rgba(0,0,0,0.06)] dark:shadow-[0_4px_24px_rgba(0,0,0,0.35)] focus-within:border-zinc-300 dark:focus-within:border-zinc-700 transition-all duration-200 ${
            isDraggingOver ? 'ring-2 ring-blue-500/50 dark:ring-blue-400/50 border-blue-500 bg-blue-50/10' : ''
          }`}
        >
          {/* Attached Files & Folders preview chips */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3.5 pt-3">
              {attachments.map((att) => (
                <div
                  key={att.id}
                  className="flex items-center gap-1.5 px-2 py-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200/80 dark:border-zinc-700/80 text-xs text-zinc-700 dark:text-zinc-200"
                >
                  {att.previewUrl ? (
                    <img src={att.previewUrl} alt="" className="w-4 h-4 rounded object-cover" />
                  ) : att.type === 'folder' ? (
                    <Folder className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                  ) : (
                    <File className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                  )}
                  <span className="font-mono text-[11px] truncate max-w-[130px]">{att.name}</span>
                  <span className="text-[10px] text-zinc-400">{Math.round(att.size / 1024) || 1}KB</span>
                  <button
                    type="button"
                    onClick={() => handleRemoveAttachment(att.id)}
                    className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 ml-0.5 cursor-pointer"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Full-width Multiline Textarea */}
          <div className="w-full px-3.5 sm:px-4 pt-3 pb-1">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              disabled={disabled}
              rows={1}
              autoFocus={true}
              style={{ outline: 'none' }}
              className="w-full resize-none bg-transparent leading-relaxed text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 border-none outline-none focus:outline-none focus-visible:outline-none ring-0 focus:ring-0 focus-visible:ring-0 shadow-none text-[15px] p-0 min-h-[44px] max-h-[220px] panel-scroll"
            />
          </div>

          {/* Bottom Toolbar */}
          <div className="flex items-center justify-between px-2.5 sm:px-3 pb-2 pt-1 border-t border-transparent">
            {/* Left Controls: Attach + Model + Think */}
            <div className="flex items-center gap-1 sm:gap-1.5 flex-wrap min-w-0">
              {/* Attach Plus (+) Button */}
              <div className="relative" ref={plusMenuRef}>
                <button
                  type="button"
                  onClick={() => setPlusMenuOpen(!plusMenuOpen)}
                  className="flex items-center justify-center w-7 h-7 rounded-full text-zinc-400 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                  title="Attach file or folder"
                >
                  <Plus className="w-4 h-4 stroke-[2.2]" />
                </button>

                {plusMenuOpen && (
                  <div className="absolute left-0 bottom-full mb-1.5 z-50 w-40 py-1 bg-white dark:bg-zinc-900 rounded-xl shadow-xl border border-zinc-200 dark:border-zinc-800 text-xs animate-in fade-in duration-100">
                    <button
                      type="button"
                      onClick={() => {
                        setPlusMenuOpen(false);
                        fileInputRef.current?.click();
                      }}
                      className="flex items-center gap-2 w-full px-2.5 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-200 cursor-pointer"
                    >
                      <File className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                      <span>Upload Files</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setPlusMenuOpen(false);
                        folderInputRef.current?.click();
                      }}
                      className="flex items-center gap-2 w-full px-2.5 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-200 cursor-pointer"
                    >
                      <Folder className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                      <span>Upload Folder</span>
                    </button>
                  </div>
                )}
              </div>

              {/* Compact Model Selector Button */}
              <div className="relative" ref={modelMenuRef}>
                <button
                  type="button"
                  onClick={() => {
                    setModelDropdownOpen(!modelDropdownOpen);
                    setThinkingDropdownOpen(false);
                  }}
                  className="flex items-center gap-1 h-7 px-2 text-[11.5px] rounded-lg font-medium text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors bg-transparent border-0 cursor-pointer max-w-[150px] sm:max-w-[200px]"
                  title="Select Model"
                >
                  <Sparkles className="w-3 h-3 text-zinc-400 shrink-0" />
                  <span className="truncate">{cleanModelName}</span>
                  <ChevronDown className="w-2.5 h-2.5 text-zinc-400 opacity-70 shrink-0" />
                </button>

                {modelDropdownOpen && (
                  <div className="absolute left-0 bottom-full mb-1.5 z-50">
                    <ModelSelectorDropdown
                      providers={providers}
                      selectedProviderId={selectedProviderId}
                      selectedModelId={selectedModelId}
                      onSelectModel={onSelectModel}
                      onClose={() => setModelDropdownOpen(false)}
                    />
                  </div>
                )}
              </div>

              {/* Think Selector Button */}
              <div className="relative" ref={thinkingMenuRef}>
                <button
                  type="button"
                  onClick={() => {
                    setThinkingDropdownOpen(!thinkingDropdownOpen);
                    setModelDropdownOpen(false);
                  }}
                  className="flex items-center gap-1 h-7 px-2 text-[11.5px] rounded-lg font-medium text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors bg-transparent border-0 cursor-pointer"
                  title="Reasoning Depth"
                >
                  <Brain className="w-3 h-3 text-zinc-400 shrink-0" />
                  <span>Think</span>
                  <span className="text-[10px] text-zinc-400 opacity-80">
                    ({currentDisplayThinking})
                  </span>
                  <ChevronDown className="w-2.5 h-2.5 text-zinc-400 opacity-70 shrink-0" />
                </button>

                {thinkingDropdownOpen && (
                  <div className="absolute left-0 bottom-full mb-1.5 z-50 w-48 py-1 bg-white dark:bg-zinc-900 rounded-xl shadow-xl border border-zinc-200 dark:border-zinc-800 text-xs animate-in fade-in zoom-in-95 duration-100">
                    <div className="px-2.5 py-1 text-[10px] uppercase font-semibold text-zinc-400">
                      Reasoning Depth
                    </div>
                    {thinkingOptions.map((opt) => (
                      <button
                        key={opt.level}
                        type="button"
                        onClick={() => {
                          onSelectThinkingLevel(opt.level);
                          setThinkingDropdownOpen(false);
                        }}
                        className={`flex items-center justify-between w-full px-2.5 py-1.5 text-left transition-colors cursor-pointer ${
                          (thinkingLevel === opt.level || (thinkingLevel === 'Auto' && opt.level === 'Medium'))
                            ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-white font-medium'
                            : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
                        }`}
                      >
                        <div className="flex items-center gap-1.5">
                          <Brain className={`w-3 h-3 shrink-0 ${opt.iconClass}`} />
                          <div>
                            <div className="font-medium text-xs">{opt.level}</div>
                            <div className="text-[9.5px] text-zinc-400">{opt.desc}</div>
                          </div>
                        </div>
                        {(thinkingLevel === opt.level || (thinkingLevel === 'Auto' && opt.level === 'Medium')) && (
                          <Check className="w-3 h-3 text-zinc-900 dark:text-white shrink-0 ml-1.5" />
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Right Action: Send / Stop Button */}
            <div className="flex items-center shrink-0 ml-2">
              {isLoading ? (
                <button
                  type="button"
                  onClick={onStop}
                  title="Stop generation (Esc)"
                  aria-label="Stop generation"
                  className="flex items-center justify-center w-8 h-8 rounded-full bg-zinc-950 dark:bg-white text-white dark:text-zinc-950 hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-all shadow-sm cursor-pointer active:scale-95 group/stop"
                >
                  <div className="w-2.5 h-2.5 bg-white dark:bg-zinc-950 rounded-[2px] transition-transform group-hover/stop:scale-90" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleTriggerSend}
                  disabled={!canSend}
                  aria-label="Send message"
                  title="Send message"
                  className={`flex items-center justify-center w-8 h-8 rounded-full transition-all ${
                    canSend
                      ? 'bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-zinc-200 cursor-pointer shadow-sm active:scale-95'
                      : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-600 cursor-not-allowed'
                  }`}
                >
                  <ArrowUp className="w-4 h-4 stroke-[2.5]" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // --------------------------------------------------------------------------
  // DOCKED MODE: Sleek, Compact Capsule Pill Bar (Active Chat State)
  // Matching how it was before: compact, single-row pill when 1 line!
  // --------------------------------------------------------------------------
  return (
    <div className="relative w-full max-w-3xl mx-auto select-none">
      {agentControls}
      {/* Hidden File and Folder Inputs */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileInputChange}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        {...({ webkitdirectory: '', directory: '' } as any)}
        className="hidden"
        onChange={handleFolderInputChange}
      />

      {/* Attached Files & Folders preview chips if any */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2 px-1">
          {attachments.map((att) => (
            <div
              key={att.id}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200/90 dark:border-zinc-800 shadow-sm text-xs text-zinc-700 dark:text-zinc-200"
            >
              {att.previewUrl ? (
                <img src={att.previewUrl} alt="" className="w-4 h-4 rounded object-cover" />
              ) : att.type === 'folder' ? (
                <Folder className="w-3.5 h-3.5 text-blue-500 shrink-0" />
              ) : (
                <File className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
              )}
              <span className="font-mono text-[11px] truncate max-w-[130px]">{att.name}</span>
              <span className="text-[10px] text-zinc-400">{Math.round(att.size / 1024) || 1}KB</span>
              <button
                type="button"
                onClick={() => handleRemoveAttachment(att.id)}
                className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 ml-0.5 cursor-pointer"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Compact Capsule Pill Container: single horizontal row when 1 line */}
      <div
        onDragOver={handleDragOver}
        onDragEnter={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`relative flex ${isInputExpanded ? 'items-end' : 'items-center'} bg-white dark:bg-zinc-900 ${
          isInputExpanded ? 'rounded-2xl sm:rounded-3xl' : 'rounded-full'
        } border border-zinc-200/90 dark:border-zinc-800 shadow-[0_4px_24px_rgba(0,0,0,0.06)] dark:shadow-[0_4px_24px_rgba(0,0,0,0.35)] pl-2 pr-1.5 py-1.5 focus-within:border-zinc-300 dark:focus-within:border-zinc-700 transition-all ${
          isDraggingOver ? 'ring-2 ring-blue-500/50 dark:ring-blue-400/50 border-blue-500' : ''
        }`}
      >
        {/* Left: Plus (+) Attach Button */}
        <div className="relative shrink-0" ref={plusMenuRef}>
          <button
            type="button"
            onClick={() => setPlusMenuOpen(!plusMenuOpen)}
            className="flex items-center justify-center w-7 h-7 rounded-full text-zinc-400 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            title="Attach file or folder"
          >
            <Plus className="w-4 h-4 stroke-[2.2]" />
          </button>

          {plusMenuOpen && (
            <div className="absolute left-0 bottom-full mb-2 z-50 w-40 py-1 bg-white dark:bg-zinc-900 rounded-xl shadow-xl border border-zinc-200 dark:border-zinc-800 text-xs animate-in fade-in duration-100">
              <button
                type="button"
                onClick={() => {
                  setPlusMenuOpen(false);
                  fileInputRef.current?.click();
                }}
                className="flex items-center gap-2 w-full px-2.5 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-200 cursor-pointer"
              >
                <File className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                <span>Upload Files</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setPlusMenuOpen(false);
                  folderInputRef.current?.click();
                }}
                className="flex items-center gap-2 w-full px-2.5 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-200 cursor-pointer"
              >
                <Folder className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                <span>Upload Folder</span>
              </button>
            </div>
          )}
        </div>

        {/* Compact Model Selector Pill inside the capsule */}
        <div className="relative shrink-0 ml-0.5" ref={modelMenuRef}>
          <button
            type="button"
            onClick={() => {
              setModelDropdownOpen(!modelDropdownOpen);
              setThinkingDropdownOpen(false);
            }}
            className="flex items-center gap-1 h-7 px-2 text-[11px] font-medium rounded-full bg-zinc-100 hover:bg-zinc-200/80 dark:bg-zinc-800/80 dark:hover:bg-zinc-700/80 text-zinc-700 dark:text-zinc-200 transition-colors cursor-pointer max-w-[110px] sm:max-w-[140px]"
            title="Select Model"
          >
            <Sparkles className="w-3 h-3 text-zinc-400 shrink-0" />
            <span className="truncate">{cleanModelName}</span>
            <ChevronDown className="w-2.5 h-2.5 text-zinc-400 opacity-70 shrink-0" />
          </button>

          {modelDropdownOpen && (
            <div className="absolute left-0 bottom-full mb-2 z-50">
              <ModelSelectorDropdown
                providers={providers}
                selectedProviderId={selectedProviderId}
                selectedModelId={selectedModelId}
                onSelectModel={onSelectModel}
                onClose={() => setModelDropdownOpen(false)}
              />
            </div>
          )}
        </div>

        {/* Center: Flexible Textarea */}
        <div className={`flex-1 min-w-0 px-2 flex ${isInputExpanded ? 'items-end' : 'items-center'}`}>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
            style={{ outline: 'none' }}
            className="w-full resize-none bg-transparent leading-relaxed text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 border-none outline-none focus:outline-none focus-visible:outline-none ring-0 focus:ring-0 focus-visible:ring-0 shadow-none text-[14px] sm:text-[14.5px] py-1 min-h-[32px] max-h-[160px] panel-scroll"
          />
        </div>

        {/* Right Controls: Think + Send/Stop Button */}
        <div className="flex items-center gap-1 shrink-0">
          {/* Compact Think Button */}
          <div className="relative" ref={thinkingMenuRef}>
            <button
              type="button"
              onClick={() => {
                setThinkingDropdownOpen(!thinkingDropdownOpen);
                setModelDropdownOpen(false);
              }}
              className="flex items-center gap-1 h-7 px-2 text-[11px] font-medium rounded-full text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors bg-transparent border-0 cursor-pointer"
              title="Reasoning Depth"
            >
              <Brain className="w-3 h-3 text-zinc-400 shrink-0" />
              <span>Think</span>
              <span className="text-[10px] text-zinc-400 opacity-80 hidden sm:inline">
                ({currentDisplayThinking})
              </span>
              <ChevronDown className="w-2.5 h-2.5 text-zinc-400 opacity-70 shrink-0" />
            </button>

            {thinkingDropdownOpen && (
              <div className="absolute right-0 bottom-full mb-2 z-50 w-48 py-1 bg-white dark:bg-zinc-900 rounded-xl shadow-xl border border-zinc-200 dark:border-zinc-800 text-xs animate-in fade-in zoom-in-95 duration-100">
                <div className="px-2.5 py-1 text-[10px] uppercase font-semibold text-zinc-400">
                  Reasoning Depth
                </div>
                {thinkingOptions.map((opt) => (
                  <button
                    key={opt.level}
                    type="button"
                    onClick={() => {
                      onSelectThinkingLevel(opt.level);
                      setThinkingDropdownOpen(false);
                    }}
                    className={`flex items-center justify-between w-full px-2.5 py-1.5 text-left transition-colors cursor-pointer ${
                      (thinkingLevel === opt.level || (thinkingLevel === 'Auto' && opt.level === 'Medium'))
                        ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-white font-medium'
                        : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <Brain className={`w-3 h-3 shrink-0 ${opt.iconClass}`} />
                      <div>
                        <div className="font-medium text-xs">{opt.level}</div>
                        <div className="text-[9.5px] text-zinc-400">{opt.desc}</div>
                      </div>
                    </div>
                    {(thinkingLevel === opt.level || (thinkingLevel === 'Auto' && opt.level === 'Medium')) && (
                      <Check className="w-3 h-3 text-zinc-900 dark:text-white shrink-0 ml-1.5" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Send / Stop Circular Action Button */}
          {isLoading ? (
            <button
              type="button"
              onClick={onStop}
              title="Stop generation (Esc)"
              aria-label="Stop generation"
              className="flex items-center justify-center w-8 h-8 rounded-full bg-zinc-950 dark:bg-white text-white dark:text-zinc-950 hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-all shadow-sm cursor-pointer active:scale-95 group/stop"
            >
              <div className="w-2.5 h-2.5 bg-white dark:bg-zinc-950 rounded-[2px] transition-transform group-hover/stop:scale-90" />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleTriggerSend}
              disabled={!canSend}
              aria-label="Send message"
              title="Send message"
              className={`flex items-center justify-center w-8 h-8 rounded-full transition-all shrink-0 ${
                canSend
                  ? 'bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-zinc-200 cursor-pointer shadow-sm active:scale-95'
                  : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-600 cursor-not-allowed'
              }`}
            >
              <ArrowUp className="w-4 h-4 stroke-[2.5]" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
