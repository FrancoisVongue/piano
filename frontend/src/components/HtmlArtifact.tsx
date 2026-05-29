'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

// Renders untrusted HTML (agent- or user-authored) inside a hard sandbox.
//
// Security model (decided with the team):
//   - sandbox="allow-scripts" WITHOUT allow-same-origin → scripts run in an
//     opaque origin and cannot reach our cookies, localStorage, or make
//     authenticated same-origin requests. (Never add allow-same-origin: with
//     allow-scripts it fully defeats the sandbox.)
//   - No allow-top-navigation / allow-popups / allow-forms → the box can't
//     redirect the tab or open windows.
//   - CSP inside the document: scripts/styles/images/fonts may load from any
//     https: CDN (so artifacts can pull mermaid, charting libs, etc.) plus
//     inline. The exfiltration boundary is held by connect-src 'none', which
//     blocks fetch/XHR/WebSocket/EventSource/sendBeacon — a loaded library can
//     render, but it cannot phone home with any data it can see. img-src/
//     font-src add https: only so a remote tracking pixel can't smuggle data
//     out via a URL the way a `connect` would (the opaque origin already has
//     no cookies/storage to leak).
//
// Height: a cross-origin sandboxed frame can't expose its size via the DOM, so
// a tiny trusted shim posts scrollHeight to us; we validate the message by
// source identity (not origin, which is "null" for sandboxed srcdoc).

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https:",
  "style-src 'unsafe-inline' https:",
  "img-src data: https:",
  "font-src data: https:",
  "media-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

const isFullHtmlDocument = (html: string) => /(?:<!doctype\s+html|<html\b)/i.test(html)

// Height is measured off a style-free wrapper div, not documentElement: an
// artifact that sets `html,body{height:100%}` makes documentElement.scrollHeight
// report the iframe viewport (a stuck/feedback value). Full HTML documents are
// not auto-sized at all: page templates often use 100vh/min-h-screen, and tying
// the iframe height to that content creates a feedback loop. They render inside
// a stable browser-like viewport instead.
const RESIZE_SHIM =
  '<script>(function(){' +
  "var r=document.getElementById('__piano_root');" +
  'function p(){' +
  'parent.postMessage({__pianoArtifact:1,h:Math.ceil(r.scrollHeight)},"*")}' +
  'new ResizeObserver(p).observe(r);' +
  'addEventListener("load",p);p()})()</script>'

const buildDoc = (html: string, autoResize: boolean) =>
  '<!doctype html><html><head><meta charset="utf-8">' +
  `<meta http-equiv="Content-Security-Policy" content="${CSP}">` +
  // Defaults live on <body> so a full-document artifact fully overrides them —
  // its own `body { background / padding / font }` wins by source order (its
  // <style> comes after ours). The wrapper paints nothing, but it MUST be a
  // block-formatting context (`display:flow-root`): otherwise a child's outer
  // vertical margins (e.g. a landing page's `.hero{margin:8rem auto}`) collapse
  // *through* the plain div, so its scrollHeight under-reports by those margins
  // and the frame ends up too short — which makes the iframe show its own
  // scrollbar. flow-root contains the margins so the measured height is the
  // true content height.
  '<style>html{margin:0}#__piano_root{display:flow-root}body{margin:0;padding:0;background:#fff;color:#0f172a;' +
  "font-family:system-ui,-apple-system,sans-serif;word-break:break-word}</style>" +
  `</head><body><div id="__piano_root">${html}</div>${autoResize ? RESIZE_SHIM : ''}</body></html>`

const MIN_HEIGHT = 40
const DOCUMENT_HEIGHT = 720
// Long fragments can still be inspected via the iframe's own scroll instead of
// letting one artifact stretch the editor/canvas without bound.
const MAX_AUTO_HEIGHT = 4_000

export function HtmlArtifact({ html, className }: { html: string; className?: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const autoResize = !isFullHtmlDocument(html)
  const [height, setHeight] = useState(() => autoResize ? MIN_HEIGHT : DOCUMENT_HEIGHT)
  const srcDoc = useMemo(() => buildDoc(html, autoResize), [autoResize, html])

  useEffect(() => {
    setHeight(autoResize ? MIN_HEIGHT : DOCUMENT_HEIGHT)
  }, [autoResize, srcDoc])

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!autoResize) return
      if (e.source !== frameRef.current?.contentWindow) return
      const data = e.data
      if (!data || data.__pianoArtifact !== 1 || typeof data.h !== 'number') return
      setHeight(Math.max(MIN_HEIGHT, Math.min(MAX_AUTO_HEIGHT, Math.ceil(data.h))))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [autoResize])

  return (
    <iframe
      ref={frameRef}
      title="HTML artifact"
      srcDoc={srcDoc}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className={className}
      style={{ width: '100%', height, border: 'none', display: 'block', background: '#fff' }}
    />
  )
}
