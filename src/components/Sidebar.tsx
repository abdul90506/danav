import React, { useState, useMemo } from 'react';
import {
  SquarePen,
  Search,
  Settings as SettingsIcon,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Trash2,
  Pin,
  ChevronDown,
  PanelLeftClose,
  PanelLeftOpen,
  X,
  Check,
} from 'lucide-react';
import { Conversation } from '../types';

interface SidebarProps {
  conversations: Conversation[];
  activeChatId: string | null;
  onSelectChat: (id: string) => void;
  onNewChat: () => void;
  onRenameChat: (id: string, newTitle: string) => void;
  onDeleteChat: (id: string) => void;
  onTogglePinChat?: (id: string) => void;
  onOpenSettings: () => void;
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

  // Filter conversations by search query
  const filteredConversations = useMemo(() => {
    if (!searchQuery.trim()) return conversations;
    const q = searchQuery.toLowerCase();
    return conversations.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.messages.some((m) => m.content.toLowerCase().includes(q))
    );
  }, [conversations, searchQuery]);

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

  // Render individual chat item
  const renderChatItem = (chat: Conversation, isPinnedSection: boolean) => {
    const isActive = chat.id === activeChatId;
    const isEditing = chat.id === editingChatId;

    if (isCollapsed) {
      return (
        <button
          key={chat.id}
          onClick={() => onSelectChat(chat.id)}
          title={chat.title}
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
        onClick={() => {
          onSelectChat(chat.id);
          if (isMobileOpen) onCloseMobile();
        }}
        className={`group relative flex items-center justify-between w-full h-9 px-3 rounded-xl text-xs cursor-pointer select-none transition-all ${
          isActive
            ? 'bg-zinc-200/80 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-medium shadow-sm'
            : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200/50 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-100'
        }`}
      >
        {isEditing ? (
          <div
            className="flex items-center gap-1.5 w-full pr-1"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              type="text"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSaveRename(chat.id);
                if (e.key === 'Escape') setEditingChatId(null);
              }}
              autoFocus
              className="flex-1 h-6 px-1.5 text-xs bg-white dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 rounded-md focus:outline-none focus:ring-1 focus:ring-zinc-400"
            />
            <button
              onClick={() => handleSaveRename(chat.id)}
              className="p-1 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 rounded"
            >
              <Check className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setEditingChatId(null)}
              className="p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <>
            <div className="min-w-0 flex-1 pr-1 flex items-center gap-1.5">
              <span className="truncate block">{chat.title}</span>
            </div>

            {/* Hover Actions: Pin & More Options */}
            <div className="flex items-center gap-0.5 shrink-0">
              {/* Pin button */}
              <button
                onClick={(e) => handlePin(chat.id, e)}
                title={chat.isPinned ? 'Unpin chat' : 'Pin chat'}
                aria-label={chat.isPinned ? 'Unpin chat' : 'Pin chat'}
                className={`hidden group-hover:flex items-center justify-center w-6 h-6 rounded-md transition-colors ${
                  chat.isPinned
                    ? 'text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white'
                    : 'text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-300/40 dark:hover:bg-zinc-700/50'
                }`}
              >
                <Pin className={`w-3.5 h-3.5 ${chat.isPinned ? 'fill-current' : ''}`} />
              </button>

              {/* More menu trigger button */}
              <div className="relative" onClick={(e) => e.stopPropagation()}>
                <button
                  onClick={() =>
                    setMenuOpenId(menuOpenId === chat.id ? null : chat.id)
                  }
                  aria-label="Chat options"
                  className="hidden group-hover:flex items-center justify-center w-6 h-6 rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-300/40 dark:hover:bg-zinc-700/50 transition-colors"
                >
                  <MoreHorizontal className="w-3.5 h-3.5" />
                </button>

                {/* Dropdown popup */}
                {menuOpenId === chat.id && (
                  <div className="absolute right-0 top-7 z-50 w-32 py-1 bg-white dark:bg-zinc-800 rounded-xl shadow-xl border border-zinc-200 dark:border-zinc-700 text-xs animate-in fade-in duration-100">
                    <button
                      onClick={(e) => handlePin(chat.id, e)}
                      className="flex items-center gap-2 w-full px-3 py-1.5 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700/60 transition-colors"
                    >
                      <Pin className={`w-3 h-3 ${chat.isPinned ? 'fill-current' : ''}`} />
                      <span>{chat.isPinned ? 'Unpin' : 'Pin'}</span>
                    </button>
                    <button
                      onClick={(e) => handleStartRename(chat, e)}
                      className="flex items-center gap-2 w-full px-3 py-1.5 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700/60 transition-colors"
                    >
                      <Pencil className="w-3 h-3 text-zinc-400" />
                      <span>Rename</span>
                    </button>
                    <button
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
          className="fixed inset-0 z-40 bg-zinc-900/40 backdrop-blur-sm lg:hidden"
          onClick={onCloseMobile}
        />
      )}

      {/* Main Sidebar */}
      <aside
        className={`fixed top-0 bottom-0 left-0 z-50 flex flex-col bg-[#f9f9f9] dark:bg-[#171717] border-r border-zinc-200/70 dark:border-zinc-800/80 transition-all duration-200 ease-in-out lg:static ${
          isMobileOpen ? 'translate-x-0 w-72' : '-translate-x-full lg:translate-x-0'
        } ${isCollapsed ? 'lg:w-16' : 'lg:w-64'}`}
      >
        {/* Header: Danav AI logo on left, Search & Sidebar Toggle on right */}
        {isCollapsed ? (
          <div className="flex flex-col items-center py-2.5 gap-1.5 border-b border-zinc-200/50 dark:border-zinc-800/60">
            <button
              onClick={onToggleCollapse}
              title="Expand sidebar"
              aria-label="Expand sidebar"
              className="w-8 h-8 sm:w-8.5 sm:h-8.5 flex items-center justify-center rounded-xl text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors shrink-0 cursor-pointer"
            >
              <PanelLeftOpen className="w-4 h-4 stroke-[1.75]" />
            </button>
            <button
              onClick={onNewChat}
              title="New Chat"
              aria-label="New Chat"
              className="w-8 h-8 sm:w-8.5 sm:h-8.5 flex items-center justify-center rounded-xl text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors shrink-0 cursor-pointer"
            >
              <SquarePen className="w-4 h-4 stroke-[1.75]" />
            </button>
            <button
              onClick={() => {
                onToggleCollapse();
                setIsSearchOpen(true);
              }}
              title="Search chats"
              aria-label="Search chats"
              className="w-8 h-8 sm:w-8.5 sm:h-8.5 flex items-center justify-center rounded-xl text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors shrink-0 cursor-pointer"
            >
              <Search className="w-4 h-4 stroke-[1.75]" />
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between h-12 px-3.5 border-b border-zinc-200/50 dark:border-zinc-800/60">
            {/* Title / Logo */}
            <div className="flex items-center gap-2">
              <span className="font-semibold text-[14.5px] sm:text-[15px] tracking-tight text-zinc-900 dark:text-zinc-100 font-sans select-none">
                Danav AI
              </span>
            </div>

            {/* Header Action Icons: Leveled and aligned */}
            <div className="flex items-center gap-0.5 sm:gap-1">
              <button
                onClick={() => setIsSearchOpen(!isSearchOpen)}
                title="Search chats"
                aria-label="Search chats"
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
                onClick={onToggleCollapse}
                title="Close sidebar"
                aria-label="Close sidebar"
                className="hidden lg:flex p-1.5 rounded-lg text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
              >
                <PanelLeftClose className="w-4 h-4 stroke-[1.75]" />
              </button>

              {/* Mobile close */}
              <button
                onClick={onCloseMobile}
                className="lg:hidden p-1.5 rounded-lg text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 cursor-pointer"
              >
                <X className="w-4 h-4 stroke-[1.75]" />
              </button>
            </div>
          </div>
        )}

        {/* New Chat Button: Transparent by default, highlighted only on hover */}
        {!isCollapsed && (
          <div className="px-3 pt-2.5 pb-1">
            <button
              onClick={() => {
                onNewChat();
                if (isMobileOpen) onCloseMobile();
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60 font-medium text-xs tracking-wide transition-all select-none cursor-pointer"
            >
              <SquarePen className="w-4 h-4 text-zinc-500 dark:text-zinc-400 shrink-0 stroke-[1.75]" />
              <span>New chat</span>
            </button>
          </div>
        )}

        {/* Search input (when toggled open) */}
        {!isCollapsed && isSearchOpen && (
          <div className="px-3 py-2 animate-in fade-in duration-150">
            <div className="relative flex items-center">
              <Search className="absolute left-2.5 w-3.5 h-3.5 text-zinc-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search chats..."
                className="w-full h-8 pl-8 pr-7 text-xs bg-white dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700/60 rounded-lg focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-500 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 shadow-sm"
                autoFocus
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Chat History List: Only rendered when sidebar is open */}
        {!isCollapsed ? (
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
                      {pinnedConversations.map((chat) => renderChatItem(chat, true))}
                    </div>
                  </div>
                )}

                {/* Recents Section with Hide/Collapse Chevron toggle */}
                <div>
                  <button
                    type="button"
                    onClick={() => setIsRecentsCollapsed(!isRecentsCollapsed)}
                    className="w-full flex items-center justify-between px-3 py-1 text-[11px] font-semibold text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 uppercase tracking-wider select-none transition-colors"
                  >
                    <span>Recents</span>
                    <ChevronDown
                      className={`w-3.5 h-3.5 transition-transform duration-200 ${
                        isRecentsCollapsed ? '-rotate-90' : 'rotate-0'
                      }`}
                    />
                  </button>

                  {!isRecentsCollapsed && (
                    <div className="space-y-0.5 mt-0.5">
                      {recentConversations.map((chat) => renderChatItem(chat, false))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="flex-1" />
        )}

        {/* Bottom bar with Settings */}
        <div className="p-2 border-t border-zinc-200/60 dark:border-zinc-800/70">
          <button
            onClick={() => {
              onOpenSettings();
              if (isMobileOpen) onCloseMobile();
            }}
            title="Settings"
            className={`flex items-center gap-2.5 w-full h-10 px-3 rounded-xl text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60 transition-colors select-none cursor-pointer ${
              isCollapsed ? 'justify-center px-0' : ''
            }`}
          >
            <SettingsIcon className="w-4 h-4 shrink-0 text-zinc-500 dark:text-zinc-400 stroke-[1.75]" />
            {!isCollapsed && <span>Settings</span>}
          </button>
        </div>
      </aside>
    </>
  );
};

