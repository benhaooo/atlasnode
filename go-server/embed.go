package main

import (
	"embed"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

//go:embed all:webdist
var embeddedWebFS embed.FS

func newSPAHandler() http.Handler {
	// Prefer external web/dist if present next to cwd (for quick frontend swaps), else embedded!
	if info, err := os.Stat("web/dist/index.html"); err == nil && !info.IsDir() {
		return spaFromFS(os.DirFS("web/dist"))
	}
	sub, err := fs.Sub(embeddedWebFS, "webdist")
	if err != nil {
		return http.NotFoundHandler()
	}
	return spaFromFS(sub)
}

func spaFromFS(root fs.FS) http.Handler {
	fileServer := http.FileServer(http.FS(root))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(filepath.Clean(r.URL.Path), "/")
		if p == "" || p == "." {
			p = "index.html"
		}
		if f, err := root.Open(p); err == nil {
			st, err2 := f.Stat()
			_ = f.Close()
			if err2 == nil && !st.IsDir() {
				fileServer.ServeHTTP(w, r)
				return
			}
		}
		// Fallback to index.html for SPA client routing
		raw, err := fs.ReadFile(root, "index.html")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(raw)
	})
}
