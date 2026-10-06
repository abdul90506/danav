import React, { useRef, useEffect, useState, useMemo, useCallback, KeyboardEvent } from 'react';
import {
  ArrowUp,
  Sparkles,
  ChevronDown,
  ChevronUp,
  Brain,
  Check,
  Search,
  X,
  Zap,
  Plus,
  File,
  Folder,
  Loader2,
} from 'lucide-react';
import { useDismissOnOutside } from '../utils/useDismissOnOutside';
import { Attachment, Provider, ThinkingLevel, Model } from '../types';
import { applyMention, mentionQueryAt, rankMentions } from './MentionPicker';
import {
  ATTACHMENT_BUDGET_BYTES,
  MAX_ATTACHMENT_BYTES,
  fitsAttachmentBudget,
  formatBytesAsMegabytes,
  totalPayloadBytes,
} from '../utils/attachmentBudget';

/**
 * Images are sent to the model inline as base64, so a 12MP photo straight off
 * a phone would blow past every provider's request limit (and the browser's
 * localStorage quota). Shrink anything oversized to a sensible edge length
 * first — the model does not need more resolution than this to read a picture.
 */
const MAX_IMAGE_EDGE = 1568;
const MAX_IMAGE_BYTES = 1_500_000;


function readAsDataURL(file: File): Promise<string> {
  return new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string) || '');
    reader.onerror = () => resolve('');
    reader.readAsDataURL(file);
  });
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode image'));
    img.src = src;
  });
}

/** Downscale + re-encode an image so it is safe to send and to store. */
async function prepareImageForModel(file: File): Promise<{ dataUrl: string; bytes: number }> {
  const original = await readAsDataURL(file);
  try {
    const img = await loadImageElement(original);
    const longest = Math.max(img.naturalWidth, img.naturalHeight);
    const scale = longest > MAX_IMAGE_EDGE ? MAX_IMAGE_EDGE / longest : 1;
    if (scale === 1 && file.size <= MAX_IMAGE_BYTES) {
      return { dataUrl: original, bytes: file.size };
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return { dataUrl: original, bytes: file.size };
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    // Keep PNG for PNGs (screenshots, transparency); JPEG for everything else.
    const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const dataUrl = canvas.toDataURL(mime, mime === 'image/jpeg' ? 0.85 : undefined);
    return { dataUrl, bytes: Math.round((dataUrl.length * 3) / 4) };
  } catch {
    return { dataUrl: original, bytes: file.size };
  }
}

interface ChatInputProps {
  /**
   * Bumped by the app when a draft must be thrown away (a new chat, a switched
   * chat). The text itself is local state: keeping it in App meant every keystroke
   * re-rendered the sidebar, the whole message list and both panels, which is what
   * makes typing lag in a long conversation.
   */
  draftResetKey?: number;
  onSend: (attachments: Attachment[] | undefined, text: string) => void;
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
  /**
   * Workspace file paths for @-mentions. Agent mode only: in chat mode there is
   * no workspace, so there is nothing to point at.
   */
  mentionFiles?: string[];
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
    const list: Array<{ provider: Provider; model: Model }> = [];
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
          // A catalogue description often carries the useful word ("vision",
          // "code", "reasoning") that the id does not.
          const matchesDescription = (m.description || '').toLowerCase().includes(q);
          if (matchesName || matchesId || matchesProv || matchesDescription) {
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

  /**
   * Does this model reason?
   *
   * `supportsThinking` is what the provider's own catalogue said when the models
   * were fetched (Novita/OpenRouter/Groq declare `features: [... "reasoning"]`),
   * so it wins. The id heuristic is only the fallback for models that were typed
   * in by hand, or fetched from an API that declares nothing: it cannot see
   * "zai-org/glm-5.3" or "minimax/minimax-m3", and it misfires on unrelated
   * names, so the badge and the Thinking control disagreed with Settings.
   */
  const isThinkingCapable = (model: Model) => {
    if (typeof model.supportsThinking === 'boolean') return model.supportsThinking;
    const id = (model.id || '').toLowerCase();
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
    <div
      id="model-selector-popup"
      role="region"
      aria-label="Model selector"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      className="w-[280px] sm:w-[330px] max-w-[calc(100vw-28px)] max-h-[340px] flex flex-col bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-800 text-xs overflow-hidden animate-in fade-in zoom-in-95 duration-150 select-none z-50"
    >
      {/* Header: Compact Search Box */}
      <div className="p-2 border-b border-zinc-100 dark:border-zinc-800/80">
        <div className="relative flex items-center bg-zinc-100/90 dark:bg-zinc-800/70 rounded-lg px-2 py-1 focus-within:ring-1 focus-within:ring-zinc-400 dark:focus-within:ring-zinc-600 transition-all">
          <Search className="w-3 h-3 text-zinc-400 shrink-0 mr-1.5" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search models..."
            aria-label="Search models"
            autoFocus
            className="w-full bg-transparent text-[12px] text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 outline-none border-none focus:outline-none focus:ring-0 p-0"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label="Clear model search"
              className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 ml-1 cursor-pointer"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* Provider Tabs with Horizontal Scroll */}
        {providers.length > 1 && (
          <div role="group" aria-label="Filter models by provider" className="flex items-center gap-1 mt-1.5 overflow-x-auto no-scrollbar pb-0.5">
            <button
              type="button"
              onClick={() => setActiveTab('all')}
              aria-pressed={activeTab === 'all'}
              className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors shrink-0 cursor-pointer ${
                activeTab === 'all'
                  ? 'bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 shadow-sm'
                  : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'
              }`}
            >
              <span>All</span>
              <span className="opacity-60 text-[10px]">({totalModelsCount})</span>
            </button>
            {providers.map((p) => {
              const isTabActive = activeTab === p.id;
              const count = p.models?.length || 0;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setActiveTab(p.id)}
                  aria-pressed={isTabActive}
                  className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors shrink-0 cursor-pointer ${
                    isTabActive
                      ? 'bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 shadow-sm'
                      : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                  }`}
                >
                  <span className="truncate max-w-[80px]">{p.name}</span>
                  <span className="opacity-60 text-[10px]">({count})</span>
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
            const hasThinking = isThinkingCapable(model);
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
                aria-pressed={isSelected}
                aria-label={`Select ${cleanDisplayName} from ${provider.name}`}
                className={`w-full flex items-center justify-between px-2 py-1.5 rounded-lg text-left transition-all cursor-pointer ${
                  isSelected
                    ? 'bg-zinc-100 dark:bg-zinc-800/90 text-zinc-900 dark:text-white font-medium ring-1 ring-zinc-300/60 dark:ring-zinc-700'
                    : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
                }`}
              >
                <div className="min-w-0 pr-1.5 flex-1">
                  <div className="flex items-center gap-1 flex-wrap">
                    <span className="truncate font-medium text-[12px] text-zinc-900 dark:text-zinc-100">
                      {cleanDisplayName}
                    </span>
                    {hasThinking && (
                      <span className="inline-flex items-center gap-0.5 px-1 py-0.2 rounded text-[10px] bg-purple-50 dark:bg-purple-950/60 text-purple-600 dark:text-purple-300 font-medium shrink-0">
                        <Brain className="w-2.5 h-2.5" />
                        Think
                      </span>
                    )}
                    {isFast && (
                      <span className="inline-flex items-center gap-0.5 px-1 py-0.2 rounded text-[10px] bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-300 font-medium shrink-0">
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

const ChatInputInner: React.FC<ChatInputProps> = ({
  draftResetKey = 0,
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
  mentionFiles,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ---- @-mentions ------------------------------------------------------------
  const [mentionCursor, setMentionCursor] = useState(0);
  const [mention, setMention] = useState<{ query: string; start: number; end: number } | null>(null);
  const mentionHits = useMemo(
    () => (mention && mentionFiles?.length ? rankMentions(mention.query, mentionFiles) : []),
    [mention, mentionFiles]
  );
  const mentionOpen = !!mention && mentionHits.length > 0;

  /** Re-read the caret after any edit or move, so the picker tracks it. */
  const syncMention = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el || !mentionFiles?.length) { setMention(null); return; }
    const caret = el.selectionStart ?? 0;
    const found = el.selectionStart === el.selectionEnd ? mentionQueryAt(el.value, caret) : null;
    setMention(found ? { query: found.query, start: found.start, end: caret } : null);
    setMentionCursor(0);
  }, [mentionFiles]);

  const acceptMention = useCallback((path: string) => {
    const el = textareaRef.current;
    if (!el || !mention) return;
    const next = applyMention(el.value, mention.start, mention.end, path);
    setDraft(next.text);
    setMention(null);
    // The value lands on the next render; move the caret after that so it is not
    // dragged to the end of the box.
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(next.caret, next.caret);
    });
  }, [mention]);
  const composerRootRef = useRef<HTMLDivElement>(null);
  const attachTriggerRef = useRef<HTMLButtonElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const thinkingTriggerRef = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState('');
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [thinkingDropdownOpen, setThinkingDropdownOpen] = useState(false);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  /** Keep the latest list available to queued file-processing jobs. */
  const attachmentsRef = useRef<Attachment[]>([]);
  /** A send waits until every selected/dropped file is ready. */
  const [pendingFileCount, setPendingFileCount] = useState(0);
  const pendingFileCountRef = useRef(0);
  const attachmentEpochRef = useRef(0);
  const processQueueRef = useRef<Promise<void>>(Promise.resolve());
  /** Why a dropped or picked file did not attach — shown once above the composer. */
  const [attachmentNotice, setAttachmentNotice] = useState('');
  /** Docked controls bar: hidden until you reach for the arrow, click to pin. */
  const [controlsPinned, setControlsPinned] = useState(false);

  const modelMenuRef = useRef<HTMLDivElement>(null);
  const thinkingMenuRef = useRef<HTMLDivElement>(null);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // A pinned controls bar lets go when you click anywhere outside it.
  useEffect(() => {
    if (!controlsPinned) return;
    const onDown = (e: MouseEvent) => {
      if (controlsRef.current && !controlsRef.current.contains(e.target as Node)) {
        setControlsPinned(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [controlsPinned]);

  // Menus: an outside click, Escape, or simply opening another one closes this
  // one — the user never has to close a menu before opening the next.
  const closeModelMenu = useCallback(() => setModelDropdownOpen(false), []);
  const closeThinkingMenu = useCallback(() => setThinkingDropdownOpen(false), []);
  const closePlusMenu = useCallback(() => setPlusMenuOpen(false), []);
  useDismissOnOutside(modelMenuRef, modelDropdownOpen, closeModelMenu);
  useDismissOnOutside(thinkingMenuRef, thinkingDropdownOpen, closeThinkingMenu);
  useDismissOnOutside(plusMenuRef, plusMenuOpen, closePlusMenu);

  // Process file batches in order so simultaneous drops/selections share one
  // attachment budget and cannot sneak into a different chat after a reset.
  const processFiles = (fileList: FileList | File[], isFolder = false): Promise<void> => {
    const files = Array.from(fileList);
    if (files.length === 0) return Promise.resolve();

    const epoch = attachmentEpochRef.current;
    pendingFileCountRef.current += files.length;
    setPendingFileCount(pendingFileCountRef.current);

    const job = processQueueRef.current
      .then(async () => {
        if (epoch !== attachmentEpochRef.current) return;
        const newAttachments: Attachment[] = [];
        const skipped: string[] = [];
        // What this message would carry after the new files are added.
        let payloadBytes = totalPayloadBytes(attachmentsRef.current);

        for (let i = 0; i < files.length; i++) {
          if (epoch !== attachmentEpochRef.current) return;
          const file = files[i];
          if (file.size > MAX_ATTACHMENT_BYTES) {
            skipped.push(`${file.name} is over ${formatBytesAsMegabytes(MAX_ATTACHMENT_BYTES)}`);
            continue;
          }

          const isImage = file.type.startsWith('image/');
          let content = '';
          let previewUrl = '';
          let size = file.size;

          let readFailed = false;
          if (isImage) {
            // The data URL is both the preview and the payload sent to the model,
            // so the thumbnail survives a reload instead of dying with a blob URL.
            try {
              const prepared = await prepareImageForModel(file);
              content = prepared.dataUrl;
              previewUrl = prepared.dataUrl;
              size = prepared.bytes;
            } catch {
              readFailed = true;
            }
          } else {
            try {
              content = await new Promise<string>((resolve) => {
                const reader = new FileReader();
                reader.onload = () => resolve((reader.result as string) || '');
                reader.onerror = () => {
                  readFailed = true;
                  resolve('');
                };
                reader.readAsText(file);
              });
            } catch {
              readFailed = true;
            }
          }

          if (readFailed) {
            skipped.push(`${file.name} could not be read`);
            continue;
          }
          if (epoch !== attachmentEpochRef.current) return;
          // Images carry their whole data URL; text files are capped so a huge log
          // does not dominate the prompt.
          const storedContent = isImage ? content : content.slice(0, 100000);
          if (!fitsAttachmentBudget(payloadBytes, storedContent.length)) {
            skipped.push(`${file.name} would take this message over the ${formatBytesAsMegabytes(ATTACHMENT_BUDGET_BYTES)} limit`);
            continue;
          }
          payloadBytes += storedContent.length;

          newAttachments.push({
            id: `att-${Date.now()}-${Math.random().toString(36).substr(2, 5)}-${i}`,
            name: file.name,
            type: isImage ? 'image' : isFolder ? 'folder' : 'file',
            size,
            content: storedContent,
            previewUrl,
            path: (file as any).webkitRelativePath || file.name,
          });
        }

        if (epoch !== attachmentEpochRef.current) return;
        if (newAttachments.length > 0) {
          attachmentsRef.current = [...attachmentsRef.current, ...newAttachments];
          setAttachments(attachmentsRef.current);
        }
        setAttachmentNotice(
          skipped.length
            ? `Not attached — ${skipped.slice(0, 2).join('; ')}${skipped.length > 2 ? `; and ${skipped.length - 2} more` : ''}.`
            : ''
        );
      })
      .catch((error: unknown) => {
        if (epoch !== attachmentEpochRef.current) return;
        const reason = error instanceof Error ? error.message : 'the file could not be read';
        setAttachmentNotice(`Could not prepare the attachments — ${reason}.`);
      });

    const trackedJob = job.finally(() => {
      if (epoch !== attachmentEpochRef.current) return;
      pendingFileCountRef.current = Math.max(0, pendingFileCountRef.current - files.length);
      setPendingFileCount(pendingFileCountRef.current);
    });
    processQueueRef.current = trackedJob;
    return trackedJob;
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
    attachmentsRef.current = attachmentsRef.current.filter((attachment) => attachment.id !== id);
    setAttachments(attachmentsRef.current);
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

  /**
   * Auto-grow that does not fight the caret.
   *
   * The old version set `height:auto` on every keystroke to measure the content,
   * which collapses the box for a moment: on a long prompt (past max-height) the
   * textarea scrolls back to the top and the whole prompt visibly jumps while you
   * type, and every keystroke forces a full-document reflow. `scrollHeight` is
   * already the content height, so we only need to collapse when the text got
   * SHORTER than the box — that is the one case where the current height would
   * hide the real content height.
   */
  const lastDraftLengthRef = useRef(0);
  const publishComposerOverflow = () => {
    const height = composerRootRef.current?.getBoundingClientRect().height ?? 96;
    const extra = Math.max(0, height - 96);
    if (extra > 0) document.documentElement.style.setProperty('--danav-composer-extra', `${Math.round(extra)}px`);
    else document.documentElement.style.removeProperty('--danav-composer-extra');
  };
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

    const minHeight = isCentered ? 44 : 32;
    const maxHeight = isCentered ? 220 : 160;
    const current = parseFloat(el.style.height) || 0;
    const shrunk =
      draft.length < lastDraftLengthRef.current || current < minHeight || (isCentered && current > maxHeight);
    lastDraftLengthRef.current = draft.length;

    if (shrunk) el.style.height = 'auto';
    const contentHeight = el.scrollHeight;
    const targetHeight = Math.min(Math.max(contentHeight, minHeight), maxHeight);
    if (Math.abs(targetHeight - (parseFloat(el.style.height) || 0)) > 0.5) {
      el.style.height = `${targetHeight}px`;
    }
    el.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';

    /**
     * Publish the actual composer's overflow (including its controls/attachments)
     * without React state, so the transcript clears the floating panel smoothly.
     */
    publishComposerOverflow();

  }, [draft, isCentered, draftResetKey]);

  // A docked preview or a narrow viewport can change the chat width without
  // changing the draft. Re-measure only on width changes so wrapped text never
  // gets clipped, without measuring again for the textarea's own height updates.
  useEffect(() => {
    const el = textareaRef.current;
    const parent = el?.parentElement;
    const root = composerRootRef.current;
    if (!el || !parent || !root || typeof ResizeObserver === 'undefined') return;

    const minHeight = isCentered ? 44 : 32;
    const maxHeight = isCentered ? 220 : 160;
    let previousWidth = parent.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const width = parent.getBoundingClientRect().width;
      if (Math.abs(width - previousWidth) >= 1) {
        previousWidth = width;
        el.style.height = 'auto';
        const contentHeight = el.scrollHeight;
        const targetHeight = Math.min(Math.max(contentHeight, minHeight), maxHeight);
        el.style.height = `${targetHeight}px`;
        el.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
      }
      // Also tracks control reveal, attachment chips and the composer itself.
      publishComposerOverflow();
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [isCentered]);

  /**
   * The app bumps `draftResetKey` when the draft must go: it sent the message, or
   * you switched chats. Clearing it here (instead of in the app) is what keeps
   * typing local to this component — and the same effect puts the caret straight
   * back in the box, so you can keep typing without clicking it again. This also
   * runs when the composer is swapped for the other layout, which is a different
   * DOM node: sending the very first message used to drop the focus there.
   */
  useEffect(() => {
    if (!draftResetKey) return;
    // Any in-flight read belongs to the old chat/draft. Invalidate it before it
    // can append a late file to the next conversation.
    attachmentEpochRef.current += 1;
    processQueueRef.current = Promise.resolve();
    attachmentsRef.current = [];
    pendingFileCountRef.current = 0;
    setPendingFileCount(0);
    setAttachments([]);
    setAttachmentNotice('');
    setDraft('');
    lastDraftLengthRef.current = 0;
    document.documentElement.style.removeProperty('--danav-composer-extra');
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = '';
    el.style.overflowY = 'hidden';
    if (document.activeElement !== el) el.focus({ preventScroll: true });
  }, [draftResetKey]);

  // Leaving the chat (or the composer) must not leave a gap or let an unfinished
  // file read call setState after it has been detached from the UI.
  useEffect(
    () => () => {
      attachmentEpochRef.current += 1;
      attachmentsRef.current = [];
      document.documentElement.style.removeProperty('--danav-composer-extra');
    },
    []
  );

  const canSend =
    (Boolean(draft.trim()) || attachments.length > 0) &&
    pendingFileCount === 0 &&
    !isLoading &&
    !disabled;

  const attachmentFeedback = pendingFileCount > 0 ? (
    <p className="flex items-center gap-1.5 px-1 py-1 text-[11px] text-zinc-500 dark:text-zinc-400" role="status" aria-live="polite">
      <Loader2 className="w-3 h-3 animate-spin shrink-0" />
      Preparing {pendingFileCount} file{pendingFileCount === 1 ? '' : 's'} — send will be available when ready.
    </p>
  ) : attachmentNotice ? (
    <p className="px-1 py-1 text-[11px] text-amber-600 dark:text-amber-400" role="status" aria-live="polite">
      {attachmentNotice}
    </p>
  ) : null;

  const handleTriggerSend = () => {
    if (!canSend) return;
    // The draft is cleared by the app's reset too, but clearing it here keeps the
    // box from holding a stale message for a frame while the request goes out.
    const readyAttachments = attachmentsRef.current;
    onSend(readyAttachments.length > 0 ? readyAttachments : undefined, draft);
    setDraft('');
    attachmentsRef.current = [];
    setAttachments([]);
    setAttachmentNotice('');
    if (textareaRef.current) {
      textareaRef.current.style.height = '';
      textareaRef.current.style.overflowY = 'hidden';
    }
    document.documentElement.style.removeProperty('--danav-composer-extra');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // The mention picker owns the arrows and Enter while it is up: Enter there
    // means "take this file", not "send the half-written message".
    if (mentionOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionCursor((c) => (c + 1) % mentionHits.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionCursor((c) => (c - 1 + mentionHits.length) % mentionHits.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (e.nativeEvent?.isComposing) return;
        e.preventDefault();
        acceptMention(mentionHits[mentionCursor].path);
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); setMention(null); return; }
    }
    // Enter sends, Shift+Enter makes a new line — except while an input method is
    // composing (Urdu, Arabic, Chinese, Japanese keyboards use Enter to accept a
    // candidate). Sending there would cut the word the user is still choosing, so
    // the IME gets the key first.
    if (e.key !== 'Enter' || e.shiftKey) return;
    if (e.nativeEvent?.isComposing || (e as unknown as { isComposing?: boolean }).isComposing) return;
    e.preventDefault();
    handleTriggerSend();
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
    { level: 'Auto', iconClass: 'text-zinc-400', desc: 'Use the model’s default effort' },
    { level: 'Low', iconClass: 'text-zinc-400', desc: 'Fast, concise answers' },
    { level: 'Medium', iconClass: 'text-zinc-600 dark:text-zinc-300', desc: 'Balanced depth' },
    { level: 'High', iconClass: 'text-indigo-500 dark:text-indigo-400', desc: 'Deeper reasoning and checks' },
  ];

  // Never label Auto as Medium: Gemini Flash-Lite has its own Auto default.
  const currentDisplayThinking = thinkingLevel === 'Medium' ? 'Med' : thinkingLevel;

  /**
   * The @-mention list. Sits above the composer rather than below it: the
   * composer is already at the bottom of the window, so a dropdown would open
   * off-screen.
   */
  const mentionPanel = mentionOpen ? (
    <div
      role="listbox"
      aria-label="Workspace files"
      className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl"
    >
      <div className="max-h-60 overflow-y-auto py-1">
        {mentionHits.map((hit, i) => {
          const slash = hit.path.lastIndexOf('/');
          const dir = slash === -1 ? '' : hit.path.slice(0, slash + 1);
          const base = hit.path.slice(slash + 1);
          return (
            <div
              key={hit.path}
              role="option"
              aria-selected={i === mentionCursor}
              // Pointer-down, not click: the textarea's blur would close the
              // list before a click ever landed.
              onPointerDown={(e) => { e.preventDefault(); acceptMention(hit.path); }}
              onPointerMove={() => setMentionCursor(i)}
              className={`mx-1 flex cursor-pointer items-baseline gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] ${
                i === mentionCursor ? 'bg-zinc-100 dark:bg-zinc-800' : ''
              }`}
            >
              {dir && <span className="shrink-0 truncate text-[11.5px] text-zinc-400 dark:text-zinc-500">{dir}</span>}
              <span className="truncate text-zinc-800 dark:text-zinc-200">{base}</span>
            </div>
          );
        })}
      </div>
      <div className="border-t border-zinc-200 dark:border-zinc-800 px-2.5 py-1 text-[10.5px] text-zinc-400 dark:text-zinc-500">
        ↑↓ pick · ↵ insert · esc dismiss
      </div>
    </div>
  ) : null;

  // --------------------------------------------------------------------------
  // CENTERED MODE: Clean Card in Center of Screen (Welcome Screen)
  // --------------------------------------------------------------------------
  if (isCentered) {
    return (
      <div className="relative w-full max-w-2xl sm:max-w-3xl mx-auto px-4 select-none">
        {mentionPanel}
        {agentControls && <div className="px-1 pb-2">{agentControls}</div>}
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
                  <span className="font-mono text-[11px] truncate max-w-[130px]" title={att.name}>{att.name}</span>
                  <span className="text-[10px] text-zinc-400">{Math.round(att.size / 1024) || 1}KB</span>
                  <button
                    type="button"
                    onClick={() => handleRemoveAttachment(att.id)}
                    aria-label={`Remove ${att.name}`}
                    title={`Remove ${att.name}`}
                    className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 ml-0.5 cursor-pointer"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {attachmentFeedback}

          {/* Full-width Multiline Textarea */}
          <div className="w-full px-3.5 sm:px-4 pt-3 pb-1">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => { setDraft(e.target.value); syncMention(e.target); }}
              onKeyDown={handleKeyDown}
              onKeyUp={(e) => syncMention(e.currentTarget)}
              onClick={(e) => syncMention(e.currentTarget)}
              onBlur={() => setMention(null)}
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
                  ref={attachTriggerRef}
                  type="button"
                  onClick={() => setPlusMenuOpen((open) => !open)}
                  className="flex items-center justify-center w-7 h-7 rounded-full text-zinc-400 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                  title="Attach file or folder"
                  aria-label="Attach file or folder"
                  aria-expanded={plusMenuOpen}
                  aria-controls="attachment-options"
                >
                  <Plus className="w-4 h-4 stroke-[2.2]" />
                </button>

                {plusMenuOpen && (
                  <div
                    id="attachment-options"
                    role="group"
                    aria-label="Attachment options"
                    onKeyDown={(event) => {
                      if (event.key !== 'Escape') return;
                      event.preventDefault();
                      event.stopPropagation();
                      setPlusMenuOpen(false);
                      attachTriggerRef.current?.focus({ preventScroll: true });
                    }}
                    className="absolute left-0 bottom-full mb-1.5 z-50 w-40 py-1 bg-white dark:bg-zinc-900 rounded-xl shadow-xl border border-zinc-200 dark:border-zinc-800 text-xs animate-in fade-in duration-100"
                  >
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
                  ref={modelTriggerRef}
                  type="button"
                  onClick={() => {
                    setModelDropdownOpen(!modelDropdownOpen);
                    setThinkingDropdownOpen(false);
                  }}
                  aria-label={`Select model, current ${cleanModelName}`}
                  aria-expanded={modelDropdownOpen}
                  aria-controls="model-selector-popup"
                  className="flex items-center gap-1 h-7 px-2 text-[12px] rounded-lg font-medium text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors bg-transparent border-0 cursor-pointer max-w-[150px] sm:max-w-[200px]"
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
                      onClose={() => {
                        setModelDropdownOpen(false);
                        modelTriggerRef.current?.focus({ preventScroll: true });
                      }}
                    />
                  </div>
                )}
              </div>

              {/* Think Selector Button */}
              <div className="relative shrink-0" ref={thinkingMenuRef}>
                <button
                  ref={thinkingTriggerRef}
                  type="button"
                  onClick={() => {
                    setThinkingDropdownOpen((open) => !open);
                    setModelDropdownOpen(false);
                  }}
                  aria-label={`Reasoning depth: ${thinkingLevel}`}
                  aria-expanded={thinkingDropdownOpen}
                  aria-controls="thinking-options"
                  className="flex shrink-0 items-center gap-1 whitespace-nowrap h-7 px-2 text-[12px] rounded-lg font-medium text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors bg-transparent border-0 cursor-pointer"
                  title={`Reasoning depth: ${thinkingLevel}`}
                >
                  <Brain className="w-3 h-3 text-zinc-400 shrink-0" />
                  <span>Think</span>
                  <span className="shrink-0 text-[10px] text-zinc-400 opacity-80">
                    ({currentDisplayThinking})
                  </span>
                  <ChevronDown className="w-2.5 h-2.5 text-zinc-400 opacity-70 shrink-0" />
                </button>

                {thinkingDropdownOpen && (
                  <div
                    id="thinking-options"
                    role="group"
                    aria-label="Reasoning depth options"
                    onKeyDown={(event) => {
                      if (event.key !== 'Escape') return;
                      event.preventDefault();
                      event.stopPropagation();
                      setThinkingDropdownOpen(false);
                      thinkingTriggerRef.current?.focus({ preventScroll: true });
                    }}
                    className="absolute right-0 bottom-full mb-1.5 z-50 w-48 max-w-[calc(100vw-2rem)] py-1 bg-white dark:bg-zinc-900 rounded-xl shadow-xl border border-zinc-200 dark:border-zinc-800 text-xs animate-in fade-in zoom-in-95 duration-100"
                  >
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
                          thinkingTriggerRef.current?.focus({ preventScroll: true });
                        }}
                        aria-pressed={thinkingLevel === opt.level}
                        className={`flex items-center justify-between w-full px-2.5 py-1.5 text-left transition-colors cursor-pointer ${
                          thinkingLevel === opt.level
                            ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-white font-medium'
                            : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
                        }`}
                      >
                        <div className="flex items-center gap-1.5">
                          <Brain className={`w-3 h-3 shrink-0 ${opt.iconClass}`} />
                          <div>
                            <div className="font-medium text-xs">{opt.level}</div>
                            <div className="text-[10px] text-zinc-400">{opt.desc}</div>
                          </div>
                        </div>
                        {thinkingLevel === opt.level && (
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
  // --------------------------------------------------------------------------
  // The controls are built once and placed two ways: beside the text on a
  // single line (the compact pill), or on their own row underneath once the
  // text wraps — so the message can use the FULL width of the box instead of
  // being squeezed into the column between the + and the Think button.
  const attachControl = (
    <div className="relative shrink-0" ref={plusMenuRef}>
      <button
        ref={attachTriggerRef}
        type="button"
        onClick={() => setPlusMenuOpen((open) => !open)}
        className="flex items-center justify-center w-7 h-7 rounded-full text-zinc-400 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
        title="Attach file or folder"
        aria-label="Attach file or folder"
        aria-expanded={plusMenuOpen}
        aria-controls="attachment-options"
      >
        <Plus className="w-4 h-4 stroke-[2.2]" />
      </button>

      {plusMenuOpen && (
        <div
          id="attachment-options"
          role="group"
          aria-label="Attachment options"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            setPlusMenuOpen(false);
            attachTriggerRef.current?.focus({ preventScroll: true });
          }}
          className="absolute left-0 bottom-full mb-2 z-50 w-40 py-1 bg-white dark:bg-zinc-900 rounded-xl shadow-xl border border-zinc-200 dark:border-zinc-800 text-xs animate-in fade-in duration-100"
        >
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
  );

  const thinkControl = (
    <div className="relative shrink-0" ref={thinkingMenuRef}>
      <button
        ref={thinkingTriggerRef}
        type="button"
        onClick={() => {
          setThinkingDropdownOpen((open) => !open);
          setModelDropdownOpen(false);
        }}
        aria-label={`Reasoning depth: ${thinkingLevel}`}
        aria-expanded={thinkingDropdownOpen}
        aria-controls="thinking-options"
        className="flex shrink-0 items-center gap-1 whitespace-nowrap h-7 px-1.5 sm:px-2 text-[11px] font-medium rounded-full text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors bg-transparent border-0 cursor-pointer"
        title={`Reasoning depth: ${thinkingLevel}`}
      >
        <Brain className="w-3 h-3 text-zinc-400 shrink-0" />
        <span>Think</span>
        <span className="shrink-0 text-[10px] text-zinc-400 opacity-80">
          ({currentDisplayThinking})
        </span>
        <ChevronDown className="w-2.5 h-2.5 text-zinc-400 opacity-70 shrink-0" />
      </button>

      {thinkingDropdownOpen && (
        <div
          id="thinking-options"
          role="group"
          aria-label="Reasoning depth options"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            setThinkingDropdownOpen(false);
            thinkingTriggerRef.current?.focus({ preventScroll: true });
          }}
          className="absolute right-0 bottom-full mb-2 z-50 w-48 max-w-[calc(100vw-2rem)] py-1 bg-white dark:bg-zinc-900 rounded-xl shadow-xl border border-zinc-200 dark:border-zinc-800 text-xs animate-in fade-in zoom-in-95 duration-100"
        >
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
                thinkingTriggerRef.current?.focus({ preventScroll: true });
              }}
              aria-pressed={thinkingLevel === opt.level}
              className={`flex items-center justify-between w-full px-2.5 py-1.5 text-left transition-colors cursor-pointer ${
                thinkingLevel === opt.level
                  ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-white font-medium'
                  : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <Brain className={`w-3 h-3 shrink-0 ${opt.iconClass}`} />
                <div>
                  <div className="font-medium text-xs">{opt.level}</div>
                  <div className="text-[10px] text-zinc-400">{opt.desc}</div>
                </div>
              </div>
              {thinkingLevel === opt.level && (
                <Check className="w-3 h-3 text-zinc-900 dark:text-white shrink-0 ml-1.5" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const sendControl = isLoading ? (
    <button
      type="button"
      onClick={onStop}
      title="Stop generation (Esc)"
      aria-label="Stop generation"
      className="flex items-center justify-center w-8 h-8 rounded-full bg-zinc-950 dark:bg-white text-white dark:text-zinc-950 hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-all shadow-sm cursor-pointer active:scale-95 group/stop shrink-0"
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
  );

  const textarea = (
    <textarea
      ref={textareaRef}
      value={draft}
      onChange={(e) => { setDraft(e.target.value); syncMention(e.target); }}
      onKeyDown={handleKeyDown}
      onKeyUp={(e) => syncMention(e.currentTarget)}
      onClick={(e) => syncMention(e.currentTarget)}
      onBlur={() => setMention(null)}
      placeholder={placeholder}
      disabled={disabled}
      rows={1}
      style={{ outline: 'none', maxHeight: `${isCentered ? 220 : 160}px` }}
      className="w-full resize-none bg-transparent leading-relaxed text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 border-none outline-none focus:outline-none focus-visible:outline-none ring-0 focus:ring-0 focus-visible:ring-0 shadow-none text-[14px] sm:text-[14.5px] py-1 min-h-[32px] panel-scroll transition-[height] duration-100 ease-out motion-reduce:transition-none"
    />
  );

  return (
    <div ref={composerRootRef} className="relative w-full max-w-3xl mx-auto select-none">
        {mentionPanel}
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
              <span className="font-mono text-[11px] truncate max-w-[130px]" title={att.name}>{att.name}</span>
              <span className="text-[10px] text-zinc-400">{Math.round(att.size / 1024) || 1}KB</span>
              <button
                type="button"
                onClick={() => handleRemoveAttachment(att.id)}
                aria-label={`Remove ${att.name}`}
                title={`Remove ${att.name}`}
                className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 ml-0.5 cursor-pointer"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {attachmentFeedback}

      {/* ------------------------------------------------------------------
          Docked controls, out of the way until you reach for them.
          The arrow is invisible until you hover its spot; hovering opens the
          bar, moving away closes it, and a click pins it open. The bar holds
          the Agent switch, workspace, Files and the model selector, so the
          input pill itself stays clean.
      ------------------------------------------------------------------ */}
      <div className="relative flex flex-col-reverse items-center mb-1" ref={controlsRef}>
        {/* Handle: first in the DOM so `flex-col-reverse` puts it at the bottom,
            which lets the CSS reach the panel that follows it. Invisible until
            you hover its own small spot. */}
        <button
          type="button"
          onClick={() => setControlsPinned((v) => !v)}
          aria-expanded={controlsPinned}
          aria-label="Chat controls"
          title="Chat controls"
          data-pinned={controlsPinned ? 'true' : 'false'}
          className="ctrl-handle group/handle flex items-end justify-center w-24 h-6 pt-1.5 cursor-pointer"
        >
          <span className="flex items-center justify-center w-16 h-3.5 rounded-full bg-white/85 dark:bg-zinc-900/85 border border-zinc-200/80 dark:border-zinc-800 shadow-sm transition-colors group-hover/handle:border-zinc-300 dark:group-hover/handle:border-zinc-700">
            <ChevronUp
              className={`w-3 h-3 text-zinc-400 transition-transform duration-200 ${
                controlsPinned ? 'rotate-180' : ''
              }`}
            />
          </span>
        </button>

        {/* Panel: second in the DOM so it renders above the handle. */}
        <div
          onMouseDown={() => setControlsPinned(true)}
          data-pinned={controlsPinned ? 'true' : 'false'}
          className="ctrl-panel w-full"
        >
          <div className="flex justify-center">
            <div className="inline-flex flex-wrap items-center justify-center gap-1.5 rounded-2xl border border-zinc-200/90 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/90 backdrop-blur-sm px-2 py-1.5 shadow-[0_4px_18px_rgba(0,0,0,0.05)] dark:shadow-[0_4px_18px_rgba(0,0,0,0.35)]">
              {agentControls}

              {/* Model selector — moved out of the pill into this bar */}
              <div className="relative" ref={modelMenuRef}>
                <button
                  ref={modelTriggerRef}
                  type="button"
                  onClick={() => {
                    setModelDropdownOpen(!modelDropdownOpen);
                    setThinkingDropdownOpen(false);
                  }}
                  aria-label={`Select model, current ${cleanModelName}`}
                  aria-expanded={modelDropdownOpen}
                  aria-controls="model-selector-popup"
                  className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[12px] font-medium border border-zinc-200 dark:border-zinc-800 bg-white/70 dark:bg-zinc-900/60 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors cursor-pointer max-w-[200px]"
                  title="Select Model"
                >
                  <Sparkles className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                  <span className="truncate">{cleanModelName}</span>
                  <ChevronDown className="w-3 h-3 opacity-60 shrink-0" />
                </button>

                {modelDropdownOpen && (
                  <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-1.5 z-50">
                    <ModelSelectorDropdown
                      providers={providers}
                      selectedProviderId={selectedProviderId}
                      selectedModelId={selectedModelId}
                      onSelectModel={onSelectModel}
                      onClose={() => {
                        setModelDropdownOpen(false);
                        modelTriggerRef.current?.focus({ preventScroll: true });
                      }}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Stable two-row composer: the text area never changes shape or swaps
          positions with the controls as the prompt grows. */}
      <div
        onDragOver={handleDragOver}
        onDragEnter={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        data-testid="chat-composer"
        className={`relative rounded-2xl sm:rounded-3xl border border-zinc-200/90 bg-white shadow-[0_4px_24px_rgba(0,0,0,0.06)] transition-colors dark:border-zinc-800 dark:bg-zinc-900 dark:shadow-[0_4px_24px_rgba(0,0,0,0.35)] focus-within:border-zinc-300 dark:focus-within:border-zinc-700 ${
          isDraggingOver ? 'ring-2 ring-blue-500/50 dark:ring-blue-400/50 border-blue-500' : ''
        }`}
      >
        <div className="flex min-w-0 flex-col px-2 pt-1.5 pb-1.5">
          <div className="w-full min-w-0 px-1.5 pt-1">
            {textarea}
          </div>
          <div className="flex w-full min-w-0 items-center justify-between gap-2 px-1">
            <div className="flex min-w-0 items-center gap-1">
              {attachControl}
              {thinkControl}
            </div>
            <div className="shrink-0">{sendControl}</div>
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * Memoised: the composer is a big subtree, and the app re-renders on every token
 * of a streaming answer. With stable props (useStable) React skips it entirely
 * while the agent works, so the box you are typing in never rebuilds under you.
 */
export const ChatInput = React.memo(ChatInputInner);
ChatInput.displayName = 'ChatInput';
