'use client'

import React, { memo, useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  ChevronRight,
  Eye,
  EyeOff,
  Folder,
  File as FileIcon,
  FileSymlink,
  Search,
  X,
  Download,
  PlusSquare,
  RefreshCw,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { match } from 'venum'
import { Files } from '@piano/shared'
import { cn } from '@/lib/utils'
import { CanvasDragPayload } from '@/domain/canvas/drag/payloads'
import { Button } from '@/components/ui/button'
import { FileService } from '../services'
import { createFileNodeFromMachine } from '../lib/createFileNode'
import { ImagePreviewDialog } from './ImagePreviewDialog'
import { toast } from 'sonner'

// FilesPanel is a non-modal column-view file browser. It's a pure component
// that takes a machineId + frozen flag — the parent decides when to mount it
// (currently inside MachineEditPanel as a right-side overlay over the
// terminal area).
//
// AK-47 substrate: one `find -maxdepth 1` per `cd`, no recursive index, no
// virtualization — column view stays cheap. Messi extras: TanStack cache per
// (machineId, path) so backwalks are instant; HTML5 drag → canvas drop creates
// a USER node from the file content (the magic kase #4).

const PREVIEW_MAX_BYTES = 1024 * 1024 // 1 MiB; matches backend default
const TEXT_PREVIEW_INLINE = 256 * 1024 // 256 KiB rendered; bigger gets a hint
const DRAWER_WIDTH = 380

type FilesPanelProps = {
  machineId: string
  isFrozen?: boolean
  onClose?: () => void
  // When provided, the parent owns the current path and is notified of
  // changes — used by MachineBody to persist drawer state into the
  // window's saved layout. Without it, the panel keeps its own internal
  // path state (stand-alone use).
  initialPath?: string
  onPathChange?: (p: string) => void
}

const FilesPanelComponent = ({
  machineId,
  isFrozen = false,
  onClose,
  initialPath,
  onPathChange,
}: FilesPanelProps) => {

  // Path navigation. Empty `path` makes the daemon resolve to $HOME and
  // return the absolute path back — that becomes our `home` anchor.
  const [path, setPathLocal] = useState<string>(initialPath ?? '')
  const [home, setHome] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [search, setSearch] = useState('')
  const [selectedFile, setSelectedFile] = useState<Files.Entry | null>(null)

  const setPath = useCallback(
    (p: string) => {
      setPathLocal(p)
      onPathChange?.(p)
    },
    [onPathChange],
  )

  // Reset state when the machine changes; remount via key is the stronger
  // guarantee but this also catches an unselect→reselect of the same machine.
  useEffect(() => {
    setPathLocal(initialPath ?? '')
    setHome(null)
    setSelectedFile(null)
    setSearch('')
    // initialPath intentionally not in deps — only re-init on machine swap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineId])

  const listQuery = useQuery({
    queryKey: ['files-list', machineId, path],
    enabled: !isFrozen,
    queryFn: async () => {
      const result = await FileService.list(machineId, path)
      if ('error' in result) throw new Error(result.error.message)
      return result.success
    },
    staleTime: 10_000,
  })

  // Capture $HOME the first time we land on it (path="" → daemon expands).
  useEffect(() => {
    if (listQuery.data && home === null && path === '') {
      setHome(listQuery.data.path)
    }
  }, [listQuery.data, home, path])

  const visibleEntries = useMemo(() => {
    const all = listQuery.data?.entries || []
    return Files.filterByQuery(
      Files.filterHidden(Files.sortEntries(all), showHidden),
      search,
    )
  }, [listQuery.data, showHidden, search])

  const currentAbs = listQuery.data?.path || path || (home ?? '~')
  const breadcrumbs = useMemo(
    () => Files.breadcrumbSegments(currentAbs, home),
    [currentAbs, home],
  )

  const goTo = useCallback((p: string) => {
    setSelectedFile(null)
    setPath(p)
  }, [setPath])

  const goUp = useCallback(() => {
    if (!listQuery.data) return
    goTo(Files.parentPath(listQuery.data.path))
  }, [listQuery.data, goTo])

  const onEntryClick = useCallback(
    (entry: Files.Entry) => {
      if (entry.kind === 'dir') {
        goTo(entry.path)
        return
      }
      setSelectedFile(entry)
    },
    [goTo],
  )

  return (
    <aside
      className="absolute right-0 top-0 z-30 flex h-full flex-col border-l border-stone-200 bg-white shadow-lg"
      style={{ width: DRAWER_WIDTH }}
    >
      <Header
        machineId={machineId}
        onClose={onClose ?? (() => undefined)}
        onRefresh={() => listQuery.refetch()}
        isFetching={listQuery.isFetching}
      />

      {isFrozen ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-stone-500">
          Files are unavailable while the machine is frozen or stopped.
        </div>
      ) : (
        <>
          <Breadcrumb segments={breadcrumbs} onGo={goTo} />
          <Toolbar
            search={search}
            setSearch={setSearch}
            showHidden={showHidden}
            setShowHidden={setShowHidden}
            canUp={!!listQuery.data && listQuery.data.path !== '/'}
            onUp={goUp}
          />
          <ListBody
            entries={visibleEntries}
            isLoading={listQuery.isLoading}
            error={listQuery.error as Error | null}
            machineId={machineId}
            onEntryClick={onEntryClick}
          />
        </>
      )}

      {selectedFile ? (
        <FilePreview
          machineId={machineId}
          entry={selectedFile}
          onClose={() => setSelectedFile(null)}
        />
      ) : null}
    </aside>
  )
}

const Header = memo(function Header({
  machineId,
  onClose,
  onRefresh,
  isFetching,
}: {
  machineId: string
  onClose: () => void
  onRefresh: () => void
  isFetching: boolean
}) {
  return (
    <div className="flex items-center justify-between border-b border-stone-200 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <Folder className="h-4 w-4 flex-shrink-0 text-stone-500" />
        <span className="truncate text-sm font-medium text-stone-800">Files</span>
        <span className="truncate font-mono text-[10px] text-stone-400">
          {machineId.slice(0, 8)}
        </span>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onRefresh}
          className={cn(
            'rounded p-1 text-stone-500 hover:bg-stone-100 hover:text-stone-800',
            isFetching && 'animate-spin',
          )}
          title="Refresh"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-stone-500 hover:bg-stone-100 hover:text-stone-800"
          title="Hide"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
})

const Breadcrumb = memo(function Breadcrumb({
  segments,
  onGo,
}: {
  segments: { label: string; path: string }[]
  onGo: (p: string) => void
}) {
  return (
    <div className="flex items-center gap-0.5 overflow-x-auto border-b border-stone-100 px-3 py-1.5 text-xs text-stone-600">
      {segments.map((seg, i) => (
        <React.Fragment key={seg.path + i}>
          {i > 0 && <ChevronRight className="h-3 w-3 flex-shrink-0 text-stone-400" />}
          <button
            type="button"
            onClick={() => onGo(seg.path)}
            className={cn(
              'rounded px-1.5 py-0.5 hover:bg-stone-100',
              i === segments.length - 1 && 'font-medium text-stone-900',
            )}
          >
            {seg.label}
          </button>
        </React.Fragment>
      ))}
    </div>
  )
})

const Toolbar = memo(function Toolbar({
  search,
  setSearch,
  showHidden,
  setShowHidden,
  canUp,
  onUp,
}: {
  search: string
  setSearch: (s: string) => void
  showHidden: boolean
  setShowHidden: (v: boolean) => void
  canUp: boolean
  onUp: () => void
}) {
  return (
    <div className="flex items-center gap-2 border-b border-stone-100 px-3 py-2">
      <button
        type="button"
        onClick={onUp}
        disabled={!canUp}
        className="rounded p-1 text-stone-500 hover:bg-stone-100 hover:text-stone-800 disabled:cursor-not-allowed disabled:opacity-30"
        title="Up"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
      </button>
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-stone-400" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Filter…"
          className="w-full rounded border border-stone-200 bg-white py-1 pl-7 pr-2 text-xs outline-none placeholder:text-stone-400 focus:border-stone-400"
        />
      </div>
      <button
        type="button"
        onClick={() => setShowHidden(!showHidden)}
        className={cn(
          'rounded p-1 transition-colors',
          showHidden
            ? 'bg-stone-200 text-stone-800'
            : 'text-stone-400 hover:bg-stone-100 hover:text-stone-700',
        )}
        title={showHidden ? 'Hide dotfiles' : 'Show dotfiles'}
      >
        {showHidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
      </button>
    </div>
  )
})

const ListBody = memo(function ListBody({
  entries,
  isLoading,
  error,
  machineId,
  onEntryClick,
}: {
  entries: Files.Entry[]
  isLoading: boolean
  error: Error | null
  machineId: string
  onEntryClick: (e: Files.Entry) => void
}) {
  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-stone-400">
        Loading…
      </div>
    )
  }
  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-red-600">
        {error.message}
      </div>
    )
  }
  if (entries.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-stone-400">
        Empty
      </div>
    )
  }
  return (
    <ul className="flex-1 overflow-y-auto py-1 text-xs">
      {entries.map(entry => (
        <FileRow
          key={entry.path}
          entry={entry}
          machineId={machineId}
          onClick={onEntryClick}
        />
      ))}
    </ul>
  )
})

const FileRow = memo(function FileRow({
  entry,
  machineId,
  onClick,
}: {
  entry: Files.Entry
  machineId: string
  onClick: (e: Files.Entry) => void
}) {
  const isDir = entry.kind === 'dir'
  const Icon = isDir ? Folder : entry.kind === 'symlink' ? FileSymlink : FileIcon
  const draggable = entry.kind === 'file'

  // Drag payload carries the machine + path; the canvas drop handler reads
  // these and fetches the content before turning it into a TEXT node. We
  // intentionally fetch on drop, not on dragstart — most drags don't land.
  const onDragStart = useCallback(
    (e: React.DragEvent<HTMLLIElement>) => {
      CanvasDragPayload.serialize(
        e.dataTransfer,
        {
          kind: 'file',
          machineId,
          path: entry.path,
          name: entry.name,
          sizeB: entry.sizeB,
        },
        'copy',
      )
      // text/plain mirror lets the user drop the path into any text input.
      e.dataTransfer.setData('text/plain', entry.path)
    },
    [machineId, entry],
  )

  return (
    <li
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
      onClick={() => onClick(entry)}
      className={cn(
        'flex cursor-pointer items-center gap-2 rounded px-3 py-1.5 hover:bg-stone-100',
        entry.isHidden && 'opacity-60',
      )}
      title={entry.path}
    >
      <Icon
        className={cn(
          'h-3.5 w-3.5 flex-shrink-0',
          isDir ? 'text-amber-500' : 'text-stone-500',
        )}
      />
      <span className="flex-1 truncate font-mono text-[12px] text-stone-800">
        {entry.name}
      </span>
      {!isDir ? (
        <span className="flex-shrink-0 font-mono text-[10px] text-stone-400">
          {Files.formatSize(entry.sizeB)}
        </span>
      ) : null}
    </li>
  )
})

const FilePreview = memo(function FilePreview({
  machineId,
  entry,
  onClose,
}: {
  machineId: string
  entry: Files.Entry
  onClose: () => void
}) {
  // Read budget depends on what we expect. Image extensions get the full
  // image-inline limit so a 3 MiB JPEG renders without a re-fetch; everything
  // else gets the smaller text-preview budget. Files above their own budget
  // skip the preview fetch entirely — daemon would just return kind=binary
  // metadata anyway, and a 5 MiB round trip for "Binary file" is wasteful.
  const isImageByExt = Files.isImageName(entry.name)
  const previewBudget = isImageByExt ? Files.IMAGE_INLINE_LIMIT_BYTES : PREVIEW_MAX_BYTES
  const skipPreviewFetch = entry.sizeB > previewBudget

  const [showImageDialog, setShowImageDialog] = useState(false)

  const readQuery = useQuery({
    queryKey: ['file-read', machineId, entry.path, entry.sizeB, entry.mtimeMs, previewBudget],
    enabled: !skipPreviewFetch,
    queryFn: async () => {
      const result = await FileService.read(machineId, entry.path, previewBudget)
      if ('error' in result) throw new Error(result.error.message)
      return result.success
    },
    staleTime: 30_000,
  })

  const data = readQuery.data
  const isText = data?.kind === 'text'

  // For image previews we decode base64 → Blob → object URL ONCE per fetch.
  // The previous version inlined `data:${mime};base64,${dataBase64}` directly
  // into `<img src>`, which works for rendering but breaks any UA action that
  // navigates to the URL (right-click → "Open image in new tab") — Chrome
  // tries to load a megabytes-long data: URL into the address bar and hangs.
  // A blob: URL is a short opaque handle that the browser treats as a normal
  // resource: navigation, download, copy-link all work normally.
  const imageSrc = useMemo(() => {
    if (!data || data.kind !== 'image') return null
    const bytes = Uint8Array.from(atob(data.dataBase64), c => c.charCodeAt(0))
    const blob = new Blob([bytes as BlobPart], { type: data.mime })
    return URL.createObjectURL(blob)
  }, [data])

  // Revoke the blob URL when it changes or the preview unmounts — otherwise
  // every fetch would leak its bytes (the Blob is reachable via the URL).
  useEffect(() => {
    if (!imageSrc) return
    return () => URL.revokeObjectURL(imageSrc)
  }, [imageSrc])

  const onCreateAsNode = useCallback(async () => {
    match(
      await createFileNodeFromMachine({
        machineId,
        path: entry.path,
        name: entry.name,
        sizeB: entry.sizeB,
        position: null,
      }),
      {
        ok: ({ name }) => toast.success(`Created note from ${name}`),
        binary: () => toast.error('Cannot create node from non-text file'),
        tooLarge: ({ sizeB }) =>
          toast.error(`File is too large (${Files.formatSize(sizeB)}) — download instead`),
        error: ({ message }) => toast.error(message),
        cancelled: () => undefined,
      },
    )
  }, [machineId, entry])

  const onDownload = useCallback(async () => {
    const result = await FileService.read(machineId, entry.path, 8 * 1024 * 1024)
    if ('error' in result) {
      toast.error(result.error.message)
      return
    }
    const d = result.success
    // Discriminated union: text bodies arrive as a UTF-8 string,
    // image/binary as base64. Either way we end up with a Uint8Array → Blob.
    let bytes: Uint8Array
    if (d.kind === 'text') {
      bytes = new TextEncoder().encode(d.content)
    } else if (d.dataBase64) {
      bytes = Uint8Array.from(atob(d.dataBase64), c => c.charCodeAt(0))
    } else {
      toast.error('No data available to download (file may be too large).')
      return
    }
    const blob = new Blob([bytes as BlobPart], { type: d.mime || 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = entry.name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, [machineId, entry])

  let previewBody: React.ReactNode
  if (skipPreviewFetch) {
    previewBody = (
      <div className="flex h-32 items-center justify-center px-4 text-center text-xs text-stone-500">
        File is too large to preview inline ({Files.formatSize(entry.sizeB)}). Download instead.
      </div>
    )
  } else if (readQuery.isLoading) {
    previewBody = (
      <div className="flex h-32 items-center justify-center text-xs text-stone-400">
        Loading…
      </div>
    )
  } else if (readQuery.error) {
    previewBody = (
      <div className="flex h-32 items-center justify-center px-4 text-center text-xs text-red-600">
        {(readQuery.error as Error).message}
      </div>
    )
  } else if (!data) {
    previewBody = null
  } else if (data.kind === 'image' && imageSrc) {
    // Inline thumbnail; click expands to ImagePreviewDialog at 90vw × 90vh.
    // Both share the same blob: URL — one decode per fetch, dialog opens
    // instantly, and right-click → "Open image in new tab" works because
    // blob: URLs are short opaque handles (unlike megabyte-long data: URLs).
    previewBody = (
      <button
        type="button"
        onClick={() => setShowImageDialog(true)}
        className="flex max-h-64 items-center justify-center bg-stone-50 px-3 py-2 transition-colors hover:bg-stone-100"
        title="Click to open at full size"
      >
        <img
          src={imageSrc}
          alt={entry.name}
          className="max-h-60 max-w-full object-contain"
          draggable={false}
        />
      </button>
    )
  } else if (data.kind === 'text') {
    previewBody = (
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words bg-stone-50 px-3 py-2 font-mono text-[11px] leading-snug text-stone-800">
        {data.content.slice(0, TEXT_PREVIEW_INLINE)}
        {data.truncated ? '\n\n…(truncated)' : null}
      </pre>
    )
  } else {
    // kind === 'binary' (or image with imageSrc not yet ready — same UX).
    previewBody = (
      <div className="flex h-32 items-center justify-center px-4 text-center text-xs text-stone-500">
        Binary file ({data.mime || 'unknown'}). Download to inspect.
      </div>
    )
  }

  return (
    <div className="flex flex-shrink-0 flex-col border-t border-stone-200 bg-white">
      <div className="flex items-center justify-between border-b border-stone-100 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <FileIcon className="h-3.5 w-3.5 flex-shrink-0 text-stone-500" />
          <span className="truncate font-mono text-xs text-stone-800">{entry.name}</span>
          <span className="flex-shrink-0 font-mono text-[10px] text-stone-400">
            {Files.formatSize(entry.sizeB)}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-stone-500 hover:bg-stone-100 hover:text-stone-800"
          title="Close preview"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {previewBody}
      <div className="flex items-center gap-2 border-t border-stone-100 px-3 py-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onCreateAsNode}
          className="h-7 gap-1.5 text-xs"
          // Only text becomes a node; images/binaries can be downloaded but
          // wouldn't render meaningfully inside a USER note.
          disabled={!isText}
        >
          <PlusSquare className="h-3 w-3" />
          Create as node
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onDownload}
          className="h-7 gap-1.5 text-xs"
        >
          <Download className="h-3 w-3" />
          Download
        </Button>
      </div>
      {data?.kind === 'image' && imageSrc ? (
        <ImagePreviewDialog
          open={showImageDialog}
          onOpenChange={setShowImageDialog}
          src={imageSrc}
          alt={entry.name}
        />
      ) : null}
    </div>
  )
})

export const FilesPanel = memo(FilesPanelComponent)
