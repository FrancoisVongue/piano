package main

import (
	"context"
	"io"
	stdlog "log"
	"log/slog"
	"os"
	"regexp"
	"strings"
)

// -----------------------------------------------------------------------------
// observability.go — single entry point for daemon logging.
//
// Two jobs:
//   1. Emit structured JSON logs in a Cloud-Logging-friendly format (severity
//      label, timestamp, message). One stream → stdout, picked up by GKE /
//      Cloud Run agents automatically.
//
//   2. Carry the backend's W3C trace_id through into log lines so a single
//      Cloud Trace request shows the daemon's logs alongside the backend's.
//      We don't run our own OTEL SDK — we just propagate the trace_id we
//      received via the ControlMessage envelope.
//
// Existing call sites that use the stdlib `log` package keep working: a thin
// io.Writer adapter parses their `[tag] message` shape and re-emits as JSON.
// New code that has access to a context.Context should call LogWith(ctx) for
// per-trace correlation.
// -----------------------------------------------------------------------------

// Logger is the canonical slog logger. Initialized in SetupLogging().
var Logger *slog.Logger

type ctxKey int

const (
	traceparentCtxKey ctxKey = iota
)

// WithTraceparent stashes a W3C traceparent string in ctx. Pass an empty
// string to leave ctx untouched (no-op).
func WithTraceparent(ctx context.Context, tp string) context.Context {
	if tp == "" {
		return ctx
	}
	return context.WithValue(ctx, traceparentCtxKey, tp)
}

// TraceparentFromContext returns the traceparent stored on ctx, or "".
func TraceparentFromContext(ctx context.Context) string {
	tp, _ := ctx.Value(traceparentCtxKey).(string)
	return tp
}

// LogWith returns a slog.Logger pre-bound to the trace context on ctx.
// Cloud Logging recognizes the `logging.googleapis.com/trace` field and
// shows the log line on the corresponding trace timeline.
func LogWith(ctx context.Context) *slog.Logger {
	tp := TraceparentFromContext(ctx)
	if tp == "" {
		return Logger
	}
	traceID, spanID, sampled, ok := parseTraceparent(tp)
	if !ok {
		return Logger
	}
	project := os.Getenv("GOOGLE_CLOUD_PROJECT")
	traceField := traceID
	if project != "" {
		traceField = "projects/" + project + "/traces/" + traceID
	}
	return Logger.With(
		slog.String("logging.googleapis.com/trace", traceField),
		slog.String("logging.googleapis.com/spanId", spanID),
		slog.Bool("logging.googleapis.com/trace_sampled", sampled),
	)
}

// parseTraceparent: `00-<32-hex>-<16-hex>-<2-hex>`
func parseTraceparent(tp string) (traceID, spanID string, sampled, ok bool) {
	parts := strings.Split(tp, "-")
	if len(parts) != 4 || len(parts[1]) != 32 || len(parts[2]) != 16 {
		return "", "", false, false
	}
	return parts[1], parts[2], parts[3] == "01", true
}

// SetupLogging installs the JSON slog handler and redirects the stdlib `log`
// package through it so legacy `log.Printf("[tag] ...")` calls produce
// structured output without code churn.
func SetupLogging(serviceName string) {
	level := slog.LevelInfo
	if v := os.Getenv("LOG_LEVEL"); v != "" {
		switch strings.ToLower(v) {
		case "debug":
			level = slog.LevelDebug
		case "warn":
			level = slog.LevelWarn
		case "error":
			level = slog.LevelError
		}
	}

	handlerOpts := &slog.HandlerOptions{Level: level}
	if os.Getenv("GOOGLE_CLOUD_PROJECT") != "" {
		handlerOpts.ReplaceAttr = gcpReplaceAttr
	}
	handler := slog.NewJSONHandler(os.Stdout, handlerOpts)
	Logger = slog.New(handler).With(slog.String("service", serviceName))
	slog.SetDefault(Logger)

	stdlog.SetFlags(0)
	stdlog.SetOutput(&stdlogBridge{logger: Logger})
}

// gcpReplaceAttr renames slog's default keys to what Cloud Logging expects:
// level → severity (with INFO/WARNING/ERROR strings), msg → message,
// time → timestamp.
func gcpReplaceAttr(_ []string, a slog.Attr) slog.Attr {
	switch a.Key {
	case slog.LevelKey:
		lvl, _ := a.Value.Any().(slog.Level)
		return slog.String("severity", gcpSeverity(lvl))
	case slog.MessageKey:
		return slog.Attr{Key: "message", Value: a.Value}
	case slog.TimeKey:
		return slog.Attr{Key: "timestamp", Value: a.Value}
	}
	return a
}

func gcpSeverity(level slog.Level) string {
	switch {
	case level >= slog.LevelError:
		return "ERROR"
	case level >= slog.LevelWarn:
		return "WARNING"
	case level >= slog.LevelInfo:
		return "INFO"
	default:
		return "DEBUG"
	}
}

// stdlogBridge is the io.Writer we hand to the stdlib `log` package. It pulls
// out a leading `[tag]` (the daemon's existing convention) and uses it as a
// `domain` field, so legacy log lines come out as nicely structured JSON
// without rewriting every call site.
type stdlogBridge struct {
	logger *slog.Logger
}

var bracketTagRe = regexp.MustCompile(`^\[([^\]]+)\]\s*`)

func (b *stdlogBridge) Write(p []byte) (int, error) {
	msg := strings.TrimRight(string(p), "\n")
	if m := bracketTagRe.FindStringSubmatch(msg); m != nil {
		b.logger.Info(msg[len(m[0]):], slog.String("domain", m[1]))
	} else {
		b.logger.Info(msg)
	}
	return len(p), nil
}

// Compile-time check.
var _ io.Writer = (*stdlogBridge)(nil)
