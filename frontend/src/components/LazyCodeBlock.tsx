'use client'

import React, { useState, useRef, useEffect } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneLight, oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { cn } from '@/lib/utils'

interface LazyCodeBlockProps {
  children: string
  language: string
  theme?: 'light' | 'dark'
  fontSize?: number
  className?: string
}

export function LazyCodeBlock({
  children,
  language,
  theme = 'light',
  fontSize = 12,
  className
}: LazyCodeBlockProps) {
  const [shouldHighlight, setShouldHighlight] = useState(false)
  const elementRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = elementRef.current
    if (!element) return

    // Find the scrollable parent container
    let scrollParent = element.parentElement
    while (scrollParent) {
      const overflow = window.getComputedStyle(scrollParent).overflow
      if (overflow === 'auto' || overflow === 'scroll' || overflow === 'hidden') {
        break
      }
      scrollParent = scrollParent.parentElement
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries
        if (entry.isIntersecting) {
          setTimeout(() => setShouldHighlight(true), 50)
        }
      },
      {
        root: scrollParent, // Use the scrollable container as root
        rootMargin: "400px",
        threshold: 0
      }
    )

    observer.observe(element)
    return () => observer.unobserve(element)
  }, [])

  // If not visible yet, show plain code
  if (!shouldHighlight) {
    return (
      <div ref={elementRef} className="my-4">
        <pre
          className={cn(
            "bg-gray-50 dark:bg-gray-900 text-gray-800 dark:text-gray-200 p-4 rounded border border-gray-200 dark:border-gray-700 overflow-x-auto font-mono text-sm leading-relaxed",
            className
          )}
          style={{ fontSize: `${fontSize}px` }}
        >
          <code>{children}</code>
        </pre>
      </div>
    )
  }

  return (
    <div className="my-4 relative">
      <SyntaxHighlighter
        style={theme === 'dark' ? oneDark : oneLight}
        language={language}
        PreTag="div"
        className={cn("rounded border border-gray-200 dark:border-gray-700", className)}
        customStyle={{ fontSize: `${fontSize}px` }}
        showLineNumbers={children.split('\n').length > 10} // Show line numbers for longer blocks
      >
        {children.replace(/\n$/, '')}
      </SyntaxHighlighter>
    </div>
  )
}