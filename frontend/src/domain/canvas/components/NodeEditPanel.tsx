'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import dynamic from 'next/dynamic';
import { X, Save, Tags } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { useCanvasStore } from '../store';
import { useSelectedReactiveNode } from '../store-valtio';
import { NodeActionsMenu, NodeActionsQuickBar, useNodeActionCtx } from '../lib/node-actions';
import { ReadingPrefsDialog } from './ReadingPrefsDialog';
import { useReadingPrefs, fontFamilyToCss } from '../lib/reading-prefs';
import { cn } from '@/lib/utils';
import { PlayDropdownButton } from './PlayDropdownButton';
import { VirtualizedLargeText } from './VirtualizedLargeText';
import type { MarkdownEditorProps } from './MarkdownEditor';
import { useActionsContext } from '@/domain/action/ActionsContext';
import { BulkOperations, CanvasNode } from '../types';
import { toast } from 'sonner';

const RICH_EDITOR_CHAR_LIMIT = 80_000;
const RICH_EDITOR_LINE_LIMIT = 2_500;
const RAW_EDITOR_SYNC_DELAY_MS = 800;

const MarkdownEditor = dynamic<MarkdownEditorProps>(
  () => import('./MarkdownEditor').then((mod) => mod.MarkdownEditor),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full min-h-[18rem] items-center justify-center text-xs text-gray-400">
        Loading editor...
      </div>
    ),
  }
);

interface NodeEditPanelProps {
  nodeId?: string | null;
  embedded?: boolean;
  onClose?: () => void;
}

type LargeContentMode = 'preview' | 'raw' | 'rich';
type ContentMeta = { length: number; isLarge: boolean };

function hasMoreThanLines(value: string, maxLines: number) {
  let lines = 1;
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) === 10) {
      lines += 1;
      if (lines > maxLines) return true;
    }
  }
  return false;
}

function shouldPreferRawEditor(value: string) {
  return value.length > RICH_EDITOR_CHAR_LIMIT || hasMoreThanLines(value, RICH_EDITOR_LINE_LIMIT);
}

function getContentMeta(value: string): ContentMeta {
  return { length: value.length, isLarge: shouldPreferRawEditor(value) };
}

function formatContentSize(length: number) {
  if (length < 1000) return `${length} chars`;
  return `${Math.round(length / 1000)}k chars`;
}

interface LargeRawContentEditorProps {
  value: string;
  editorKey: string;
  editable: boolean;
  placeholder: string;
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  fontWeight: number;
  letterSpacing: number;
  textAlign: 'left' | 'justify';
  readingWidth: number;
  firstLineIndent: number;
  onDirty: () => void;
  onBlur: () => void;
  onSnapshot: (value: string) => void;
  registerValueGetter: (getter: (() => string) | null) => void;
}

const LargeRawContentEditor = memo(function LargeRawContentEditor({
  value,
  editorKey,
  editable,
  placeholder,
  fontSize,
  fontFamily,
  lineHeight,
  fontWeight,
  letterSpacing,
  textAlign,
  readingWidth,
  firstLineIndent,
  onDirty,
  onBlur,
  onSnapshot,
  registerValueGetter,
}: LargeRawContentEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || textarea.value === value) return;
    textarea.value = value;
  }, [editorKey, value]);

  useEffect(() => {
    registerValueGetter(() => textareaRef.current?.value ?? value);
    return () => {
      const latest = textareaRef.current?.value;
      if (latest !== undefined) onSnapshot(latest);
      registerValueGetter(null);
    };
  }, [onSnapshot, registerValueGetter, value]);

  return (
    <textarea
      ref={textareaRef}
      defaultValue={value}
      readOnly={!editable}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      placeholder={placeholder}
      wrap="soft"
      onInput={onDirty}
      onBlur={onBlur}
      className={cn(
        'h-full min-h-[18rem] w-full resize-none border-0 bg-transparent p-0 text-gray-900 outline-none',
        'placeholder:text-gray-400 read-only:cursor-default read-only:text-gray-700'
      )}
      style={{
        fontSize: `${fontSize}em`,
        fontFamily,
        lineHeight,
        fontWeight,
        letterSpacing: letterSpacing ? `${letterSpacing}em` : undefined,
        textAlign,
        textIndent: firstLineIndent ? `${firstLineIndent}em` : undefined,
        width: readingWidth > 0 ? `${readingWidth}ch` : '100%',
        maxWidth: '100%',
        marginLeft: readingWidth > 0 ? 'auto' : undefined,
        marginRight: readingWidth > 0 ? 'auto' : undefined,
      }}
    />
  );
});

// MarkdownRenderer is already memoized, no need to double-wrap
export const NodeEditPanelComponent = ({
  nodeId,
  embedded = false,
  onClose,
}: NodeEditPanelProps) => {
  const { actions } = useActionsContext();

  const clearSelectedNode = useCanvasStore((state) => state.clearSelectedNode);
  const updateNodeContent = useCanvasStore((state) => state.updateNodeContent);
  const createChildFromSelection = useCanvasStore((state) => state.createChildFromSelection);
  const runNode = useCanvasStore((state) => state.runNode);
  const onConnect = useCanvasStore((state) => state.onConnect);
  // Per-id Valtio subscription — re-renders only when this node's tracked
  // fields change, not on drag ticks of other nodes.
  const selectedNode = useSelectedReactiveNode(nodeId) ?? null;
  const selectedNodeRuntimeId = selectedNode?.id ?? null;
  const selectedNodeIsRunning = useCanvasStore((state) =>
    selectedNodeRuntimeId ? state.runningNodes.has(selectedNodeRuntimeId) : false
  );
  const DEFAULT_WIDTH = 768;

  const [panelWidth, setPanelWidth] = useState(() => {
    // Load from localStorage or default to 768px
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('piano-drawer-width');
      return saved ? parseInt(saved, 10) : DEFAULT_WIDTH;
    }
    return DEFAULT_WIDTH;
  });
  const [isResizing, setIsResizing] = useState(false);

  // fontSize is the ONE source of truth via useReadingPrefs — the +/- buttons
  // in this panel and the slider in ReadingPrefsDialog both drive the same
  // localStorage-backed hook, so they stay in sync.
  const { prefs: readingPrefs, updatePrefs: updateReadingPrefs } = useReadingPrefs();
  const fontSize = readingPrefs.fontSize;
  const setFontSize = React.useCallback(
    (value: number | ((prev: number) => number)) => {
      const next = typeof value === 'function' ? value(readingPrefs.fontSize) : value;
      updateReadingPrefs({ fontSize: next });
    },
    [readingPrefs.fontSize, updateReadingPrefs]
  );

  // Label rename + color picker state live in the global dialogs host.
  const [copiedContent, setCopiedContent] = useState(false);
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [markdownHeaderControls, setMarkdownHeaderControls] = useState<HTMLDivElement | null>(null);

  const [draftContent, setDraftContent] = useState('');
  const draftContentRef = useRef('');
  const lastStoreContentRef = useRef('');
  const dirtyDraftRef = useRef(false);
  const syncTimerRef = useRef<number | null>(null);
  const rawEditorValueGetterRef = useRef<(() => string) | null>(null);
  const activeDraftNodeRef = useRef<{ id: string; arrangementId: string } | null>(null);
  const [largeContentMode, setLargeContentMode] = useState<LargeContentMode>('preview');
  const [contentMeta, setContentMeta] = useState<ContentMeta>({ length: 0, isLarge: false });

  const clearSyncTimer = useCallback(() => {
    if (syncTimerRef.current) {
      window.clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }
  }, []);

  const readLatestDraftContent = useCallback(() => {
    return rawEditorValueGetterRef.current?.() ?? draftContentRef.current;
  }, []);

  const flushDraft = useCallback(() => {
    clearSyncTimer();

    const activeNode = activeDraftNodeRef.current;
    if (!activeNode || !dirtyDraftRef.current) return;

    const nextContent = readLatestDraftContent();
    draftContentRef.current = nextContent;
    if (nextContent !== lastStoreContentRef.current) {
      updateNodeContent(activeNode.id, activeNode.arrangementId, nextContent);
      lastStoreContentRef.current = nextContent;
    }

    dirtyDraftRef.current = false;
  }, [clearSyncTimer, readLatestDraftContent, updateNodeContent]);

  const closePanel = useCallback(() => {
    flushDraft();
    if (onClose) {
      onClose();
      return;
    }
    clearSelectedNode();
  }, [clearSelectedNode, flushDraft, onClose]);

  // Save panel width to localStorage
  React.useEffect(() => {
    localStorage.setItem('piano-drawer-width', panelWidth.toString());
  }, [panelWidth]);
  // fontSize persists via useReadingPrefs — no manual effect needed here.

  // Resize handlers
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  const handleResizeMove = useCallback(
    (e: MouseEvent) => {
      if (isResizing) {
        // Min width: 280px (enough for content), Max width: 80% of window width or 1200px
        const minWidth = 280;
        const maxWidth = Math.min(1200, window.innerWidth * 0.8);
        const newWidth = Math.max(minWidth, Math.min(maxWidth, window.innerWidth - e.clientX));
        setPanelWidth(newWidth);
      }
    },
    [isResizing]
  );

  const handleResizeEnd = useCallback(() => {
    setIsResizing(false);
  }, []);

  // Add/remove resize event listeners
  React.useEffect(() => {
    if (isResizing) {
      document.addEventListener('mousemove', handleResizeMove);
      document.addEventListener('mouseup', handleResizeEnd);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    } else {
      document.removeEventListener('mousemove', handleResizeMove);
      document.removeEventListener('mouseup', handleResizeEnd);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }

    return () => {
      document.removeEventListener('mousemove', handleResizeMove);
      document.removeEventListener('mouseup', handleResizeEnd);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing, handleResizeMove, handleResizeEnd]);

  useEffect(() => {
    if (!selectedNode) {
      flushDraft();
      activeDraftNodeRef.current = null;
      lastStoreContentRef.current = '';
      draftContentRef.current = '';
      dirtyDraftRef.current = false;
      rawEditorValueGetterRef.current = null;
      setDraftContent('');
      setContentMeta({ length: 0, isLarge: false });
      setLargeContentMode('preview');
      return;
    }

    const nextActiveNode = {
      id: selectedNode.id,
      arrangementId: selectedNode.data.arrangementId as string,
    };
    const storeContent = (selectedNode.data.content as string) || '';
    const currentActiveNode = activeDraftNodeRef.current;
    const isDifferentNode = currentActiveNode?.id !== nextActiveNode.id;
    const storeContentMeta = getContentMeta(storeContent);

    if (isDifferentNode) {
      flushDraft();
      activeDraftNodeRef.current = nextActiveNode;
      lastStoreContentRef.current = storeContent;
      draftContentRef.current = storeContent;
      dirtyDraftRef.current = false;
      setContentMeta(storeContentMeta);
      setDraftContent(storeContentMeta.isLarge ? '' : storeContent);
      setLargeContentMode(storeContentMeta.isLarge ? 'preview' : 'rich');
      return;
    }

    activeDraftNodeRef.current = nextActiveNode;

    if (storeContent === lastStoreContentRef.current) return;

    lastStoreContentRef.current = storeContent;

    const status = selectedNode.data.status as string | undefined;
    const shouldAdoptExternalContent =
      !dirtyDraftRef.current || status === 'RUNNING' || status === 'running';

    if (shouldAdoptExternalContent) {
      clearSyncTimer();
      draftContentRef.current = storeContent;
      dirtyDraftRef.current = false;
      setContentMeta(storeContentMeta);
      setDraftContent(storeContentMeta.isLarge ? '' : storeContent);
      if (storeContentMeta.isLarge) setLargeContentMode('preview');
    }
  }, [clearSyncTimer, flushDraft, selectedNode]);

  useEffect(() => flushDraft, [flushDraft]);

  const handleContentChange = useCallback(
    (value: string) => {
      setDraftContent(value);
      draftContentRef.current = value;
      setContentMeta(getContentMeta(value));
      dirtyDraftRef.current = true;

      clearSyncTimer();
      syncTimerRef.current = window.setTimeout(() => {
        flushDraft();
      }, 500);
    },
    [clearSyncTimer, flushDraft]
  );

  const handleBlur = useCallback(() => {
    flushDraft();
  }, [flushDraft]);

  const registerRawValueGetter = useCallback((getter: (() => string) | null) => {
    rawEditorValueGetterRef.current = getter;
  }, []);

  const handleRawSnapshot = useCallback((value: string) => {
    draftContentRef.current = value;
    if (value !== lastStoreContentRef.current) {
      dirtyDraftRef.current = true;
    }
  }, []);

  const handleRawContentDirty = useCallback(() => {
    dirtyDraftRef.current = true;
    clearSyncTimer();
    syncTimerRef.current = window.setTimeout(() => {
      flushDraft();
    }, RAW_EDITOR_SYNC_DELAY_MS);
  }, [clearSyncTimer, flushDraft]);

  const handleRawBlur = useCallback(() => {
    const latest = readLatestDraftContent();
    draftContentRef.current = latest;
    setContentMeta(getContentMeta(latest));
    if (latest !== lastStoreContentRef.current) {
      dirtyDraftRef.current = true;
    }
    setDraftContent(latest);
    flushDraft();
  }, [flushDraft, readLatestDraftContent]);

  const openRichEditor = useCallback(() => {
    const latest = readLatestDraftContent();
    draftContentRef.current = latest;
    setContentMeta(getContentMeta(latest));
    if (latest !== lastStoreContentRef.current) {
      dirtyDraftRef.current = true;
    }
    setDraftContent(latest);
    flushDraft();
    setLargeContentMode('rich');
  }, [flushDraft, readLatestDraftContent]);

  const openRawEditor = useCallback(() => {
    const latest = readLatestDraftContent();
    draftContentRef.current = latest;
    setContentMeta(getContentMeta(latest));
    setDraftContent(latest);
    setLargeContentMode('raw');
  }, [readLatestDraftContent]);

  const openPreview = useCallback(() => {
    const latest = readLatestDraftContent();
    draftContentRef.current = latest;
    setContentMeta(getContentMeta(latest));
    if (latest !== lastStoreContentRef.current) {
      dirtyDraftRef.current = true;
    }
    flushDraft();
    setDraftContent('');
    setLargeContentMode('preview');
  }, [flushDraft, readLatestDraftContent]);

  const handleFollowUpSelection = useCallback(
    (text: string) => {
      if (selectedNode) createChildFromSelection(selectedNode.id, text);
    },
    [createChildFromSelection, selectedNode]
  );

  // Delete / duplicate / copy / select-children / select-ancestors are
  // now dispatched by the unified NODE_ACTIONS registry. Local handlers
  // for them are gone.

  const handleRun = useCallback(
    (actionId?: string) => {
      flushDraft();
      if (selectedNode) {
        runNode(selectedNode.id, actionId);
      }
    },
    [flushDraft, selectedNode, runNode]
  );

  // Font size controls (multiplier-based)
  const increaseFontSize = useCallback(() => {
    setFontSize((prev) => Math.min(prev + 0.25, 3.0)); // Max 3.0x (48px base)
  }, [setFontSize]);

  const decreaseFontSize = useCallback(() => {
    setFontSize((prev) => Math.max(prev - 0.25, 0.75)); // Min 0.75x (12px base)
  }, [setFontSize]);

  // Label, color, tags, ancestors: all handled by the unified action
  // registry + global <NodeDialogsHost>. This panel only keeps the
  // copy-flash signal so the menu item can render "Content copied".
  const nodeActionCtx = useNodeActionCtx(
    selectedNode?.data as CanvasNode.UI | undefined,
    {
      onCopiedContent: () => {
        setCopiedContent(true);
        window.setTimeout(() => setCopiedContent(false), 2000);
      },
    },
    { copiedContent }
  );

  // Handler for adding parent nodes by tag selection
  // Uses getState() to avoid subscribing to all nodes/edges
  const handleAddParentsByTags = useCallback(() => {
    if (!selectedNode || selectedTags.size === 0) return;

    // Get nodes and edges on-demand (not subscribed)
    const { nodes, edges } = useCanvasStore.getState();

    // Get all nodes with ANY of the selected tags
    const nodesWithTags = BulkOperations.filterNodesByAnyTag(
      nodes as any,
      Array.from(selectedTags)
    );

    // Filter out nodes that are already parents and the node itself
    const candidateNodes = BulkOperations.getNodesNotParents(
      selectedNode.id,
      nodesWithTags.filter((n) => n.id !== selectedNode.id),
      edges
    );

    if (candidateNodes.length === 0) {
      toast.info('No new parent nodes found with selected tags');
      setSelectedTags(new Set());
      return;
    }

    // Create edges from each candidate node to the current node
    candidateNodes.forEach((node) => {
      onConnect({
        source: node.id,
        target: selectedNode.id,
        sourceHandle: null,
        targetHandle: null,
      });
    });

    toast.success(
      `Added ${candidateNodes.length} parent node${candidateNodes.length !== 1 ? 's' : ''} by tag`
    );
    setSelectedTags(new Set());
  }, [selectedNode, selectedTags, onConnect]);

  const isLargeContent = contentMeta.isLarge;
  const useLargePreview = isLargeContent && largeContentMode === 'preview';
  const useRawEditor = largeContentMode === 'raw';
  const contentSizeLabel = useMemo(
    () => formatContentSize(contentMeta.length),
    [contentMeta.length]
  );

  if (!selectedNode) return null;

  // Color palettes live in NodeDialogsHost alongside the picker UI.

  const isRunning =
    selectedNodeIsRunning ||
    (selectedNode.data.status as string) === 'RUNNING' ||
    (selectedNode.data.status as string) === 'running';
  const isSaving = (selectedNode.data.status as string) === 'saving';
  const hasContent = contentMeta.length > 0;
  const isMergePoint = selectedNode.data.isMergePoint;
  const availableTags = isMergePoint
    ? BulkOperations.getAllTags(useCanvasStore.getState().nodes as any)
    : [];

  return (
    <div
      className={cn(
        'relative flex h-full flex-col overflow-hidden bg-white',
        embedded ? 'w-full rounded-[inherit] border-0' : 'border-l border-gray-200'
      )}
      style={embedded ? undefined : { width: `${panelWidth}px` }}
    >
      {/* Resize Handle */}
      {!embedded && (
        <div
          className={cn(
            'group absolute top-0 bottom-0 left-0 w-2 cursor-col-resize transition-colors',
            'border-r border-transparent hover:border-gray-300 hover:bg-gray-200',
            isResizing && 'border-blue-400 bg-blue-200'
          )}
          onMouseDown={handleResizeStart}
          title="Drag to resize panel"
        >
          {/* Resize indicator dots */}
          <div className="absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-1/2 transform flex-col gap-1">
            <div
              className={cn(
                'h-0.5 w-0.5 rounded-full bg-gray-400 transition-colors',
                'group-hover:bg-gray-600',
                isResizing && 'bg-blue-600'
              )}
            />
            <div
              className={cn(
                'h-0.5 w-0.5 rounded-full bg-gray-400 transition-colors',
                'group-hover:bg-gray-600',
                isResizing && 'bg-blue-600'
              )}
            />
            <div
              className={cn(
                'h-0.5 w-0.5 rounded-full bg-gray-400 transition-colors',
                'group-hover:bg-gray-600',
                isResizing && 'bg-blue-600'
              )}
            />
          </div>
        </div>
      )}

      {/* Overlay during resize to prevent text selection */}
      {isResizing && (
        <div className="fixed inset-0 z-50 cursor-col-resize" style={{ pointerEvents: 'none' }} />
      )}
      {/* Header - Fixed */}
      <div className="flex flex-shrink-0 items-center justify-between border-b border-gray-100 px-4 py-3">
        <div className="flex items-center gap-2">
          <div
            className={cn(
              'h-2 w-2 rounded-full',
              isRunning
                ? 'bg-blue-500'
                : isSaving
                  ? 'bg-yellow-500'
                  : (selectedNode.data.status as string) === 'error'
                    ? 'bg-red-500'
                    : (selectedNode.data.status as string) === 'completed'
                      ? 'bg-green-500'
                      : 'bg-gray-400'
            )}
          />
          <span className="text-sm font-medium text-gray-900">
            {(selectedNode.data.label as string) || 'Edit Note'}
          </span>
          <span className="text-xs tracking-wide text-gray-500 uppercase">
            {isSaving ? 'saving' : (selectedNode.data.status as string) || 'idle'}
          </span>
        </div>

        <div className="flex items-center gap-1">
          {/* Pinned-inline actions + 3-dot menu, same registry as the card
              and MachineEditPanel — pin/unpin in any surface propagates to
              all. Without the QuickBar here, pinned actions silently
              vanished when the user opened a note's window. */}
          <NodeActionsQuickBar ctx={nodeActionCtx} />
          <NodeActionsMenu ctx={nodeActionCtx} />

          <Button variant="ghost" size="sm" onClick={closePanel} className="h-8 w-8 p-0">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Content Area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-gray-100 px-3 py-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <div className="text-xs font-medium tracking-wide text-gray-500 uppercase">
              {useLargePreview ? 'Preview' : useRawEditor ? 'Raw text' : 'Markdown'}
            </div>
            {isLargeContent && (
              <span className="hidden truncate text-[10px] text-gray-400 sm:inline">
                {contentSizeLabel}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {isLargeContent ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  onClick={useLargePreview ? openRawEditor : openPreview}
                  title={
                    useLargePreview
                      ? 'Load the full text into a raw editor'
                      : 'Return to the fast virtual preview'
                  }
                >
                  {useLargePreview ? 'Edit' : 'Preview'}
                </Button>
                {largeContentMode !== 'rich' && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-[11px]"
                    onClick={openRichEditor}
                    title="Render this note with the rich Markdown editor"
                  >
                    Rich
                  </Button>
                )}
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={useRawEditor ? openRichEditor : openRawEditor}
                title={
                  useRawEditor
                    ? 'Render this note with the rich Markdown editor'
                    : 'Edit as raw text'
                }
              >
                {useRawEditor ? 'Rich' : 'Raw'}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={decreaseFontSize}
              disabled={fontSize <= 0.75}
              title="Decrease font size"
            >
              <span className="text-xs font-bold">A</span>
            </Button>
            <span className="text-[10px] text-gray-400 tabular-nums">
              {Math.round(fontSize * 100)}%
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={increaseFontSize}
              disabled={fontSize >= 3.0}
              title="Increase font size"
            >
              <span className="text-sm font-bold">A</span>
            </Button>
            <div ref={setMarkdownHeaderControls} className="flex items-center" />
            <ReadingPrefsDialog />
          </div>
        </div>
        <div className="flex-1 overflow-hidden p-4">
          {useLargePreview ? (
            <VirtualizedLargeText
              previewKey={selectedNode.id}
              value={draftContentRef.current}
              fontSize={fontSize}
              fontFamily={fontFamilyToCss(readingPrefs.fontFamily)}
              lineHeight={readingPrefs.lineHeight}
              fontWeight={readingPrefs.fontWeight}
              readingWidth={readingPrefs.readingWidth}
              letterSpacing={readingPrefs.letterSpacing}
              textAlign={readingPrefs.textAlign}
              firstLineIndent={readingPrefs.firstLineIndent}
            />
          ) : useRawEditor ? (
            <LargeRawContentEditor
              editorKey={selectedNode.id}
              value={draftContent || draftContentRef.current}
              editable={!isRunning}
              placeholder="Write markdown here..."
              fontSize={fontSize}
              fontFamily={fontFamilyToCss(readingPrefs.fontFamily)}
              lineHeight={readingPrefs.lineHeight}
              fontWeight={readingPrefs.fontWeight}
              readingWidth={readingPrefs.readingWidth}
              letterSpacing={readingPrefs.letterSpacing}
              textAlign={readingPrefs.textAlign}
              firstLineIndent={readingPrefs.firstLineIndent}
              onDirty={handleRawContentDirty}
              onBlur={handleRawBlur}
              onSnapshot={handleRawSnapshot}
              registerValueGetter={registerRawValueGetter}
            />
          ) : (
            <MarkdownEditor
              value={draftContent}
              onChange={handleContentChange}
              onBlur={handleBlur}
              onFollowUpSelection={handleFollowUpSelection}
              editable={!isRunning}
              placeholder="Write markdown here..."
              fontSize={fontSize}
              fontFamily={fontFamilyToCss(readingPrefs.fontFamily)}
              lineHeight={readingPrefs.lineHeight}
              fontWeight={readingPrefs.fontWeight}
              paragraphSpacing={readingPrefs.paragraphSpacing}
              readingWidth={readingPrefs.readingWidth}
              letterSpacing={readingPrefs.letterSpacing}
              textAlign={readingPrefs.textAlign}
              firstLineIndent={readingPrefs.firstLineIndent}
              headingNavigatorContainer={markdownHeaderControls}
            />
          )}
        </div>
      </div>

      {/* Footer - Fixed */}
      <div className="flex-shrink-0 border-t border-gray-100 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex items-center rounded border bg-gray-50 px-3 py-2 text-xs text-gray-500">
              <Save className="mr-1 h-3 w-3" />
              Auto-saved
            </div>

            {/* Tag Selector - Only show for merge points */}
            {isMergePoint && availableTags.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="text-xs">
                    <Tags className="mr-1 h-3 w-3" />
                    Add Parents by Tag
                    {selectedTags.size > 0 && (
                      <span className="ml-1 text-blue-600">({selectedTags.size})</span>
                    )}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-56">
                  <DropdownMenuLabel>Select Tags</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {availableTags.map((tag) => (
                    <DropdownMenuItem
                      key={tag}
                      onClick={(e) => {
                        e.preventDefault();
                        setSelectedTags((prev) => {
                          const newSet = new Set(prev);
                          if (newSet.has(tag)) {
                            newSet.delete(tag);
                          } else {
                            newSet.add(tag);
                          }
                          return newSet;
                        });
                      }}
                      className="cursor-pointer"
                    >
                      <div className="flex w-full items-center gap-2">
                        <div
                          className={cn(
                            'flex h-4 w-4 items-center justify-center rounded border',
                            selectedTags.has(tag)
                              ? 'border-blue-500 bg-blue-500'
                              : 'border-gray-300'
                          )}
                        >
                          {selectedTags.has(tag) && <span className="text-xs text-white">✓</span>}
                        </div>
                        <span className="flex-1">{tag}</span>
                      </div>
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={handleAddParentsByTags}
                    disabled={selectedTags.size === 0}
                    className="font-medium text-blue-600"
                  >
                    Apply ({selectedTags.size} tag{selectedTags.size !== 1 ? 's' : ''})
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>

          <PlayDropdownButton onPlay={handleRun} actions={actions} disabled={!hasContent} />
        </div>
      </div>
    </div>
  );
};

// Export with memo to prevent re-renders when other parts of the app change
export const NodeEditPanel = memo(NodeEditPanelComponent);
