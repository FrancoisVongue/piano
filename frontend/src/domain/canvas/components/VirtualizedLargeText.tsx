'use client';

import React, { memo, useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

const INITIAL_INDEX_CHARS = 48_000;
const INDEX_CHUNK_CHARS = 180_000;
const OVERSCAN_LINES = 12;
const MAX_RENDERED_LINE_CHARS = 8_000;

interface LineIndexState {
  starts: number[];
  scannedUntil: number;
  complete: boolean;
}

interface VirtualizedLargeTextProps {
  value: string;
  previewKey: string;
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  fontWeight: number;
  letterSpacing: number;
  textAlign: 'left' | 'justify';
  readingWidth: number;
  firstLineIndent: number;
}

function formatContentSize(length: number) {
  if (length < 1000) return `${length} chars`;
  return `${Math.round(length / 1000)}k chars`;
}

function scanLineStarts(
  value: string,
  previous: LineIndexState,
  chunkChars: number
): LineIndexState {
  if (previous.complete) return previous;

  const starts = previous.starts.slice();
  const from = previous.scannedUntil;
  const to = Math.min(value.length, from + chunkChars);

  for (let i = from; i < to; i += 1) {
    if (value.charCodeAt(i) === 10 && i + 1 < value.length) {
      starts.push(i + 1);
    }
  }

  return {
    starts,
    scannedUntil: to,
    complete: to >= value.length,
  };
}

function createInitialLineIndex(value: string): LineIndexState {
  return scanLineStarts(
    value,
    { starts: [0], scannedUntil: 0, complete: value.length === 0 },
    INITIAL_INDEX_CHARS
  );
}

function estimateLineCount(index: LineIndexState, totalLength: number) {
  if (index.complete) return index.starts.length;
  const averageLineLength = Math.max(1, index.scannedUntil / Math.max(1, index.starts.length));
  return Math.max(index.starts.length, Math.ceil(totalLength / averageLineLength));
}

export const VirtualizedLargeText = memo(function VirtualizedLargeText({
  value,
  previewKey,
  fontSize,
  fontFamily,
  lineHeight,
  fontWeight,
  letterSpacing,
  textAlign,
  readingWidth,
  firstLineIndent,
}: VirtualizedLargeTextProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [lineIndex, setLineIndex] = useState(() => createInitialLineIndex(value));

  useEffect(() => {
    setLineIndex(createInitialLineIndex(value));
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [previewKey, value.length]);

  useEffect(() => {
    if (lineIndex.complete) return;
    const timer = window.setTimeout(() => {
      setLineIndex((current) => scanLineStarts(value, current, INDEX_CHUNK_CHARS));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [lineIndex, value]);

  const lineHeightPx = Math.max(14, Math.round(16 * fontSize * lineHeight));
  const totalLineCount = estimateLineCount(lineIndex, value.length);
  const rowVirtualizer = useVirtualizer({
    count: Math.max(totalLineCount, 1),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => lineHeightPx,
    overscan: OVERSCAN_LINES,
  });

  return (
    <div
      ref={scrollRef}
      className="h-full min-h-[18rem] overflow-auto text-gray-900"
      style={{
        fontSize: `${fontSize}em`,
        fontFamily,
        lineHeight,
        fontWeight,
        letterSpacing: letterSpacing ? `${letterSpacing}em` : undefined,
        width: readingWidth > 0 ? `${readingWidth}ch` : '100%',
        maxWidth: '100%',
        marginLeft: readingWidth > 0 ? 'auto' : undefined,
        marginRight: readingWidth > 0 ? 'auto' : undefined,
      }}
    >
      <div className="relative min-w-full" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const line = virtualRow.index;
          const start = lineIndex.starts[line];
          if (start === undefined) {
            return (
              <div
                key={virtualRow.key}
                className="absolute top-0 left-0 flex min-w-max pl-12 text-xs text-gray-400"
                style={{
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                Indexing text...
              </div>
            );
          }

          const nextStart = lineIndex.starts[line + 1];
          const knownEnd =
            nextStart !== undefined
              ? nextStart - 1
              : lineIndex.complete
                ? value.length
                : Math.min(value.length, lineIndex.scannedUntil);
          const end = Math.min(knownEnd, start + MAX_RENDERED_LINE_CHARS);
          const text = value.slice(start, end);
          const truncated = end < knownEnd;

          return (
            <div
              key={virtualRow.key}
              className="absolute top-0 left-0 flex min-w-max"
              style={{
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <span className="w-12 flex-none pr-3 text-right text-[11px] text-gray-300 select-none">
                {line + 1}
              </span>
              <span
                className="whitespace-pre"
                style={{
                  textAlign,
                  textIndent: firstLineIndent && text.trim() ? `${firstLineIndent}em` : undefined,
                }}
              >
                {text || ' '}
                {truncated && <span className="text-gray-400"> ...</span>}
              </span>
            </div>
          );
        })}
        {!lineIndex.complete && (
          <div className="pointer-events-none sticky bottom-0 ml-auto w-fit bg-white/90 px-2 py-1 text-[11px] text-gray-400">
            Indexed {formatContentSize(lineIndex.scannedUntil)} of {formatContentSize(value.length)}
          </div>
        )}
      </div>
    </div>
  );
});
