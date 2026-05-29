'use client'

import { useState } from 'react'
import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { ChevronDown, ChevronRight, Code2, Eye } from 'lucide-react'
import { HtmlArtifact } from '@/components/HtmlArtifact'
import { LazyMarkdownRenderer } from '@/components/LazyMarkdownRenderer'
import { cn } from '@/lib/utils'

// TipTap node view for code blocks with special languages:
//   ```html    → live sandboxed artifact (HtmlArtifact) + Code/Preview flip
//   ```details → collapsible block (summary = first line, body = markdown) + edit flip
// Any other language renders as a normal code block so lowlight highlighting
// is kept.
//
// Both stay plain codeBlock nodes in the document, so tiptap-markdown still
// round-trips them verbatim (```html / ```details) — no schema, no backend, no
// custom markdown parse/serialize glue. The editable source (NodeViewContent)
// is always in the DOM (ProseMirror needs the contentDOM); we only toggle its
// visibility against the rendered view.
export function CodeBlockArtifactView({ node }: NodeViewProps) {
  const language: string = node.attrs.language || ''
  const isHtml = language === 'html' || language === 'htm'
  const isDetails = language === 'details'

  // Fresh empty block opens in source so you can type; populated (e.g. agent
  // output) opens rendered.
  const [showSource, setShowSource] = useState(() => node.textContent.trim() === '')
  const [open, setOpen] = useState(false)

  if (isHtml) {
    return (
      <NodeViewWrapper className="my-3 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
        <div
          className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-2 py-1 dark:border-slate-700 dark:bg-slate-800/60"
          contentEditable={false}
        >
          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            HTML
          </span>
          <button
            type="button"
            onClick={() => setShowSource((s) => !s)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-slate-600 transition-colors hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-700"
          >
            {showSource ? <><Eye className="h-3 w-3" /> Preview</> : <><Code2 className="h-3 w-3" /> Code</>}
          </button>
        </div>
        <pre className={cn('hljs m-0', showSource ? 'block' : 'hidden')}>
          <NodeViewContent className="language-html" />
        </pre>
        {!showSource && (
          <div contentEditable={false}>
            <HtmlArtifact html={node.textContent} />
          </div>
        )}
      </NodeViewWrapper>
    )
  }

  if (isDetails) {
    const text = node.textContent
    const nl = text.indexOf('\n')
    const summary = (nl === -1 ? text : text.slice(0, nl)).trim() || 'Details'
    const body = nl === -1 ? '' : text.slice(nl + 1)

    return (
      <NodeViewWrapper className="my-3 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
        <div
          className="flex items-center justify-between gap-2 bg-slate-50 px-2 py-1.5 dark:bg-slate-800/60"
          contentEditable={false}
        >
          <button
            type="button"
            onClick={() => !showSource && setOpen((o) => !o)}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm font-medium text-slate-700 dark:text-slate-200"
          >
            {showSource ? (
              <Code2 className="h-3.5 w-3.5 flex-shrink-0 text-slate-400" />
            ) : open ? (
              <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-slate-400" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-slate-400" />
            )}
            <span className="truncate">{summary}</span>
          </button>
          <button
            type="button"
            onClick={() => setShowSource((s) => !s)}
            className="flex flex-shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-slate-600 transition-colors hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-700"
          >
            {showSource ? <><Eye className="h-3 w-3" /> Done</> : <><Code2 className="h-3 w-3" /> Edit</>}
          </button>
        </div>
        <pre className={cn('hljs m-0', showSource ? 'block' : 'hidden')}>
          <NodeViewContent className="language-details" />
        </pre>
        {!showSource && open && (
          <div contentEditable={false} className="border-t border-slate-200 px-3 py-2 dark:border-slate-700">
            <LazyMarkdownRenderer content={body} />
          </div>
        )}
      </NodeViewWrapper>
    )
  }

  return (
    <NodeViewWrapper as="pre" className="hljs">
      <NodeViewContent className={language ? `language-${language}` : undefined} />
    </NodeViewWrapper>
  )
}
