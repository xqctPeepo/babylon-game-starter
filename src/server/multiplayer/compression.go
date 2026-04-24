package main

import (
	"log"
	"net/http"
	"os"
	"strings"

	httpcompression "github.com/CAFxX/httpcompression"
	brotlienc "github.com/CAFxX/httpcompression/contrib/andybalholm/brotli"
)

// compressionMode returns the effective content-encoding mode from the
// MULTIPLAYER_SSE_COMPRESSION environment variable. Accepted values:
//
//	"" / "brotli"                     → Brotli (default), gzip fallback
//	"gzip"                            → gzip only
//	"off" / "none" / "disabled"       → no compression (middleware is a pass-through)
//
// The off switch exists so operators can diagnose proxy interactions without
// having to strip the middleware at the code level.
func compressionMode() string {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("MULTIPLAYER_SSE_COMPRESSION"))) {
	case "off", "none", "disabled", "false", "0":
		return "off"
	case "gzip":
		return "gzip"
	default:
		return "brotli"
	}
}

// withCompression wraps the multiplayer HTTP handler with a content-encoding
// adapter tuned for SSE streaming. Key properties (see MULTIPLAYER_SYNCH.md §9.1):
//
//   - The wrapped response writer preserves http.Flusher. datastar-go calls
//     Flush() after every MarshalAndPatchSignals; the httpcompression library
//     forwards Flush() through and emits a compression flush block, so per-event
//     cadence is preserved end-to-end.
//   - Brotli quality is pinned to 4 (streaming-friendly). The library default is
//     the reference-C default of 3; higher qualities (e.g. 11) buffer too many
//     bytes before emitting output and would batch SSE events together.
//   - Compression is restricted to text/event-stream and application/json
//     payloads, and a MinSize of 256 bytes keeps tiny PATCH ACKs uncompressed.
//   - On MULTIPLAYER_SSE_COMPRESSION=off, this function returns next unchanged,
//     so the server runs identically to a build without the middleware.
func withCompression(next http.Handler) http.Handler {
	mode := compressionMode()
	if mode == "off" {
		log.Printf("[Multiplayer Server] SSE compression disabled (MULTIPLAYER_SSE_COMPRESSION=off)")
		return next
	}

	opts := []httpcompression.Option{
		httpcompression.ContentTypes(
			[]string{"text/event-stream", "application/json"},
			false, // allow-list (blacklist=false); only listed types compress
		),
		httpcompression.MinSize(256),
	}

	switch mode {
	case "gzip":
		opts = append(opts, httpcompression.GzipCompressionLevel(4))
		log.Printf("[Multiplayer Server] SSE compression: gzip (level 4)")

	default: // "brotli"
		// Pluggable Brotli: quality 4 + LGWin 18 (256 KiB window) gives a
		// good ratio at low latency. Default Quality is 3; default LGWin is
		// 22 (4 MiB), which is larger than we need for per-event SSE flushes.
		brEnc, brErr := brotlienc.New(brotlienc.Options{
			Quality: 4,
			LGWin:   18,
		})
		if brErr != nil {
			log.Printf("[Multiplayer Server] SSE compression: brotli init failed (%v); falling back to default level", brErr)
			opts = append(opts, httpcompression.BrotliCompressionLevel(brotlienc.DefaultCompression))
		} else {
			opts = append(opts, httpcompression.BrotliCompressor(brEnc))
		}
		// Secondary gzip encoder for clients that don't advertise "br"
		// (e.g. some legacy proxies). Brotli has higher priority by default
		// in httpcompression, so clients with both still get Brotli.
		opts = append(opts, httpcompression.GzipCompressionLevel(4))
		log.Printf("[Multiplayer Server] SSE compression: brotli (quality 4, LGWin 18) + gzip fallback")
	}

	adapter, err := httpcompression.Adapter(opts...)
	if err != nil {
		// Fail-open: if the adapter cannot be constructed we serve uncompressed
		// rather than refusing to accept any traffic at all.
		log.Printf("[Multiplayer Server] SSE compression: adapter build failed (%v); serving uncompressed", err)
		return next
	}
	return adapter(next)
}
