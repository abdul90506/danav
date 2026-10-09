import React, { useState, useMemo, useRef, useCallback } from 'react';
import {
  SquarePen,
  Search,
  Command,
  Settings as SettingsIcon,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Trash2,
  Pin,
  ChevronDown,
  PanelLeftClose,
  X,
  Check,
} from 'lucide-react';
import { Conversation } from '../types';
import { useDismissOnOutside, useEscapeToClose, useFocusTrap } from '../utils/useDismissOnOutside';

interface SidebarProps {
  conversations: Conversation[];
  activeChatId: string | null;
  onSelectChat: (id: string) => void;
  onNewChat: () => void;
  onRenameChat: (id: string, newTitle: string) => void;
  onDeleteChat: (id: string) => void;
  onTogglePinChat?: (id: string) => void;
  onOpenSettings: () => void;
  /** Opens the command palette; the sidebar shows the shortcut so it is findable. */
  onOpenPalette?: () => void;
  /** ⌘ or Ctrl, decided once by the app rather than guessed per component. */
  modKey?: string;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  isMobileOpen: boolean;
  onCloseMobile: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  conversations,
  activeChatId,
  onSelectChat,
  onNewChat,
  onOpenPalette,
  modKey = 'Ctrl',
  onRenameChat,
  onDeleteChat,
  onTogglePinChat,
  onOpenSettings,
  isCollapsed,
  onToggleCollapse,
  isMobileOpen,
  onCloseMobile,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isRecentsCollapsed, setIsRecentsCollapsed] = useState(false);
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  /** The row whose "more" menu is open — the menu closes when you click away from it. */
  const menuWrapRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const closeMenu = useCallback(() => setMenuOpenId(null), []);
  const closeSearch = useCallback(() => {
    setIsSearchOpen(false);
    setSearchQuery('');
  }, []);
  const closeMobileDrawer = useCallback(() => {
    closeSearch();
    onCloseMobile();
  }, [closeSearch, onCloseMobile]);
  useDismissOnOutside(menuWrapRef, menuOpenId !== null, closeMenu);
  useEscapeToClose(closeMobileDrawer, isMobileOpen);
  // Search is a small revealed surface too: Escape clears it before it can reach
  // the chat's stop-generation shortcut.
  useEscapeToClose(closeSearch, isSearchOpen && (!isCollapsed || isMobileOpen));
  useFocusTrap(asideRef, isMobileOpen);

  const orderedConversations = useMemo(
    () => [...conversations].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
    [conversations]
  );

  // Filter conversations by title, message text, and attached filename.
  const filteredConversations = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return orderedConversations;
    return orderedConversations.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.messages.some(
          (m) =>
            m.content.toLowerCase().includes(q) ||
            m.attachments?.some((attachment) => attachment.name.toLowerCase().includes(q))
        )
    );
  }, [orderedConversations, searchQuery]);

  // Separate into Pinned and Recent
  const pinnedConversations = useMemo(
    () => filteredConversations.filter((c) => Boolean(c.isPinned)),
    [filteredConversations]
  );

  const recentConversations = useMemo(
    () => filteredConversations.filter((c) => !c.isPinned),
    [filteredConversations]
  );

  const handleStartRename = (chat: Conversation, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingChatId(chat.id);
    setEditTitle(chat.title);
    setMenuOpenId(null);
  };

  const handleSaveRename = (chatId: string) => {
    if (editTitle.trim()) {
      onRenameChat(chatId, editTitle.trim());
    }
    setEditingChatId(null);
  };

  const handleDelete = (chatId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onDeleteChat(chatId);
    setMenuOpenId(null);
  };

  const handlePin = (chatId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (onTogglePinChat) {
      onTogglePinChat(chatId);
    }
    setMenuOpenId(null);
  };

  const selectChat = (id: string) => {
    closeSearch();
    onSelectChat(id);
    if (isMobileOpen) onCloseMobile();
  };

  // Render individual chat item
  const renderChatItem = (chat: Conversation) => {
    const isActive = chat.id === activeChatId;
    const isEditing = chat.id === editingChatId;

    // `isCollapsed` is a desktop-only layout. The mobile drawer must always show
    // names and actions, even if the desktop sidebar was collapsed beforehand.
    if (isCollapsed && !isMobileOpen) {
      return (
        <button
          key={chat.id}
          type="button"
          onClick={() => selectChat(chat.id)}
          title={chat.title}
          aria-label={chat.title}
          aria-current={isActive ? 'page' : undefined}
          className={`w-9 h-9 mx-auto flex items-center justify-center rounded-xl transition-colors ${
            isActive
              ? 'bg-zinc-200/90 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-sm'
              : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-200/50 dark:hover:bg-zinc-800/50'
          }`}
        >
          <MessageSquare className="w-4 h-4" />
        </button>
      );
    }

    return (
      <div
        key={chat.id}
        className={`group relative flex items-center justify-between w-full h-9 px-2 rounded-xl text-xs select-none transition-all ${
          isActive
            ? 'bg-zinc-200/80 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-medium shadow-sm'
            : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200/50 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-100'
        }`}
      >
        {isEditing ? (
          <div className="flex items-center gap-1.5 w-full pr-1">
            <input
              type="text"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSaveRename(chat.id);
                if (e.key === 'Escape') setEditingChatId(null);
              }}
              aria-label={`Rename ${chat.title}`}
              autoFocus
              className="flex-1 h-6 px-1.5 text-xs bg-white dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 rounded-md focus:outline-none focus:ring-1 focus:ring-zinc-400"
            />
            <button
              type="button"
              onClick={() => handleSaveRename(chat.id)}
              title="Save chat name"
              aria-label="Save chat name"
              className="p-1 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 rounded"
            >
              <Check className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setEditingChatId(null)}
              title="Cancel rename"
              aria-label="Cancel rename"
              className="p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={() => selectChat(chat.id)}
              aria-current={isActive ? 'page' : undefined}
              title={chat.title}
              className="min-w-0 flex-1 h-full pr-1 flex items-center gap-1.5 text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/70 rounded-lg"
            >
              <span className="truncate block">{chat.title}</span>
            </button>

            {/* Actions stay in a stable spot, appear on hover/focus, and remain
                visible on touch screens where hover does not exist. */}
            <div className="sidebar-actions flex items-center gap-0.5 shrink-0">
              <button
                type="button"
                onClick={(e) => handlePin(chat.id, e)}
                title={chat.isPinned ? 'Unpin chat' : 'Pin chat'}
                aria-label={chat.isPinned ? 'Unpin chat' : 'Pin chat'}
                className={`flex items-center justify-center w-6 h-6 rounded-md transition-colors ${
                  chat.isPinned
                    ? 'text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white'
                    : 'text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-300/40 dark:hover:bg-zinc-700/50'
                }`}
              >
                <Pin className={`w-3.5 h-3.5 ${chat.isPinned ? 'fill-current' : ''}`} />
              </button>

              <div
                className="relative"
                ref={menuOpenId === chat.id ? menuWrapRef : undefined}
              >
                <button
                  type="button"
                  onClick={() => setMenuOpenId(menuOpenId === chat.id ? null : chat.id)}
                  aria-label={`Options for ${chat.title}`}
                  aria-expanded={menuOpenId === chat.id}
                  aria-controls={`chat-options-${chat.id}`}
                  title="Chat options"
                  className="flex items-center justify-center w-6 h-6 rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-300/40 dark:hover:bg-zinc-700/50 transition-colors"
                >
                  <MoreHorizontal className="w-3.5 h-3.5" />
                </button>

                {menuOpenId === chat.id && (
                  <div id={`chat-options-${chat.id}`} role="group" aria-label={`Options for ${chat.title}`} className="absolute right-0 top-7 z-50 w-32 py-1 bg-white dark:bg-zinc-800 rounded-xl shadow-xl border border-zinc-200 dark:border-zinc-700 text-xs animate-in fade-in duration-100">
                    <button
                      type="button"
                      onClick={(e) => handlePin(chat.id, e)}
                      className="flex items-center gap-2 w-full px-3 py-1.5 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700/60 transition-colors"
                    >
                      <Pin className={`w-3 h-3 ${chat.isPinned ? 'fill-current' : ''}`} />
                      <span>{chat.isPinned ? 'Unpin' : 'Pin'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => handleStartRename(chat, e)}
                      className="flex items-center gap-2 w-full px-3 py-1.5 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700/60 transition-colors"
                    >
                      <Pencil className="w-3 h-3 text-zinc-400" />
                      <span>Rename</span>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => handleDelete(chat.id, e)}
                      className="flex items-center gap-2 w-full px-3 py-1.5 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors"
                    >
                      <Trash2 className="w-3 h-3 text-red-500" />
                      <span>Delete</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <>
      {/* Mobile Backdrop */}
      {isMobileOpen && (
        <div
          aria-hidden="true"
          className="fixed inset-0 z-40 bg-zinc-900/40 backdrop-blur-sm lg:hidden"
          onClick={closeMobileDrawer}
        />
      )}

      {/* Main Sidebar.
          On desktop a collapsed sidebar is gone entirely — no icon rail, just
          the floating reveal button the app renders in its place. On mobile the
          drawer is driven by `isMobileOpen`, so it is unaffected. */}
      <aside
        ref={asideRef}
        role={isMobileOpen ? 'dialog' : undefined}
        aria-modal={isMobileOpen ? 'true' : undefined}
        aria-label={isMobileOpen ? 'Chat history' : undefined}
        tabIndex={isMobileOpen ? -1 : undefined}
        className={`fixed top-0 bottom-0 left-0 z-50 flex flex-col bg-[#f9f9f9] dark:bg-[#171717] border-r border-zinc-200/70 dark:border-zinc-800/80 transition-all duration-200 ease-in-out lg:static ${
          isMobileOpen ? 'translate-x-0 w-72' : '-translate-x-full lg:translate-x-0'
        } ${isCollapsed ? 'lg:hidden' : 'lg:w-64'}`}
      >
        {/* Header: BlackDesi AI logo on left, Search & Sidebar Toggle on right */}
        <div className="flex items-center justify-between h-12 px-3.5 border-b border-zinc-200/50 dark:border-zinc-800/60">
          {/* Title / Logo */}
          <div className="flex items-center gap-2">
            <span className="font-semibold text-[14.5px] sm:text-[15px] tracking-tight text-zinc-900 dark:text-zinc-100 font-sans select-none">
              BlackDesi AI
            </span>
          </div>

          {/* Header Action Icons: Leveled and aligned */}
          <div className="flex items-center gap-0.5 sm:gap-1">
            <button
              type="button"
              onClick={() => (isSearchOpen ? closeSearch() : setIsSearchOpen(true))}
              title="Search chats"
              aria-label="Search chats"
              aria-expanded={isSearchOpen}
              aria-controls="sidebar-chat-search"
              className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                isSearchOpen
                  ? 'bg-zinc-200 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800'
              }`}
            >
              <Search className="w-4 h-4 stroke-[1.75]" />
            </button>

            {/* Close Sidebar button */}
            <button
              type="button"
              onClick={() => {
                closeSearch();
                onToggleCollapse();
              }}
              title="Close sidebar"
              aria-label="Close sidebar"
              className="hidden lg:flex p-1.5 rounded-lg text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              <PanelLeftClose className="w-4 h-4 stroke-[1.75]" />
            </button>

            {/* Mobile close */}
            <button
              type="button"
              onClick={closeMobileDrawer}
              aria-label="Close sidebar"
              title="Close sidebar"
              className="lg:hidden p-1.5 rounded-lg text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 cursor-pointer"
            >
              <X className="w-4 h-4 stroke-[1.75]" />
            </button>
          </div>
        </div>

        {/* New Chat Button: Transparent by default, highlighted only on hover */}
        <div className="px-3 pt-2.5 pb-1">
          <button
            type="button"
            onClick={() => {
              closeSearch();
              onNewChat();
              if (isMobileOpen) onCloseMobile();
            }}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60 font-medium text-xs tracking-wide transition-all select-none cursor-pointer"
          >
            <SquarePen className="w-4 h-4 text-zinc-500 dark:text-zinc-400 shrink-0 stroke-[1.75]" />
            <span>New chat</span>
            <kbd className="ml-auto hidden lg:block font-sans text-[10px] font-normal tracking-normal text-zinc-400 dark:text-zinc-500">{modKey}N</kbd>
          </button>

          {/* A shortcut nobody can find is a shortcut nobody has. */}
          {onOpenPalette && (
            <button
              type="button"
              onClick={() => {
                closeSearch();
                onOpenPalette();
                if (isMobileOpen) onCloseMobile();
              }}
              title="Search commands, chats and models"
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60 font-medium text-xs tracking-wide transition-all select-none cursor-pointer"
            >
              <Command className="w-4 h-4 text-zinc-500 dark:text-zinc-400 shrink-0 stroke-[1.75]" />
              <span>Commands</span>
              <kbd className="ml-auto hidden lg:block font-sans text-[10px] font-normal tracking-normal text-zinc-400 dark:text-zinc-500">{modKey}K</kbd>
            </button>
          )}
        </div>

        {/* Search input (when toggled open) */}
        {isSearchOpen && (
          <div id="sidebar-chat-search" className="px-3 py-2 animate-in fade-in duration-150">
            <div className="relative flex items-center">
              <Search className="absolute left-2.5 w-3.5 h-3.5 text-zinc-400" aria-hidden="true" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  if (e.target.value.trim()) setIsRecentsCollapsed(false);
                }}
                placeholder="Search chats..."
                aria-label="Search chats by title, message, or attachment"
                className="w-full h-8 pl-8 pr-7 text-xs bg-white dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700/60 rounded-lg focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-500 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 shadow-sm"
                autoFocus
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  aria-label="Clear chat search"
                  title="Clear search"
                  className="absolute right-2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Chat History List */}
        <div className="flex-1 overflow-y-auto px-2 py-2 space-y-3">
          {filteredConversations.length === 0 ? (
            <div className="text-center py-8 text-xs text-zinc-400 select-none">
              {searchQuery ? 'No chats found' : 'No chats yet'}
            </div>
          ) : (
            <>
              {/* Pinned Section */}
              {pinnedConversations.length > 0 && (
                <div>
                  <div className="px-3 py-1 text-[11px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider select-none">
                    Pinned
                  </div>
                  <div className="space-y-0.5 mt-0.5">
                    {pinnedConversations.map((chat) => renderChatItem(chat))}
                  </div>
                </div>
              )}

              {/* Recents Section with Hide/Collapse Chevron toggle */}
              <div>
                <button
                  type="button"
                  onClick={() => setIsRecentsCollapsed(!isRecentsCollapsed)}
                  aria-expanded={!isRecentsCollapsed}
                  aria-controls="sidebar-recent-chats"
                  className="w-full flex items-center justify-between px-3 py-1 text-[11px] font-semibold text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 uppercase tracking-wider select-none transition-colors"
                >
                  <span>Recents</span>
                  <ChevronDown
                    className={`w-3.5 h-3.5 transition-transform duration-200 ${
                      isRecentsCollapsed ? '-rotate-90' : 'rotate-0'
                    }`}
                  />
                </button>

                <div
                  id="sidebar-recent-chats"
                  className="space-y-0.5 mt-0.5"
                  hidden={isRecentsCollapsed}
                >
                  {recentConversations.map((chat) => renderChatItem(chat))}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Bottom bar with Settings */}
        <div className="p-2 border-t border-zinc-200/60 dark:border-zinc-800/70">
          <button
            type="button"
            onClick={() => {
              closeSearch();
              onOpenSettings();
              if (isMobileOpen) onCloseMobile();
            }}
            title="Settings"
            aria-label="Settings"
            className="flex items-center gap-2.5 w-full h-10 px-3 rounded-xl text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60 transition-colors select-none cursor-pointer"
          >
            <SettingsIcon className="w-4 h-4 shrink-0 text-zinc-500 dark:text-zinc-400 stroke-[1.75]" />
            <span>Settings</span>
          </button>
          <a
            href="mailto:Contact@blackdesi.com"
            className="block px-3 pt-1.5 pb-0.5 text-[11px] text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 truncate"
          >
            Contact: Contact@blackdesi.com
          </a>
        </div>
      </aside>
    </>
  );
};

