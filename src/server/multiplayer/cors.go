package main

import (
	"net/http"
	"os"
	"strings"
)

// withCORS wraps the multiplayer HTTP handler so browser clients on another origin
// (e.g. Vite on :3000, static on GitHub Pages) can call join / PATCH / EventSource.
// Set MULTIPLAYER_CORS_ALLOW_ORIGIN to a single origin (e.g. https://mygame.pages.dev)
// or leave unset to echo the request Origin when present, else "*".
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		allow := strings.TrimSpace(os.Getenv("MULTIPLAYER_CORS_ALLOW_ORIGIN"))
		if allow == "" {
			if o := r.Header.Get("Origin"); o != "" {
				allow = o
			} else {
				allow = "*"
			}
		}
		w.Header().Set("Access-Control-Allow-Origin", allow)
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Client-ID, X-Session-ID")
		w.Header().Set("Access-Control-Max-Age", "86400")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
