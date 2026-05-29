'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { EditorContent, useEditor, useEditorState, ReactNodeViewRenderer } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { StarterKit } from '@tiptap/starter-kit'
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight'
import {
  TableOfContents,
  getHierarchicalIndexes,
  type TableOfContentDataItem,
} from '@tiptap/extension-table-of-contents'
import { Markdown } from 'tiptap-markdown'
import { Placeholder } from '@tiptap/extension-placeholder'
import { Link } from '@tiptap/extension-link'
import { Table } from '@tiptap/extension-table'
import { TableRow } from '@tiptap/extension-table-row'
import { TableHeader } from '@tiptap/extension-table-header'
import { TableCell } from '@tiptap/extension-table-cell'
import { TaskList } from '@tiptap/extension-task-list'
import { TaskItem } from '@tiptap/extension-task-item'
import { Highlight } from '@tiptap/extension-highlight'
import markdownItMark from 'markdown-it-mark'
import {
  Bold,
  CheckSquare,
  ChevronLeft,
  Code,
  Columns3,
  Highlighter,
  Italic,
  List,
  ListCollapse,
  ListOrdered,
  ListTree,
  MessageCircle,
  Minus,
  Quote,
  Rows3,
  Strikethrough,
  Table2,
  Trash2,
} from 'lucide-react'
import { common, createLowlight } from 'lowlight'
import { Note } from '@piano/shared'
import { cn } from '@/lib/utils'
import { CodeBlockArtifactView } from './CodeBlockArtifactView'

const lowlight = createLowlight(common)
type TocTreeItem = TableOfContentDataItem & { children: TocTreeItem[] }

const MarkdownHighlight = Highlight.extend({
  addStorage() {
    return {
      markdown: {
        serialize: {
          open: '==',
          close: '==',
          expelEnclosingWhitespace: true,
        },
        parse: {
          setup(markdownit: any) {
            markdownit.use(markdownItMark)
          },
        },
      },
    }
  },
})

export interface MarkdownEditorProps {
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  onFollowUpSelection?: (text: string) => void
  editable?: boolean
  placeholder?: string
  className?: string
  fontSize?: number
  fontFamily?: string
  lineHeight?: number
  fontWeight?: number
  paragraphSpacing?: number
  readingWidth?: number
  letterSpacing?: number
  textAlign?: 'left' | 'justify'
  firstLineIndent?: number
  headingNavigatorContainer?: HTMLElement | null
}

export function MarkdownEditor({
  value,
  onChange,
  onBlur,
  onFollowUpSelection,
  editable = true,
  placeholder = 'Write here...',
  className,
  fontSize = 1,
  fontFamily,
  lineHeight = 1.6,
  fontWeight = 400,
  paragraphSpacing = 1,
  readingWidth = 0,
  letterSpacing = 0,
  textAlign = 'left',
  firstLineIndent = 0,
  headingNavigatorContainer,
}: MarkdownEditorProps) {
  // Auto-fence embedded HTML documents so a raw <html>…</html> the agent dumped
  // (often wrapped in prose) renders as a live artifact. Idempotent, so the
  // editor's whole world is this normalized form; it serializes back canonical.
  const normalizedValue = useMemo(() => Note.fenceHtmlDocuments(value), [value])
  const lastSyncedRef = useRef<string>(normalizedValue)
  const editorScrollRef = useRef<HTMLDivElement>(null)
  const headingNavigatorRef = useRef<HTMLDivElement>(null)
  const [tocItems, setTocItems] = useState<TableOfContentDataItem[]>([])
  const [isHeadingNavigatorOpen, setIsHeadingNavigatorOpen] = useState(false)
  const [activeHeadingPath, setActiveHeadingPath] = useState<string[]>([])

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        codeBlock: false,
        // Opt out of StarterKit's bundled link extension; we register the
        // standalone @tiptap/extension-link below with non-default options
        // (openOnClick: false). Without this tiptap warns about duplicate
        // `link` extension and one of the registrations is silently dropped.
        link: false,
      }),
      CodeBlockLowlight.extend({
        // ```html blocks render as a live sandboxed artifact; other languages
        // keep the default highlighted code block (see CodeBlockArtifactView).
        addNodeView() {
          return ReactNodeViewRenderer(CodeBlockArtifactView)
        },
      }).configure({
        lowlight,
        defaultLanguage: null,
      }),
      TableOfContents.configure({
        getIndex: getHierarchicalIndexes,
        scrollParent: () => editorScrollRef.current ?? window,
        onUpdate: (items) => setTocItems([...items]),
      }),
      Markdown.configure({ html: false, breaks: true, linkify: true, transformPastedText: true }),
      Link.configure({ openOnClick: false, autolink: true }),
      Table.configure({
        resizable: true,
        lastColumnResizable: false,
      }),
      TableRow,
      TableHeader,
      TableCell,
      TaskList,
      TaskItem.configure({
        nested: true,
      }),
      MarkdownHighlight,
      Placeholder.configure({ placeholder }),
    ],
    content: normalizedValue,
    editable,
    editorProps: {
      attributes: { class: 'tiptap focus:outline-none min-h-full' },
    },
    onUpdate({ editor }) {
      const md: string = (editor as any).storage.markdown?.getMarkdown?.() ?? ''
      if (md === lastSyncedRef.current) return
      lastSyncedRef.current = md
      onChange(md)
    },
    onBlur() {
      onBlur?.()
    },
  })

  const jumpToHeading = useCallback(
    (item: TableOfContentDataItem) => {
      if (!editor) return

      editor
        .chain()
        .focus()
        .setTextSelection(item.pos + 1)
        .run()

      const scrollParent = editorScrollRef.current
      if (scrollParent) {
        scrollParent.scrollTo({
          top: Math.max(0, item.dom.offsetTop - 24),
          behavior: 'smooth',
        })
      } else {
        item.dom.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }

      setIsHeadingNavigatorOpen(false)
    },
    [editor],
  )

  const selectedText = useCallback(() => {
    if (!editor) return ''
    const { from, to } = editor.state.selection
    return editor.state.doc.textBetween(from, to, '\n').trim()
  }, [editor])

  const handleFollowUp = useCallback(() => {
    const text = selectedText()
    if (!text) return
    onFollowUpSelection?.(text)
    editor?.commands.focus()
  }, [editor, onFollowUpSelection, selectedText])

  const toolbarState = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor?.isActive('bold') ?? false,
      italic: editor?.isActive('italic') ?? false,
      strike: editor?.isActive('strike') ?? false,
      code: editor?.isActive('code') ?? false,
      bulletList: editor?.isActive('bulletList') ?? false,
      orderedList: editor?.isActive('orderedList') ?? false,
      taskList: editor?.isActive('taskList') ?? false,
      blockquote: editor?.isActive('blockquote') ?? false,
      codeBlock: editor?.isActive('codeBlock') ?? false,
      highlight: editor?.isActive('highlight') ?? false,
      table: editor?.isActive('table') ?? false,
    }),
  }) ?? {
    bold: false,
    italic: false,
    strike: false,
    code: false,
    bulletList: false,
    orderedList: false,
    taskList: false,
    blockquote: false,
    codeBlock: false,
    highlight: false,
    table: false,
  }

  useEffect(() => {
    if (!editor || normalizedValue === lastSyncedRef.current) return
    lastSyncedRef.current = normalizedValue
    // Defer setContent out of the effect (React lifecycle). When the content
    // holds an ```html / ```details block, setContent makes ProseMirror build
    // the CodeBlockArtifactView React node view, which @tiptap/react renders
    // with flushSync. Calling it synchronously here means flushSync runs while
    // React is still flushing this effect → "flushSync was called from inside a
    // lifecycle method". A microtask runs it once React has unwound.
    const value = normalizedValue
    queueMicrotask(() => {
      if (editor.isDestroyed) return
      editor.commands.setContent(value)
    })
  }, [editor, normalizedValue])

  useEffect(() => {
    if (!editor) return
    editor.setEditable(editable)
  }, [editable, editor])

  useEffect(() => {
    if (!isHeadingNavigatorOpen) return

    const handlePointerDown = (event: PointerEvent) => {
      if (headingNavigatorRef.current?.contains(event.target as Node)) return
      setIsHeadingNavigatorOpen(false)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsHeadingNavigatorOpen(false)
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isHeadingNavigatorOpen])

  useEffect(() => {
    if (!editor) return
    const dom = editor.view.dom as HTMLElement
    dom.style.fontSize = `${fontSize}em`
    dom.style.lineHeight = String(lineHeight)
    dom.style.fontFamily = fontFamily ?? ''
    dom.style.fontWeight = String(fontWeight)
    dom.style.letterSpacing = letterSpacing ? `${letterSpacing}em` : ''
    dom.style.textAlign = textAlign
    dom.style.maxWidth = readingWidth > 0 ? `${readingWidth}ch` : ''
    dom.style.marginLeft = readingWidth > 0 ? 'auto' : ''
    dom.style.marginRight = readingWidth > 0 ? 'auto' : ''
    dom.style.setProperty('--markdown-paragraph-spacing', `${paragraphSpacing}em`)
    dom.style.setProperty('--markdown-first-line-indent', firstLineIndent ? `${firstLineIndent}em` : '0')
  }, [editor, firstLineIndent, fontSize, fontFamily, fontWeight, letterSpacing, lineHeight, paragraphSpacing, readingWidth, textAlign])

  const tocTree = useMemo(() => {
    const roots: TocTreeItem[] = []
    const stack: TocTreeItem[] = []

    tocItems.forEach((item) => {
      const treeItem: TocTreeItem = { ...item, children: [] }

      while (stack.length > 0 && stack[stack.length - 1].level >= item.level) {
        stack.pop()
      }

      const parent = stack[stack.length - 1]
      if (parent) {
        parent.children.push(treeItem)
      } else {
        roots.push(treeItem)
      }

      stack.push(treeItem)
    })

    return roots
  }, [tocItems])

  const tocColumns = useMemo(() => {
    const columns: TocTreeItem[][] = []
    if (tocTree.length === 0) return columns

    let currentColumn = tocTree
    columns.push(currentColumn)

    for (const id of activeHeadingPath) {
      const activeItem = currentColumn.find((item) => item.id === id)
      if (!activeItem?.children.length) break

      currentColumn = activeItem.children
      columns.push(currentColumn)
    }

    return columns
  }, [activeHeadingPath, tocTree])

  const visibleTocColumns = useMemo(
    () => tocColumns.map((column, columnIndex) => ({ column, columnIndex })).reverse(),
    [tocColumns],
  )

  const setActiveHeading = useCallback((columnIndex: number, item: TocTreeItem) => {
    setActiveHeadingPath((path) => [...path.slice(0, columnIndex), item.id])
  }, [])

  const headingNavigator = editor ? (
    <div ref={headingNavigatorRef} className="relative">
      <button
        type="button"
        title="Table of Content"
        aria-label="Table of Content"
        aria-expanded={isHeadingNavigatorOpen}
        className={cn(
          'flex h-7 items-center gap-1.5 rounded border border-gray-200 bg-white px-2 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900',
          isHeadingNavigatorOpen && 'border-emerald-200 bg-emerald-50 text-emerald-700',
        )}
        onMouseDown={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setIsHeadingNavigatorOpen((open) => !open)
        }}
      >
        <ListTree className="h-3.5 w-3.5" />
        <span className="whitespace-nowrap">Table of Content</span>
      </button>
      {isHeadingNavigatorOpen && (
        <div className="absolute top-full right-0 z-50 mt-2 overflow-hidden rounded-md border border-gray-200 bg-white shadow-lg">
          <div className="border-b border-gray-100 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
            Headings
          </div>
          <div className="flex max-h-[70vh] max-w-[min(64rem,calc(100vw-2rem))] overflow-x-auto">
            {visibleTocColumns.length > 0 ? (
              visibleTocColumns.map(({ column, columnIndex }) => (
                <div
                  key={columnIndex}
                  className={cn(
                    'max-h-[70vh] w-72 flex-shrink-0 overflow-y-auto p-1',
                    columnIndex > 0 && 'border-r border-gray-100',
                  )}
                >
                  {column.map((item) => {
                    const hasChildren = item.children.length > 0
                    const isSelected = activeHeadingPath[columnIndex] === item.id

                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={cn(
                          'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900',
                          item.isActive && 'bg-emerald-50 text-emerald-800',
                          isSelected && !item.isActive && 'bg-gray-50 text-gray-900',
                        )}
                        onMouseEnter={() => setActiveHeading(columnIndex, item)}
                        onFocus={() => setActiveHeading(columnIndex, item)}
                        onMouseDown={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                        }}
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          if (hasChildren && !isSelected) {
                            setActiveHeading(columnIndex, item)
                            return
                          }

                          jumpToHeading(item)
                        }}
                      >
                        {hasChildren && <ChevronLeft className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" />}
                        <span className="flex h-5 min-w-5 items-center justify-center rounded bg-gray-100 text-[10px] font-semibold text-gray-500">
                          H{item.originalLevel}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{item.textContent}</span>
                      </button>
                    )
                  })}
                </div>
              ))
            ) : (
              <div className="px-3 py-2 text-xs text-gray-400">No headings yet</div>
            )}
          </div>
        </div>
      )}
    </div>
  ) : null

  return (
    <div className={cn('markdown-editor flex h-full flex-col overflow-hidden', className)}>
      {headingNavigatorContainer && headingNavigator ? createPortal(headingNavigator, headingNavigatorContainer) : null}
      <style>{`
        .markdown-editor .tiptap.ProseMirror { outline: none; min-height: 100%; padding-bottom: 2rem; }
        .markdown-editor .tiptap.ProseMirror > *:first-child { margin-top: 0; }
        .markdown-editor .tiptap.ProseMirror p.is-editor-empty:first-child::before {
          content: attr(data-placeholder);
          float: left;
          color: #9ca3af;
          pointer-events: none;
          height: 0;
        }
        .markdown-editor .tiptap.ProseMirror h1 { font-size: 1.875em; font-weight: 700; margin: .6em 0 .4em; line-height: 1.25; }
        .markdown-editor .tiptap.ProseMirror h2 { font-size: 1.5em; font-weight: 700; margin: .6em 0 .4em; line-height: 1.3; }
        .markdown-editor .tiptap.ProseMirror h3 { font-size: 1.25em; font-weight: 600; margin: .6em 0 .4em; line-height: 1.35; }
        .markdown-editor .tiptap.ProseMirror h4,
        .markdown-editor .tiptap.ProseMirror h5,
        .markdown-editor .tiptap.ProseMirror h6 { font-weight: 600; margin: .6em 0 .4em; }
        .markdown-editor .tiptap.ProseMirror p {
          margin: 0 0 var(--markdown-paragraph-spacing, 1em);
          text-indent: var(--markdown-first-line-indent, 0);
        }
        .markdown-editor .tiptap.ProseMirror ul,
        .markdown-editor .tiptap.ProseMirror ol {
          padding-left: 1.5em;
          margin: 0 0 var(--markdown-paragraph-spacing, 1em);
        }
        .markdown-editor .tiptap.ProseMirror ul { list-style: disc; }
        .markdown-editor .tiptap.ProseMirror ol { list-style: decimal; }
        .markdown-editor .tiptap.ProseMirror li > p {
          margin: .15em 0;
          text-indent: 0;
        }
        .markdown-editor .tiptap.ProseMirror ul[data-type="taskList"] {
          list-style: none;
          padding-left: 0;
        }
        .markdown-editor .tiptap.ProseMirror ul.contains-task-list {
          list-style: none;
          padding-left: 0;
        }
        .markdown-editor .tiptap.ProseMirror ul:has(input[type="checkbox"]) {
          list-style: none;
          padding-left: 0;
        }
        .markdown-editor .tiptap.ProseMirror li[data-type="taskItem"] {
          display: flex;
          align-items: flex-start;
          gap: .55em;
          margin: .25em 0;
        }
        .markdown-editor .tiptap.ProseMirror li.task-list-item {
          display: flex;
          align-items: flex-start;
          gap: .55em;
          margin: .25em 0;
        }
        .markdown-editor .tiptap.ProseMirror li:has(> input[type="checkbox"]),
        .markdown-editor .tiptap.ProseMirror li:has(> label > input[type="checkbox"]) {
          display: flex;
          align-items: flex-start;
          gap: .55em;
          margin: .25em 0;
        }
        .markdown-editor .tiptap.ProseMirror li[data-type="taskItem"] > label {
          flex: 0 0 auto;
          margin-top: .25em;
        }
        .markdown-editor .tiptap.ProseMirror li.task-list-item > label {
          flex: 0 0 auto;
          margin-top: .25em;
        }
        .markdown-editor .tiptap.ProseMirror li[data-type="taskItem"] > div {
          flex: 1 1 auto;
          min-width: 0;
        }
        .markdown-editor .tiptap.ProseMirror li[data-type="taskItem"] > div > p {
          margin: 0;
          text-indent: 0;
        }
        .markdown-editor .tiptap.ProseMirror li.task-list-item > p {
          flex: 1 1 auto;
          min-width: 0;
          margin: 0;
          text-indent: 0;
        }
        .markdown-editor .tiptap.ProseMirror li:has(> input[type="checkbox"]) > p,
        .markdown-editor .tiptap.ProseMirror li:has(> label > input[type="checkbox"]) > p,
        .markdown-editor .tiptap.ProseMirror li:has(> label > input[type="checkbox"]) > div > p {
          flex: 1 1 auto;
          min-width: 0;
          margin: 0;
          text-indent: 0;
        }
        .markdown-editor .tiptap.ProseMirror li[data-type="taskItem"] input[type="checkbox"] {
          height: 1em;
          width: 1em;
          accent-color: #059669;
        }
        .markdown-editor .tiptap.ProseMirror li.task-list-item input[type="checkbox"] {
          height: 1em;
          width: 1em;
          accent-color: #059669;
        }
        .markdown-editor .tiptap.ProseMirror li:has(> input[type="checkbox"]) > input[type="checkbox"],
        .markdown-editor .tiptap.ProseMirror li:has(> label > input[type="checkbox"]) > label {
          flex: 0 0 auto;
          margin-top: .25em;
        }
        .markdown-editor .tiptap.ProseMirror blockquote {
          border-left: 3px solid #d1d5db;
          padding-left: .9em;
          color: #4b5563;
          margin: .6em 0;
        }
        .markdown-editor .tiptap.ProseMirror p code,
        .markdown-editor .tiptap.ProseMirror li code,
        .markdown-editor .tiptap.ProseMirror blockquote code {
          background: #f3f4f6;
          color: #be123c;
          padding: .1em .3em;
          border-radius: 4px;
          font-size: .9em;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        }
        .markdown-editor .tiptap.ProseMirror pre {
          background: #0f172a;
          color: #e5e7eb;
          padding: .8em 1em;
          border-radius: 6px;
          overflow-x: auto;
          margin: .6em 0;
          text-align: left;
          text-indent: 0;
          letter-spacing: 0;
          font-weight: 400;
        }
        .markdown-editor .tiptap.ProseMirror pre code {
          background: transparent;
          padding: 0;
          color: inherit;
        }
        .markdown-editor .tiptap.ProseMirror pre .hljs-comment,
        .markdown-editor .tiptap.ProseMirror pre .hljs-quote {
          color: #94a3b8;
          font-style: italic;
        }
        .markdown-editor .tiptap.ProseMirror pre .hljs-keyword,
        .markdown-editor .tiptap.ProseMirror pre .hljs-selector-tag,
        .markdown-editor .tiptap.ProseMirror pre .hljs-subst {
          color: #c084fc;
        }
        .markdown-editor .tiptap.ProseMirror pre .hljs-string,
        .markdown-editor .tiptap.ProseMirror pre .hljs-attr,
        .markdown-editor .tiptap.ProseMirror pre .hljs-symbol,
        .markdown-editor .tiptap.ProseMirror pre .hljs-bullet {
          color: #86efac;
        }
        .markdown-editor .tiptap.ProseMirror pre .hljs-number,
        .markdown-editor .tiptap.ProseMirror pre .hljs-literal,
        .markdown-editor .tiptap.ProseMirror pre .hljs-variable,
        .markdown-editor .tiptap.ProseMirror pre .hljs-template-variable {
          color: #fbbf24;
        }
        .markdown-editor .tiptap.ProseMirror pre .hljs-title,
        .markdown-editor .tiptap.ProseMirror pre .hljs-section,
        .markdown-editor .tiptap.ProseMirror pre .hljs-name {
          color: #93c5fd;
        }
        .markdown-editor .tiptap.ProseMirror pre .hljs-type,
        .markdown-editor .tiptap.ProseMirror pre .hljs-class .hljs-title,
        .markdown-editor .tiptap.ProseMirror pre .hljs-built_in,
        .markdown-editor .tiptap.ProseMirror pre .hljs-builtin-name {
          color: #67e8f9;
        }
        .markdown-editor .tiptap.ProseMirror pre .hljs-meta,
        .markdown-editor .tiptap.ProseMirror pre .hljs-link {
          color: #fca5a5;
        }
        .markdown-editor .tiptap.ProseMirror pre .hljs-emphasis {
          font-style: italic;
        }
        .markdown-editor .tiptap.ProseMirror pre .hljs-strong {
          font-weight: 700;
        }
        .markdown-editor .tiptap.ProseMirror hr {
          border: none;
          border-top: 1px solid #e5e7eb;
          margin: 1em 0;
        }
        .markdown-editor .tiptap.ProseMirror mark {
          border-radius: 3px;
          background: #fef08a;
          padding: 0 .12em;
        }
        .markdown-editor .tiptap.ProseMirror a {
          color: #2563eb;
          text-decoration: underline;
          cursor: pointer;
        }
        .markdown-editor .tiptap.ProseMirror .tableWrapper {
          margin: .8em 0;
          overflow-x: auto;
          border: 1px solid #e5e7eb;
          border-radius: 8px;
        }
        .markdown-editor .tiptap.ProseMirror table {
          width: 100%;
          min-width: 420px;
          border-collapse: collapse;
          table-layout: fixed;
          text-align: left;
        }
        .markdown-editor .tiptap.ProseMirror th,
        .markdown-editor .tiptap.ProseMirror td {
          position: relative;
          min-width: 90px;
          border: 1px solid #e5e7eb;
          padding: .45em .6em;
          vertical-align: top;
        }
        .markdown-editor .tiptap.ProseMirror th {
          background: #f8fafc;
          color: #334155;
          font-weight: 650;
        }
        .markdown-editor .tiptap.ProseMirror tr:nth-child(even) td {
          background: #f8fafc80;
        }
        .markdown-editor .tiptap.ProseMirror .selectedCell::after {
          content: "";
          position: absolute;
          inset: 0;
          pointer-events: none;
          background: rgba(14, 165, 233, .14);
        }
        .markdown-editor .tiptap.ProseMirror .column-resize-handle {
          position: absolute;
          top: 0;
          right: -2px;
          bottom: -1px;
          width: 4px;
          background: #38bdf8;
          pointer-events: none;
        }
        .markdown-editor .tiptap.ProseMirror.resize-cursor {
          cursor: col-resize;
        }
      `}</style>
      {editor && (
        <div className="flex flex-shrink-0 items-center gap-1 overflow-x-auto border-b border-gray-100 bg-white/95 px-2 py-1">
          <ToolbarButton label="Bold" active={toolbarState.bold} onClick={() => editor.chain().focus().toggleBold().run()}>
            <Bold className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton label="Italic" active={toolbarState.italic} onClick={() => editor.chain().focus().toggleItalic().run()}>
            <Italic className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton label="Strike" active={toolbarState.strike} onClick={() => editor.chain().focus().toggleStrike().run()}>
            <Strikethrough className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton label="Inline code" active={toolbarState.code} onClick={() => editor.chain().focus().toggleCode().run()}>
            <Code className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton label="Highlight" active={toolbarState.highlight} onClick={() => editor.chain().focus().toggleHighlight().run()}>
            <Highlighter className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarDivider />
          <ToolbarButton label="Bullet list" active={toolbarState.bulletList} onClick={() => editor.chain().focus().toggleBulletList().run()}>
            <List className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton label="Numbered list" active={toolbarState.orderedList} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
            <ListOrdered className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton label="Task list" active={toolbarState.taskList} onClick={() => editor.chain().focus().toggleTaskList().run()}>
            <CheckSquare className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton label="Quote" active={toolbarState.blockquote} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
            <Quote className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton label="Code block" active={toolbarState.codeBlock} onClick={() => editor.chain().focus().toggleCodeBlock().run()}>
            <Code className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton
            label="Collapsible block"
            onClick={() =>
              editor
                .chain()
                .focus()
                .insertContent({
                  type: 'codeBlock',
                  attrs: { language: 'details' },
                  content: [{ type: 'text', text: 'Summary\nHidden content…' }],
                })
                .run()
            }
          >
            <ListCollapse className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarDivider />
          <ToolbarButton
            label="Insert table"
            active={toolbarState.table}
            onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
          >
            <Table2 className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton label="Divider" onClick={() => editor.chain().focus().setHorizontalRule().run()}>
            <Minus className="h-3.5 w-3.5" />
          </ToolbarButton>
        </div>
      )}
      {editor && onFollowUpSelection && (
        <BubbleMenu
          pluginKey="markdown-follow-up"
          editor={editor}
          updateDelay={80}
          shouldShow={({ editor, from, to }) =>
            editor.isFocused && from !== to && editor.state.doc.textBetween(from, to, '\n').trim().length > 0
          }
          appendTo={() => document.body}
          options={{
            strategy: 'fixed',
            placement: 'bottom',
            offset: 8,
            flip: true,
            shift: { padding: 8 },
            inline: true,
          }}
        >
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 shadow-lg hover:bg-gray-50"
            onMouseDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onClick={handleFollowUp}
          >
            <MessageCircle className="h-3.5 w-3.5 text-blue-500" />
            Follow up
          </button>
        </BubbleMenu>
      )}
      {editor && (
        <BubbleMenu
          pluginKey="markdown-table-menu"
          editor={editor}
          updateDelay={80}
          shouldShow={({ editor }) => editor.isFocused && editor.isActive('table')}
          appendTo={() => document.body}
          options={{
            strategy: 'fixed',
            placement: 'top',
            offset: 8,
            flip: true,
            shift: { padding: 8 },
          }}
        >
          <div
            className="flex items-center gap-1 rounded-md border border-gray-200 bg-white p-1 shadow-lg"
            onMouseDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
          >
            <ToolbarButton label="Add row" onClick={() => editor.chain().focus().addRowAfter().run()}>
              <Rows3 className="h-3.5 w-3.5" />
            </ToolbarButton>
            <ToolbarButton label="Add column" onClick={() => editor.chain().focus().addColumnAfter().run()}>
              <Columns3 className="h-3.5 w-3.5" />
            </ToolbarButton>
            <ToolbarDivider />
            <ToolbarButton label="Delete row" onClick={() => editor.chain().focus().deleteRow().run()}>
              <Rows3 className="h-3.5 w-3.5 rotate-45" />
            </ToolbarButton>
            <ToolbarButton label="Delete column" onClick={() => editor.chain().focus().deleteColumn().run()}>
              <Columns3 className="h-3.5 w-3.5 rotate-45" />
            </ToolbarButton>
            <ToolbarButton label="Delete table" onClick={() => editor.chain().focus().deleteTable().run()}>
              <Trash2 className="h-3.5 w-3.5 text-red-500" />
            </ToolbarButton>
          </div>
        </BubbleMenu>
      )}
      <div className="relative min-h-0 flex-1">
        <div ref={editorScrollRef} className="h-full overflow-auto">
          <EditorContent editor={editor} className="min-h-full" />
        </div>
      </div>
    </div>
  )
}

function ToolbarButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onMouseDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        if (!disabled) onClick()
      }}
      className={cn(
        'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded border border-transparent text-gray-500 transition-colors hover:border-gray-200 hover:bg-gray-50 hover:text-gray-900',
        active && 'border-emerald-200 bg-emerald-50 text-emerald-700',
        disabled && 'cursor-not-allowed opacity-40',
      )}
    >
      {children}
    </button>
  )
}

function ToolbarDivider() {
  return <div className="mx-1 h-5 w-px flex-shrink-0 bg-gray-200" />
}
