'use client'

import React, { useState, useRef, useEffect } from 'react'
import { MarkdownRenderer } from './MarkdownRenderer'

interface LazyMarkdownRendererProps {
  content: string
  className?: string
  maxLines?: number
  theme?: 'light' | 'dark'
  fontSize?: number
  lineHeight?: number
  fontFamily?: string
  fontWeight?: number
  paragraphSpacing?: number
  readingWidth?: number
  letterSpacing?: number
  textAlign?: 'left' | 'justify'
  firstLineIndent?: number
}

export function LazyMarkdownRenderer(props: LazyMarkdownRendererProps) {
  // Start with true for small content that's likely visible immediately
  const [isVisible, setIsVisible] = useState(() => {
    // For small content (< 500 chars), just render immediately
    return props.content.length < 500
  })
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Skip if already visible
    if (isVisible) return

    const element = containerRef.current
    if (!element) return

    // Find the scrollable parent (the preview container)
    let scrollParent = element.parentElement
    while (scrollParent) {
      const overflow = window.getComputedStyle(scrollParent).overflow
      const overflowY = window.getComputedStyle(scrollParent).overflowY
      if (overflow === 'auto' || overflow === 'scroll' ||
          overflowY === 'auto' || overflowY === 'scroll') {
        break
      }
      scrollParent = scrollParent.parentElement
    }

    // Create observer with generous buffer
    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries
        // Once visible, stay visible (don't unload)
        if (entry.isIntersecting) {
          setIsVisible(true)
        }
      },
      {
        root: scrollParent, // Observe within the scrollable container
        // Generous buffer: load content when within 1000px of viewport
        rootMargin: '1000px',
        threshold: 0
      }
    )

    observer.observe(element)
    return () => observer.unobserve(element)
  }, [isVisible])

  // If not visible yet, show a placeholder
  if (!isVisible) {
    return (
      <div
        ref={containerRef}
        className="min-h-[100px] flex items-center justify-center py-8"
      >
        <div className="text-gray-400">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 bg-gray-300 rounded-full"></div>
            <div className="w-2 h-2 bg-gray-300 rounded-full"></div>
            <div className="w-2 h-2 bg-gray-300 rounded-full"></div>
          </div>
        </div>
      </div>
    )
  }

  // Once visible, render the actual markdown
  return <MarkdownRenderer {...props} />
}
