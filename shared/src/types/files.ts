import { z } from 'zod'

// `Files` is the file-browser namespace shared between backend and daemon
// (over WebSocket) and frontend (over REST). The daemon does the heavy
// lifting; types here are the wire shape both ends agree on.
export namespace Files {
  export type Kind = 'dir' | 'file' | 'symlink' | 'other'

  // One row in a directory listing.
  export type Entry = {
    name: string
    path: string
    kind: Kind
    sizeB: number
    mtimeMs: number
    isHidden: boolean
  }

  // Result of a directory list.
  export type ListResult = {
    path: string
    entries: Entry[]
  }

  // Result of a file read. Discriminated by `kind`:
  //   - 'text'   → `content` holds the UTF-8 string (text bodies always go
  //                across the wire as a string, not base64);
  //   - 'image'  → `dataBase64` holds the full image (size <= IMAGE_INLINE_LIMIT_BYTES);
  //                rendered inline as `data:${mime};base64,…`;
  //   - 'binary' → `dataBase64` holds up to maxBytes for download; preview UI
  //                shows metadata only.
  // Why a discriminated union: forces every UI branch to handle all three
  // kinds explicitly, no `if (isBinary && contentB64) …` ambiguity.
  export type ReadResult =
    | {
        kind: 'text'
        path: string
        sizeBytes: number
        truncated: boolean
        mime: string
        content: string
      }
    | {
        kind: 'image'
        path: string
        sizeBytes: number
        truncated: false
        mime: string
        dataBase64: string
      }
    | {
        kind: 'binary'
        path: string
        sizeBytes: number
        truncated: boolean
        mime: string
        dataBase64?: string
      }

  // Hard cap on inline image previews. Files above this are returned as
  // kind='binary' (downloadable, not displayed). The daemon enforces the
  // same constant; bump both if you bump one.
  export const IMAGE_INLINE_LIMIT_BYTES = 5 * 1024 * 1024

  // Image extensions the file browser recognises ahead of time so it can
  // request a larger maxBytes for image previews (text previews are smaller
  // by default). Extension-based gating avoids reading 5 MiB of every binary
  // file just to discover it isn't an image.
  //
  // Note: `.svg` is DELIBERATELY ABSENT. SVG files can contain `<script>`
  // tags and event handlers; when wrapped in a `blob:` URL and navigated to
  // (e.g. right-click → "Open image in new tab"), the blob inherits piano's
  // origin and the SVG's scripts execute with access to the user's session.
  // SVGs come back as kind='text' instead, so the user sees XML source. The
  // daemon enforces the same exclusion — keep both in sync.
  const IMAGE_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif',
  ])

  export const isImageName = (name: string): boolean => {
    const i = name.lastIndexOf('.')
    if (i < 0) return false
    return IMAGE_EXTENSIONS.has(name.slice(i).toLowerCase())
  }

  export namespace DTO {
    export const ListQuerySchema = z.object({
      path: z.string().max(4096).default(''),
    })
    export const ReadQuerySchema = z.object({
      path: z.string().min(1).max(4096),
      maxBytes: z.coerce.number().int().positive().max(8 * 1024 * 1024).optional(),
    })
    export type ListQuery = z.infer<typeof ListQuerySchema>
    export type ReadQuery = z.infer<typeof ReadQuerySchema>
  }

  export const validate = {
    listQuery: (input: unknown): DTO.ListQuery => DTO.ListQuerySchema.parse(input),
    readQuery: (input: unknown): DTO.ReadQuery => DTO.ReadQuerySchema.parse(input),
  }

  // Sort: directories first, then case-insensitive name.
  export const sortEntries = (entries: Entry[]): Entry[] =>
    [...entries].sort((a, b) => {
      if (a.kind === 'dir' && b.kind !== 'dir') return -1
      if (a.kind !== 'dir' && b.kind === 'dir') return 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })

  // Filter helpers used by the drawer — kept on the namespace so the UI
  // layer stays declarative.
  export const filterHidden = (entries: Entry[], showHidden: boolean): Entry[] =>
    showHidden ? entries : entries.filter(e => !e.isHidden)

  export const filterByQuery = (entries: Entry[], query: string): Entry[] => {
    const q = query.trim().toLowerCase()
    if (!q) return entries
    return entries.filter(e => e.name.toLowerCase().includes(q))
  }

  // Convert an absolute path inside the machine to a `~`-prefixed path
  // when it starts with $HOME. Used for breadcrumb rendering.
  export const prettyPath = (abs: string, home: string | null): string => {
    if (home && (abs === home || abs.startsWith(home + '/'))) {
      return '~' + abs.slice(home.length)
    }
    return abs
  }

  // Split an absolute path into breadcrumb segments. Each segment carries
  // its own absolute path so clicking it navigates there directly.
  export const breadcrumbSegments = (
    abs: string,
    home: string | null,
  ): { label: string; path: string }[] => {
    const segs: { label: string; path: string }[] = []
    if (home && (abs === home || abs.startsWith(home + '/'))) {
      segs.push({ label: '~', path: home })
      const rest = abs.slice(home.length).replace(/^\/+/, '')
      if (rest) {
        const parts = rest.split('/').filter(Boolean)
        let acc = home
        for (const part of parts) {
          acc = acc + '/' + part
          segs.push({ label: part, path: acc })
        }
      }
      return segs
    }
    segs.push({ label: '/', path: '/' })
    const parts = abs.replace(/^\/+/, '').split('/').filter(Boolean)
    let acc = ''
    for (const part of parts) {
      acc = acc + '/' + part
      segs.push({ label: part, path: acc })
    }
    return segs
  }

  export const parentPath = (abs: string): string => {
    const trimmed = abs.replace(/\/+$/, '')
    const idx = trimmed.lastIndexOf('/')
    if (idx <= 0) return '/'
    return trimmed.slice(0, idx)
  }

  // Human size formatter — one place so list rows and previews agree.
  export const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  }
}
