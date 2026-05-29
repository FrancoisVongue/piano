package main

import (
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/hinshun/vt10x"
)

const (
	ringSize       = 10 * 1024 * 1024 // 10MB ring buffer for raw replay
	maxLogSize     = 10 * 1024 * 1024 // 10MB file log, rotate when exceeded
	truncateToSize = 5 * 1024 * 1024  // keep last 5MB after rotation
)

// RingBuffer is a fixed-size circular buffer that keeps the last N bytes.
type RingBuffer struct {
	buf  []byte
	pos  int  // next write position
	full bool // true once the buffer has wrapped around
}

func NewRingBuffer(size int) *RingBuffer {
	return &RingBuffer{buf: make([]byte, size)}
}

func (r *RingBuffer) Write(data []byte) {
	for _, b := range data {
		r.buf[r.pos] = b
		r.pos++
		if r.pos >= len(r.buf) {
			r.pos = 0
			r.full = true
		}
	}
}

// Bytes returns all buffered data in order (oldest to newest).
func (r *RingBuffer) Bytes() []byte {
	if !r.full {
		return r.buf[:r.pos]
	}
	// Wrap: data from pos..end + 0..pos
	out := make([]byte, len(r.buf))
	n := copy(out, r.buf[r.pos:])
	copy(out[n:], r.buf[:r.pos])
	return out
}

// OutputLog captures PTY output three ways:
//   - Ring buffer (in-memory, raw bytes) — for seamless replay on reconnect
//   - File log (on disk) — for persistence across daemon restarts
//   - VT parser (virtual terminal) — for clean text extraction (AI context)
type OutputLog struct {
	mu   sync.Mutex
	ring *RingBuffer    // raw bytes for replay
	file *os.File       // persistent log
	path string
	size int64
	vt   vt10x.Terminal // virtual terminal for AI context
}

func OpenOutputLog(machineId string) (*OutputLog, error) {
	path := filepath.Join(layersDir, machineId, "output.log")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return nil, err
	}

	info, _ := f.Stat()
	size := int64(0)
	if info != nil {
		size = info.Size()
	}

	ol := &OutputLog{
		ring: NewRingBuffer(ringSize),
		file: f,
		path: path,
		size: size,
		vt:   vt10x.New(vt10x.WithSize(120, 50)),
	}

	// Seed ring buffer and VT parser from existing file log (recovery after restart).
	if size > 0 {
		if existing, err := os.ReadFile(path); err == nil && len(existing) > 0 {
			ol.ring.Write(existing)
			ol.vt.Write(existing)
		}
	}

	return ol, nil
}

// Write stores data in all three destinations.
func (ol *OutputLog) Write(data []byte) {
	ol.mu.Lock()
	defer ol.mu.Unlock()

	// Ring buffer: store raw bytes as-is for replay.
	ol.ring.Write(data)

	// File log: write to disk for persistence.
	n, err := ol.file.Write(data)
	if err != nil {
		log.Printf("output log write error: %v", err)
	} else {
		ol.size += int64(n)
		if ol.size > maxLogSize {
			ol.rotate()
		}
	}

	// VT parser: feed for screen state tracking.
	ol.vt.Write(data)
}

// ReplayBytes returns the raw ring buffer contents for seamless reconnect.
// xterm.js processes these bytes and reconstructs the exact terminal state.
func (ol *OutputLog) ReplayBytes() []byte {
	ol.mu.Lock()
	defer ol.mu.Unlock()
	return ol.ring.Bytes()
}

// ScreenContent returns clean text from the VT parser (for AI context).
// No escape sequences, no colors — just the visible text.
func (ol *OutputLog) ScreenContent() string {
	ol.mu.Lock()
	defer ol.mu.Unlock()

	ol.vt.Lock()
	cols, rows := ol.vt.Size()
	var lines []string
	for row := 0; row < rows; row++ {
		var line strings.Builder
		for col := 0; col < cols; col++ {
			g := ol.vt.Cell(col, row)
			if g.Char == 0 {
				line.WriteByte(' ')
			} else {
				line.WriteRune(g.Char)
			}
		}
		lines = append(lines, strings.TrimRight(line.String(), " "))
	}
	ol.vt.Unlock()

	for len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return strings.Join(lines, "\n")
}

// ReadCleanTail returns terminal content for AI context.
func (ol *OutputLog) ReadCleanTail(n int) string {
	content := ol.ScreenContent()
	if len(content) > n {
		content = content[len(content)-n:]
	}
	return content
}

// ReadTail returns the last n bytes from the file log (for recovery after restart).
func (ol *OutputLog) ReadTail(n int) []byte {
	ol.mu.Lock()
	defer ol.mu.Unlock()

	f, err := os.Open(ol.path)
	if err != nil {
		return nil
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil || info.Size() == 0 {
		return nil
	}

	readSize := int64(n)
	if info.Size() < readSize {
		readSize = info.Size()
	}

	buf := make([]byte, readSize)
	_, err = f.ReadAt(buf, info.Size()-readSize)
	if err != nil && err != io.EOF {
		return nil
	}
	return buf
}

func (ol *OutputLog) Close() {
	ol.mu.Lock()
	defer ol.mu.Unlock()
	ol.file.Close()
}

func (ol *OutputLog) rotate() {
	ol.file.Close()

	data, err := os.ReadFile(ol.path)
	if err != nil {
		log.Printf("output log rotate read error: %v", err)
		return
	}
	if int64(len(data)) > truncateToSize {
		data = data[int64(len(data))-truncateToSize:]
	}
	if err := os.WriteFile(ol.path, data, 0644); err != nil {
		log.Printf("output log rotate write error: %v", err)
	}

	f, err := os.OpenFile(ol.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		log.Printf("output log rotate reopen error: %v", err)
		return
	}
	ol.file = f
	ol.size = int64(len(data))
}

// ANSI stripping for fallback use.
var ansiRegex = regexp.MustCompile(`\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-B]|\x1b\[[\?]?[0-9;]*[hlm]`)

func StripANSI(raw []byte) []byte {
	return ansiRegex.ReplaceAll(raw, nil)
}
