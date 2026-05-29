package main

import (
	"encoding/base64"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"os/exec"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// imageInlineLimitBytes caps inline image previews. Files above this come
// back as kind="binary" with dataBase64 truncated to maxBytes for download.
// MUST match Files.IMAGE_INLINE_LIMIT_BYTES in shared/src/types/files.ts.
const imageInlineLimitBytes int64 = 5 * 1024 * 1024

// imageExtensions mirrors the frontend's `Files.isImageName` set. Used as a
// fast pre-check so we read up to imageInlineLimitBytes for image files
// instead of being capped at the text-preview maxBytes.
//
// Note: `.svg` is deliberately absent — SVG files can contain executable
// `<script>` content that would run in piano's origin if the user opens the
// blob: URL in a new tab. SVGs are routed to kind="text" so the UI shows
// XML source instead of rendering. See isScriptableImageMime below.
var imageExtensions = map[string]struct{}{
	".png": {}, ".jpg": {}, ".jpeg": {}, ".gif": {}, ".webp": {},
	".bmp": {}, ".ico": {}, ".avif": {},
}

// isScriptableImageMime catches MIME types that look like images but can
// execute code in document context. Right now that's only SVG; if AVIF or
// some future format adds embedded scripting we'd extend this here.
func isScriptableImageMime(m string) bool {
	return m == "image/svg+xml" || strings.HasPrefix(m, "image/svg+xml;")
}

// FsEntry is one row in a directory listing.
type FsEntry struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	Kind     string `json:"kind"` // "dir" | "file" | "symlink" | "other"
	SizeB    int64  `json:"sizeB"`
	MtimeMs  int64  `json:"mtimeMs"`
	IsHidden bool   `json:"isHidden"`
}

// FsList runs `find -maxdepth 1` inside the container at the resolved path
// and parses the printf'd output. One podman exec per call — we eat the ~30ms
// fork cost; a column-view drawer doesn't fire fast enough to care.
func FsList(machineId string, dirPath string) (string, []FsEntry, error) {
	if err := validatePath(dirPath); err != nil {
		return "", nil, err
	}
	abs := resolvePath(dirPath)

	// `%y` = file type code (f/d/l/...), `%s` = bytes, `%T@` = mtime as
	// `seconds.fraction`, `%P` = name relative to start. We tab-separate so
	// names containing spaces parse cleanly. `\0` separates rows so a
	// filename containing a literal newline can't desync the parser.
	// Note: GNU find's -printf understands `\0` for NUL but NOT `\x00`
	// (the latter prints literally as four chars and breaks the parser).
	script := fmt.Sprintf(
		`cd %s && find . -mindepth 1 -maxdepth 1 -printf '%%y\t%%s\t%%T@\t%%P\0' 2>/dev/null`,
		shellQuote(abs),
	)
	cmd := ExecCommandNonInteractive(machineId, []string{"sh", "-c", script}, abs)
	out, err := cmd.Output()
	if err != nil {
		// `find` returns nonzero if the cwd doesn't exist; surface a clean message.
		return abs, nil, fmt.Errorf("list %s: %w", abs, err)
	}

	rows := strings.Split(strings.TrimRight(string(out), "\x00"), "\x00")
	entries := make([]FsEntry, 0, len(rows))
	for _, row := range rows {
		if row == "" {
			continue
		}
		fields := strings.SplitN(row, "\t", 4)
		if len(fields) != 4 {
			continue
		}
		name := fields[3]
		size, _ := strconv.ParseInt(fields[1], 10, 64)
		mtime := parseFindMtime(fields[2])
		entries = append(entries, FsEntry{
			Name:     name,
			Path:     path.Join(abs, name),
			Kind:     kindFromFindCode(fields[0]),
			SizeB:    size,
			MtimeMs:  mtime,
			IsHidden: strings.HasPrefix(name, "."),
		})
	}
	return abs, entries, nil
}

// FsRead reads a file inside the container and classifies it as text, image,
// or binary so the UI can render appropriately. The classification is the
// product of two signals: extension (cheap, decides the read budget — images
// get up to imageInlineLimitBytes, others get maxBytes) and a magic-number
// sniff on the actual bytes (catches images with wrong/no extension and
// rejects binary masquerading as text via the looksBinary heuristic).
func FsRead(machineId string, filePath string, maxBytes int64) (FsReadResult, error) {
	if err := validatePath(filePath); err != nil {
		return FsReadResult{}, err
	}
	if maxBytes <= 0 {
		maxBytes = 1024 * 1024 // 1 MiB cap by default
	}
	abs := resolvePath(filePath)

	// Stat first — read+detect-binary needs the size; also lets us reject
	// directories with a clean error instead of `cat: Is a directory`.
	statScript := fmt.Sprintf(`stat -c '%%s %%F' %s 2>/dev/null`, shellQuote(abs))
	statOut, err := ExecCommandNonInteractive(machineId, []string{"sh", "-c", statScript}, "/").Output()
	if err != nil {
		return FsReadResult{}, fmt.Errorf("stat %s: %w", abs, err)
	}
	statFields := strings.SplitN(strings.TrimSpace(string(statOut)), " ", 2)
	if len(statFields) < 2 {
		return FsReadResult{}, errors.New("file not found")
	}
	totalSize, _ := strconv.ParseInt(statFields[0], 10, 64)
	fileType := statFields[1] // "regular file", "directory", "symbolic link", ...
	if strings.Contains(fileType, "directory") {
		return FsReadResult{}, errors.New("path is a directory")
	}

	// Extension-based pre-classification: known image extension → bump the
	// read budget to imageInlineLimitBytes so the inline preview gets the
	// whole image. Otherwise stick with caller's maxBytes (1 MiB by default).
	ext := strings.ToLower(filepath.Ext(abs))
	_, looksLikeImageByExt := imageExtensions[ext]
	readBudget := maxBytes
	if looksLikeImageByExt {
		readBudget = imageInlineLimitBytes
	}
	// If the file is small enough that the budget would over-read, clamp.
	readBytes := readBudget
	if totalSize < readBytes {
		readBytes = totalSize
	}

	// Don't even bother reading huge images — they go straight to binary
	// metadata for download. Saves a 5 MiB round trip for files we can't
	// inline anyway. Non-image binaries still get a partial read so the
	// caller can offer a download up to maxBytes.
	if looksLikeImageByExt && totalSize > imageInlineLimitBytes {
		return FsReadResult{
			Kind:      "binary",
			Path:      abs,
			SizeBytes: totalSize,
			Truncated: true,
			Mime:      mimeFromExtOrDefault(ext, "application/octet-stream"),
		}, nil
	}

	readScript := fmt.Sprintf(`head -c %d %s | base64`, readBytes, shellQuote(abs))
	out, err := ExecCommandNonInteractive(machineId, []string{"sh", "-c", readScript}, "/").Output()
	if err != nil {
		return FsReadResult{}, fmt.Errorf("read %s: %w", abs, err)
	}

	// Strip whitespace from base64 output (`base64` emits 76-char lines).
	b64 := strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == ' ' || r == '\t' {
			return -1
		}
		return r
	}, string(out))
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return FsReadResult{}, fmt.Errorf("decode read: %w", err)
	}

	// MIME detection: extension first (cheap + authoritative for known
	// types), then magic-number sniff to catch wrong/missing extensions and
	// also override extension lies (".png" full of zeroes → application/octet-stream).
	detectedMime := mimeFromExtOrDefault(ext, "")
	if detectedMime == "" || detectedMime == "application/octet-stream" {
		detectedMime = strings.SplitN(http.DetectContentType(raw), ";", 2)[0]
	}
	truncated := totalSize > readBytes
	// Treat scriptable-image MIME types (just SVG today) as text so the
	// frontend renders the XML source instead of wrapping the bytes in a
	// blob: URL that, if navigated to via "open in new tab", would execute
	// the SVG's scripts in piano's origin. Routing to text means looksBinary
	// below decides — SVG is XML, so it ends up in the text branch cleanly.
	isImageMime := strings.HasPrefix(detectedMime, "image/") && !isScriptableImageMime(detectedMime)

	// Image branch: file is an image and fits inline. Return full bytes.
	if isImageMime && totalSize <= imageInlineLimitBytes {
		return FsReadResult{
			Kind:       "image",
			Path:       abs,
			SizeBytes:  totalSize,
			Truncated:  false, // image is always full-or-binary, never partial
			Mime:       detectedMime,
			DataBase64: base64.StdEncoding.EncodeToString(raw),
		}, nil
	}

	// Binary branch: image-too-large, sniff-says-binary, or
	// extension-says-binary. Bytes still returned (up to maxBytes) so the
	// Download button has something to blob.
	if isImageMime || looksBinary(raw) {
		return FsReadResult{
			Kind:       "binary",
			Path:       abs,
			SizeBytes:  totalSize,
			Truncated:  truncated,
			Mime:       detectedMime,
			DataBase64: base64.StdEncoding.EncodeToString(raw),
		}, nil
	}

	// Text branch: UTF-8 string body, the cheapest possible wire shape.
	return FsReadResult{
		Kind:      "text",
		Path:      abs,
		SizeBytes: totalSize,
		Truncated: truncated,
		Mime:      detectedMime,
		Content:   string(raw),
	}, nil
}

// mimeFromExtOrDefault wraps mime.TypeByExtension to strip the "; charset=..."
// suffix and fall back to a default when the extension is unknown.
func mimeFromExtOrDefault(ext string, fallback string) string {
	if ext == "" {
		return fallback
	}
	m := mime.TypeByExtension(ext)
	if m == "" {
		return fallback
	}
	if idx := strings.Index(m, ";"); idx >= 0 {
		return strings.TrimSpace(m[:idx])
	}
	return m
}

// FsReadResult is the daemon→backend payload for a file read. The frontend
// narrows on `Kind` to pick the renderer — see Files.ReadResult in shared/.
type FsReadResult struct {
	Kind       string `json:"kind"`                 // "text" | "image" | "binary"
	Path       string `json:"path"`
	SizeBytes  int64  `json:"sizeBytes"`
	Truncated  bool   `json:"truncated"`
	Mime       string `json:"mime"`
	Content    string `json:"content,omitempty"`    // kind=text
	DataBase64 string `json:"dataBase64,omitempty"` // kind=image | kind=binary
}

// validatePath rejects paths with control characters (NUL, tab, newline, etc.).
// They sneak in when a parser upstream loses a separator and concatenates raw
// listing rows back into a path — exactly how today's "%5Cx00 in URL" bug
// presented. Catching it here turns a confusing 502 into a clean 4xx.
func validatePath(p string) error {
	for _, r := range p {
		if r < 0x20 || r == 0x7f {
			return fmt.Errorf("path contains control characters")
		}
	}
	return nil
}

// resolvePath returns an absolute path. Empty / "~" map to the host user's $HOME.
func resolvePath(p string) string {
	_, _, _, home := hostUser()
	p = strings.TrimSpace(p)
	if p == "" || p == "~" {
		return home
	}
	if strings.HasPrefix(p, "~/") {
		return path.Join(home, p[2:])
	}
	if !strings.HasPrefix(p, "/") {
		return path.Join(home, p)
	}
	return path.Clean(p)
}

func kindFromFindCode(c string) string {
	switch c {
	case "d":
		return "dir"
	case "f":
		return "file"
	case "l":
		return "symlink"
	default:
		return "other"
	}
}

func parseFindMtime(s string) int64 {
	// `%T@` prints `seconds.nanoseconds`. Strconv on the float keeps it short.
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return time.Now().UnixMilli()
	}
	return int64(f * 1000)
}

// shellQuote single-quotes a string for safe sh -c interpolation.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// looksBinary returns true if the prefix has a null byte or a high ratio of
// non-printable bytes — same heuristic git uses to decide diff mode.
func looksBinary(b []byte) bool {
	const sniffMax = 8192
	n := len(b)
	if n > sniffMax {
		n = sniffMax
	}
	if n == 0 {
		return false
	}
	nonPrintable := 0
	for i := 0; i < n; i++ {
		c := b[i]
		if c == 0 {
			return true
		}
		if c < 9 || (c > 13 && c < 32) {
			nonPrintable++
		}
	}
	return nonPrintable*100/n > 30
}

// Compile-time anchor so removing this file is loud rather than silent.
var _ = exec.Command
