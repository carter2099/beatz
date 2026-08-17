package main

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"io/fs"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

const (
	defaultAddress   = ":30142"
	artworkDirectory = "artwork"
	starterDirectory = "starters"
)

var audioExtensions = map[string]struct{}{
	".aac":  {},
	".flac": {},
	".m4a":  {},
	".mp3":  {},
	".ogg":  {},
	".opus": {},
	".wav":  {},
}

var artworkExtensions = map[string]struct{}{
	".avif": {},
	".jpeg": {},
	".jpg":  {},
	".png":  {},
	".webp": {},
}

//go:embed web
var embeddedWeb embed.FS

type track struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Filename  string `json:"filename"`
	Path      string `json:"path"`
	Directory string `json:"directory"`
	URL       string `json:"url"`
	Size      int64  `json:"size"`
	Starter   bool   `json:"starter,omitempty"`
}

type artwork struct {
	ID       string `json:"id"`
	Filename string `json:"filename"`
	URL      string `json:"url"`
}

type starterReference struct {
	Filename string
	Size     int64
}

type starterKey struct {
	Filename string
	Size     int64
}

type library struct {
	TrackCount   int       `json:"trackCount"`
	StarterCount int       `json:"starterCount"`
	TotalBytes   int64     `json:"totalBytes"`
	Tracks       []track   `json:"tracks"`
	Artwork      []artwork `json:"artwork"`
}

type app struct {
	indexHTML    []byte
	libraryJSON  []byte
	libraryETag  string
	logoPath     string
	mediaPaths   map[string]string
	artworkPaths map[string]string
	static       http.Handler
	plays        *playStore
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		endpoint := "http://127.0.0.1" + defaultAddress + "/healthz"
		if len(os.Args) > 2 {
			endpoint = os.Args[2]
		}
		if err := runHealthcheck(endpoint); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}

	mediaRoot := envOrDefault("BEATZ_MEDIA_ROOT", "./beatz-selected")
	dataRoot := envOrDefault("BEATZ_DATA_ROOT", "./beatz-data")
	address := envOrDefault("BEATZ_ADDR", defaultAddress)
	application, catalog, err := newApp(mediaRoot, dataRoot)
	if err != nil {
		slog.Error("cannot initialize beatz", "error", err)
		os.Exit(1)
	}
	defer func() {
		if err := application.plays.Close(); err != nil {
			slog.Error("close play history", "error", err)
		}
	}()

	server := &http.Server{
		Addr:              address,
		Handler:           application.routes(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       90 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() {
		slog.Info("beatz is listening", "address", address, "tracks", catalog.TrackCount, "starters", catalog.StarterCount, "artwork", len(catalog.Artwork), "mediaRoot", mediaRoot, "dataRoot", dataRoot)
		errCh <- server.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server stopped", "error", err)
			os.Exit(1)
		}
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			slog.Error("graceful shutdown failed", "error", err)
			os.Exit(1)
		}
	}
}

func newApp(mediaRoot, dataRoot string) (*app, library, error) {
	catalog, mediaPaths, artworkPaths, err := scanLibrary(mediaRoot)
	if err != nil {
		return nil, library{}, err
	}
	if catalog.TrackCount == 0 {
		return nil, library{}, fmt.Errorf("no supported audio files found in %s", mediaRoot)
	}

	logoPath := filepath.Join(mediaRoot, "darklogo.png")
	logoInfo, err := os.Stat(logoPath)
	if err != nil {
		return nil, library{}, fmt.Errorf("dark logo: %w", err)
	}
	if !logoInfo.Mode().IsRegular() {
		return nil, library{}, fmt.Errorf("dark logo is not a regular file: %s", logoPath)
	}

	webFS, err := fs.Sub(embeddedWeb, "web")
	if err != nil {
		return nil, library{}, fmt.Errorf("web assets: %w", err)
	}
	indexHTML, err := fs.ReadFile(webFS, "index.html")
	if err != nil {
		return nil, library{}, fmt.Errorf("index page: %w", err)
	}
	libraryJSON, err := json.Marshal(catalog)
	if err != nil {
		return nil, library{}, fmt.Errorf("encode library: %w", err)
	}
	digest := sha256.Sum256(libraryJSON)
	plays, err := openPlayStore(dataRoot, catalog.Tracks)
	if err != nil {
		return nil, library{}, fmt.Errorf("open play history: %w", err)
	}

	return &app{
		indexHTML:    indexHTML,
		libraryJSON:  libraryJSON,
		libraryETag:  `"` + hex.EncodeToString(digest[:12]) + `"`,
		logoPath:     logoPath,
		mediaPaths:   mediaPaths,
		artworkPaths: artworkPaths,
		static:       http.FileServer(http.FS(webFS)),
		plays:        plays,
	}, catalog, nil
}

func scanLibrary(mediaRoot string) (library, map[string]string, map[string]string, error) {
	root, err := filepath.Abs(mediaRoot)
	if err != nil {
		return library{}, nil, nil, fmt.Errorf("resolve media root: %w", err)
	}
	info, err := os.Stat(root)
	if err != nil {
		return library{}, nil, nil, fmt.Errorf("media root: %w", err)
	}
	if !info.IsDir() {
		return library{}, nil, nil, fmt.Errorf("media root is not a directory: %s", root)
	}

	tracks := make([]track, 0, 256)
	artworks := make([]artwork, 0, 32)
	starterReferences := make([]starterReference, 0, 16)
	mediaPaths := make(map[string]string, 256)
	artworkPaths := make(map[string]string, 32)
	var totalBytes int64

	err = filepath.WalkDir(root, func(filename string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			return nil
		}

		relative, err := filepath.Rel(root, filename)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		extension := strings.ToLower(filepath.Ext(entry.Name()))

		starterPrefix := starterDirectory + "/"
		if strings.HasPrefix(relative, starterPrefix) {
			if _, supported := audioExtensions[extension]; !supported {
				return nil
			}
			fileInfo, err := entry.Info()
			if err != nil {
				return err
			}
			starterReferences = append(starterReferences, starterReference{
				Filename: path.Base(relative),
				Size:     fileInfo.Size(),
			})
			return nil
		}

		artworkPrefix := artworkDirectory + "/"
		if strings.HasPrefix(relative, artworkPrefix) {
			if _, supported := artworkExtensions[extension]; !supported {
				return nil
			}
			artworkRelative := strings.TrimPrefix(relative, artworkPrefix)
			artworks = append(artworks, artwork{
				ID:       trackID(artworkPrefix + artworkRelative),
				Filename: path.Base(artworkRelative),
				URL:      artworkURL(artworkRelative),
			})
			artworkPaths[artworkRelative] = filename
			return nil
		}

		if _, supported := audioExtensions[extension]; !supported {
			return nil
		}
		fileInfo, err := entry.Info()
		if err != nil {
			return err
		}

		base := path.Base(relative)
		directory := path.Dir(relative)
		if directory == "." {
			directory = ""
		}
		tracks = append(tracks, track{
			ID:        trackID(relative),
			Title:     strings.TrimSuffix(base, path.Ext(base)),
			Filename:  base,
			Path:      relative,
			Directory: directory,
			URL:       mediaURL(relative),
			Size:      fileInfo.Size(),
		})
		mediaPaths[relative] = filename
		totalBytes += fileInfo.Size()
		return nil
	})
	if err != nil {
		return library{}, nil, nil, fmt.Errorf("scan media library: %w", err)
	}

	tracksByStarterKey := make(map[starterKey][]int, len(tracks))
	for index := range tracks {
		key := starterKey{
			Filename: strings.ToLower(tracks[index].Filename),
			Size:     tracks[index].Size,
		}
		tracksByStarterKey[key] = append(tracksByStarterKey[key], index)
	}

	for _, reference := range starterReferences {
		key := starterKey{
			Filename: strings.ToLower(reference.Filename),
			Size:     reference.Size,
		}
		matches := tracksByStarterKey[key]
		switch len(matches) {
		case 0:
			return library{}, nil, nil, fmt.Errorf("starter %q (%d bytes) does not match a library track", reference.Filename, reference.Size)
		case 1:
			tracks[matches[0]].Starter = true
		default:
			return library{}, nil, nil, fmt.Errorf("starter %q (%d bytes) matches multiple library tracks", reference.Filename, reference.Size)
		}
	}

	starterCount := 0
	for _, item := range tracks {
		if item.Starter {
			starterCount++
		}
	}

	sort.Slice(tracks, func(i, j int) bool {
		return strings.ToLower(tracks[i].Path) < strings.ToLower(tracks[j].Path)
	})
	sort.Slice(artworks, func(i, j int) bool {
		return strings.ToLower(artworks[i].Filename) < strings.ToLower(artworks[j].Filename)
	})

	return library{
		TrackCount:   len(tracks),
		StarterCount: starterCount,
		TotalBytes:   totalBytes,
		Tracks:       tracks,
		Artwork:      artworks,
	}, mediaPaths, artworkPaths, nil
}

func (a *app) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("GET /api/library", a.serveLibrary)
	mux.HandleFunc("GET /api/stats", a.serveStats)
	mux.HandleFunc("POST /api/plays", a.servePlay)
	mux.HandleFunc("GET /logo.png", a.serveLogo)
	mux.HandleFunc("GET /media/{path...}", a.serveMedia)
	mux.HandleFunc("GET /artwork/{path...}", a.serveArtwork)
	mux.Handle("GET /assets/", cacheAssets(a.static))
	mux.HandleFunc("GET /{$}", a.serveIndex)
	return securityHeaders(requireReadOnly(mux))
}

func (a *app) serveIndex(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(a.indexHTML)
}

func (a *app) serveLibrary(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("ETag", a.libraryETag)
	if r.Header.Get("If-None-Match") == a.libraryETag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	_, _ = w.Write(a.libraryJSON)
}

func (a *app) serveLogo(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Header().Set("Content-Type", "image/png")
	http.ServeFile(w, r, a.logoPath)
}

func (a *app) serveMedia(w http.ResponseWriter, r *http.Request) {
	relative := cleanRequestPath(r.PathValue("path"))
	filename, ok := a.mediaPaths[relative]
	if !ok {
		http.NotFound(w, r)
		return
	}
	serveIndexedFile(w, r, filename, "media unavailable")
}

func (a *app) serveArtwork(w http.ResponseWriter, r *http.Request) {
	relative := cleanRequestPath(r.PathValue("path"))
	filename, ok := a.artworkPaths[relative]
	if !ok {
		http.NotFound(w, r)
		return
	}
	serveIndexedFile(w, r, filename, "artwork unavailable")
}

func cleanRequestPath(value string) string {
	relative := path.Clean(value)
	if relative == "." || relative == ".." || strings.HasPrefix(relative, "../") {
		return ""
	}
	return relative
}

func serveIndexedFile(w http.ResponseWriter, r *http.Request, filename, errorMessage string) {
	file, err := os.Open(filename)
	if err != nil {
		http.Error(w, errorMessage, http.StatusInternalServerError)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		http.Error(w, errorMessage, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": info.Name()}))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, info.Name(), info.ModTime(), file)
}

func requireReadOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/stats" || r.URL.Path == "/api/plays" {
			w.Header().Set("Cache-Control", "no-store")
		}
		if r.Method == http.MethodPost && r.URL.Path == "/api/plays" {
			next.ServeHTTP(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			allow := "GET, HEAD"
			if r.URL.Path == "/api/plays" {
				allow = "POST"
			}
			w.Header().Set("Allow", allow)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; img-src 'self' data:; media-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'")
		w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}

func cacheAssets(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		next.ServeHTTP(w, r)
	})
}

func mediaURL(relative string) string {
	return indexedFileURL("/media/", relative)
}

func artworkURL(relative string) string {
	return indexedFileURL("/artwork/", relative)
}

func indexedFileURL(prefix, relative string) string {
	parts := strings.Split(relative, "/")
	for i := range parts {
		parts[i] = url.PathEscape(parts[i])
	}
	return prefix + strings.Join(parts, "/")
}

func trackID(relative string) string {
	hash := fnv.New64a()
	_, _ = hash.Write([]byte(relative))
	return fmt.Sprintf("%016x", hash.Sum64())
}

func envOrDefault(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func runHealthcheck(endpoint string) error {
	client := &http.Client{Timeout: 2 * time.Second}
	response, err := client.Get(endpoint)
	if err != nil {
		return fmt.Errorf("healthcheck request: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("healthcheck returned %s", response.Status)
	}
	return nil
}
