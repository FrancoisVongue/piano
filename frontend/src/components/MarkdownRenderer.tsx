'use client'

import React, { memo, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { LazyCodeBlock } from './LazyCodeBlock'
import { cn } from '@/lib/utils'

interface MarkdownRendererProps {
  content: string
  className?: string
  maxLines?: number
  theme?: 'light' | 'dark'
  fontSize?: number
  lineHeight?: number
  fontFamily?: string
  fontWeight?: number
  paragraphSpacing?: number
  /** Max reading width in characters, 0 disables (full width). */
  readingWidth?: number
  /** Extra letter spacing in em. 0 = default. */
  letterSpacing?: number
  /** Paragraph alignment — 'left' or 'justify'. */
  textAlign?: 'left' | 'justify'
  /** First-line indent in em. 0 = none. */
  firstLineIndent?: number
}

function MarkdownRendererComponent({
  content,
  className,
  maxLines,
  theme = 'light',
  fontSize = 1.0,
  lineHeight = 1.6,
  fontFamily,
  fontWeight = 400,
  paragraphSpacing = 1.0,
  readingWidth = 0,
  letterSpacing = 0,
  textAlign = 'left',
  firstLineIndent = 0,
}: MarkdownRendererProps) {
  const base = 15 * fontSize
  const sizes = {
    h1: Math.round(base * 2.0),
    h2: Math.round(base * 1.55),
    h3: Math.round(base * 1.25),
    h4: Math.round(base * 1.1),
    base: Math.round(base),
    small: Math.round(base * 0.85),
  }

  const displayContent = useMemo(() => {
    if (!content.trim()) return ''
    return maxLines ? truncateToLines(content, maxLines) : content
  }, [content, maxLines])

  const textStyle = {
    fontSize: `${sizes.base}px`,
    lineHeight,
    fontFamily: fontFamily || undefined,
    fontWeight,
    letterSpacing: letterSpacing ? `${letterSpacing}em` : undefined,
    textAlign,
    textIndent: firstLineIndent ? `${firstLineIndent}em` : undefined,
  } as const

  const components = useMemo(() => ({
    h1: ({ children }: any) => (
      <h1
        className="mt-8 mb-4 pb-3 border-b-2 border-blue-200 dark:border-blue-800 text-slate-900 dark:text-slate-100 tracking-tight first:mt-0"
        style={{ fontSize: `${sizes.h1}px`, lineHeight: 1.2, fontWeight: 800 }}
      >
        {children}
      </h1>
    ),
    h2: ({ children }: any) => (
      <h2
        className="mt-7 mb-3 pb-2 border-b border-teal-200 dark:border-teal-800 text-slate-800 dark:text-slate-200 tracking-tight"
        style={{ fontSize: `${sizes.h2}px`, lineHeight: 1.25, fontWeight: 700 }}
      >
        {children}
      </h2>
    ),
    h3: ({ children }: any) => (
      <h3
        className="mt-6 mb-3 text-slate-800 dark:text-slate-200"
        style={{ fontSize: `${sizes.h3}px`, lineHeight: 1.3, fontWeight: 650 }}
      >
        <span className="text-amber-500 dark:text-amber-400 mr-1.5">#</span>
        {children}
      </h3>
    ),
    h4: ({ children }: any) => (
      <h4
        className="mt-5 mb-2 text-slate-700 dark:text-slate-300"
        style={{ fontSize: `${sizes.h4}px`, lineHeight: 1.35, fontWeight: 600 }}
      >
        {children}
      </h4>
    ),

    p: ({ children }: any) => (
      <p
        className="text-slate-700 dark:text-slate-300"
        style={{ ...textStyle, marginBottom: `${paragraphSpacing}em` }}
      >
        {children}
      </p>
    ),

    ul: ({ children, className }: any) => {
      const isTaskList = String(className ?? '').includes('contains-task-list')
      return (
        <ul
          className={cn(
            'mb-4 space-y-1',
            isTaskList ? 'ml-0 list-none pl-0' : 'ml-5',
          )}
          style={{ fontSize: `${sizes.base}px` }}
        >
          {children}
        </ul>
      )
    },
    ol: ({ children }: any) => (
      <ol
        className="mb-4 ml-5 list-decimal space-y-1 marker:text-blue-500 marker:font-semibold dark:marker:text-blue-400"
        style={{ fontSize: `${sizes.base}px` }}
      >
        {children}
      </ol>
    ),
    li: ({ children, ordered, checked, className }: any) => {
      const isTaskItem = typeof checked === 'boolean' || String(className ?? '').includes('task-list-item')
      return (
        <li
          className={cn(
            'text-slate-700 dark:text-slate-300',
            isTaskItem ? 'flex items-start gap-2 pl-0' : 'pl-1',
            !ordered && !isTaskItem && "relative before:absolute before:left-[-1.1em] before:text-teal-500 before:font-bold before:content-['•'] dark:before:text-teal-400",
            className,
          )}
          style={{
            lineHeight,
            fontFamily: fontFamily || undefined,
            fontWeight,
            letterSpacing: letterSpacing ? `${letterSpacing}em` : undefined,
          }}
        >
          {children}
        </li>
      )
    },

    blockquote: ({ children }: any) => (
      <blockquote
        className="border-l-[3px] border-blue-400 dark:border-blue-500 pl-4 py-2 my-4 text-slate-600 dark:text-slate-400 bg-blue-50/60 dark:bg-blue-950/30 rounded-r-lg"
        style={{ fontSize: `${sizes.base}px` }}
      >
        {children}
      </blockquote>
    ),

    code({ node, inline, className: codeClassName, children, ...props }: any) {
      const match = /language-(\w+)/.exec(codeClassName || '')
      const language = match ? match[1] : ''

      return !inline && language ? (
        <LazyCodeBlock language={language} theme={theme} fontSize={sizes.small} {...props}>
          {String(children).replace(/\n$/, '')}
        </LazyCodeBlock>
      ) : (
        <code
          className={cn(
            'bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400 px-1.5 py-0.5 rounded-md font-mono',
            codeClassName,
          )}
          style={{ fontSize: `${sizes.small}px` }}
          {...props}
        >
          {children}
        </code>
      )
    },

    table: ({ children }: any) => (
      <div className="overflow-x-auto my-5 rounded-lg border border-slate-200 dark:border-slate-700">
        <table className="min-w-full border-collapse" style={{ fontSize: `${sizes.base}px` }}>
          {children}
        </table>
      </div>
    ),
    thead: ({ children }: any) => (
      <thead className="bg-slate-50 dark:bg-slate-800/60">{children}</thead>
    ),
    tbody: ({ children }: any) => (
      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{children}</tbody>
    ),
    tr: ({ children }: any) => (
      <tr className="even:bg-slate-50/50 dark:even:bg-slate-800/30">{children}</tr>
    ),
    th: ({ children }: any) => (
      <th className="px-4 py-2.5 text-left text-slate-700 dark:text-slate-300 border-b border-slate-200 dark:border-slate-700" style={{ fontSize: `${sizes.base}px`, fontWeight: 600 }}>
        {children}
      </th>
    ),
    td: ({ children }: any) => (
      <td className="px-4 py-2.5 text-slate-700 dark:text-slate-300" style={{ fontSize: `${sizes.base}px` }}>
        {children}
      </td>
    ),

    hr: () => <hr className="my-8 border-slate-200 dark:border-slate-700" />,

    input: ({ type, checked, disabled }: any) => {
      if (type === 'checkbox') {
        const s = Math.round(sizes.base * 0.9)
        return (
          <input
            type="checkbox"
            checked={checked}
            disabled={disabled}
            className="mt-[0.2em] flex-shrink-0 rounded border-slate-300 text-teal-500 focus:ring-teal-400"
            style={{ width: `${s}px`, height: `${s}px` }}
            readOnly
          />
        )
      }
      return null
    },

    a: ({ children, href }: any) => (
      <a
        href={href}
        className="text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 underline decoration-blue-300/60 hover:decoration-blue-500 underline-offset-2 transition-colors"
        target="_blank"
        rel="noopener noreferrer"
        style={{ fontSize: `${sizes.base}px` }}
      >
        {children}
      </a>
    ),

    strong: ({ children }: any) => (
      <strong className="font-bold text-slate-900 dark:text-slate-100">{children}</strong>
    ),
    em: ({ children }: any) => (
      <em className="italic text-slate-600 dark:text-slate-400">{children}</em>
    ),
    del: ({ children }: any) => (
      <del className="line-through text-slate-400 dark:text-slate-500">{children}</del>
    ),
  }), [theme, sizes, textStyle, lineHeight, fontFamily, fontWeight, paragraphSpacing, letterSpacing])

  if (!content.trim()) {
    return (
      <div className={cn('text-slate-400 italic', className)}>
        No content to display...
      </div>
    )
  }

  return (
    <div
      className={cn('w-full', className)}
      style={{
        maxWidth: readingWidth > 0 ? `${readingWidth}ch` : undefined,
        marginLeft: readingWidth > 0 ? 'auto' : undefined,
        marginRight: readingWidth > 0 ? 'auto' : undefined,
      }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {displayContent}
      </ReactMarkdown>
      {maxLines && content.split('\n').length > maxLines && (
        <div className="text-xs text-slate-400 mt-2 text-center">
          <span className="bg-slate-100 dark:bg-slate-800 px-2 py-1 rounded">
            ... content truncated ...
          </span>
        </div>
      )}
    </div>
  )
}

function truncateToLines(text: string, maxLines: number): string {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return text
  return lines.slice(0, maxLines).join('\n')
}

const arePropsEqual = (prev: MarkdownRendererProps, next: MarkdownRendererProps) =>
  prev.content === next.content &&
  prev.className === next.className &&
  prev.maxLines === next.maxLines &&
  prev.theme === next.theme &&
  prev.fontSize === next.fontSize &&
  prev.lineHeight === next.lineHeight &&
  prev.fontFamily === next.fontFamily &&
  prev.fontWeight === next.fontWeight &&
  prev.paragraphSpacing === next.paragraphSpacing &&
  prev.readingWidth === next.readingWidth &&
  prev.letterSpacing === next.letterSpacing &&
  prev.textAlign === next.textAlign &&
  prev.firstLineIndent === next.firstLineIndent

export const MarkdownRenderer = memo(MarkdownRendererComponent, arePropsEqual)
