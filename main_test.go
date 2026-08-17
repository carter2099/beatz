package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestScanLibraryPreservesHierarchyAndIndexesArtwork(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, root, "2022/April/beat #1 (demo).mp3", "0123456789")
	writeTestFile(t, root, "starters/beat #1 (demo).mp3", "0123456789")
	writeTestFile(t, root, "2021/December/older.wav", "wave")
	writeTestFile(t, root, "2022/April/notes.txt", "not audio")
	writeTestFile(t, root, "artwork/photo #1.jpg", "photo")
	writeTestFile(t, root, "artwork/notes.txt", "not artwork")
	writeTestFile(t, root, "lightlogo.png", "not a track")

	catalog, audioPaths, artworkPaths, err := scanLibrary(root)
	if err != nil {
		t.Fatalf("scanLibrary() error = %v", err)
	}
	if catalog.TrackCount != 2 {
		t.Fatalf("TrackCount = %d, want 2", catalog.TrackCount)
	}
	if catalog.TotalBytes != 14 {
		t.Fatalf("TotalBytes = %d, want 14", catalog.TotalBytes)
	}
	if catalog.StarterCount != 1 {
		t.Fatalf("StarterCount = %d, want 1", catalog.StarterCount)
	}
	if len(audioPaths) != 2 {
		t.Fatalf("indexed audio paths = %d, want 2", len(audioPaths))
	}
	if _, exposed := audioPaths["starters/beat #1 (demo).mp3"]; exposed {
		t.Error("starter copy was indexed as a separate audio path")
	}
	if len(catalog.Artwork) != 1 || len(artworkPaths) != 1 {
		t.Fatalf("indexed artwork = %d catalog / %d paths, want 1 / 1", len(catalog.Artwork), len(artworkPaths))
	}

	var found track
	for _, item := range catalog.Tracks {
		if strings.Contains(item.Filename, "beat #1") {
			found = item
			break
		}
	}
	if found.Path != "2022/April/beat #1 (demo).mp3" {
		t.Errorf("Path = %q", found.Path)
	}
	if found.Directory != "2022/April" {
		t.Errorf("Directory = %q", found.Directory)
	}
	if found.Title != "beat #1 (demo)" {
		t.Errorf("Title = %q", found.Title)
	}
	if !found.Starter {
		t.Error("matching library track is not marked as a starter")
	}
	if !strings.Contains(found.URL, "beat%20%231") {
		t.Errorf("URL = %q, want escaped filename", found.URL)
	}
	if catalog.Artwork[0].Filename != "photo #1.jpg" {
		t.Errorf("artwork filename = %q", catalog.Artwork[0].Filename)
	}
	if !strings.Contains(catalog.Artwork[0].URL, "photo%20%231.jpg") {
		t.Errorf("artwork URL = %q, want escaped filename", catalog.Artwork[0].URL)
	}
}

func TestRoutesExposeReadOnlyCatalogPlaybackAndArtwork(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, root, "darklogo.png", "dark-logo")
	writeTestFile(t, root, "lightlogo.png", "light-logo")
	writeTestFile(t, root, "2023/January/test beat.mp3", "0123456789")
	writeTestFile(t, root, "starters/test beat.mp3", "0123456789")
	writeTestFile(t, root, "artwork/cover.webp", "photo")

	application, _, err := newApp(root, t.TempDir())
	if err != nil {
		t.Fatalf("newApp() error = %v", err)
	}
	t.Cleanup(func() { _ = application.plays.Close() })
	server := httptest.NewServer(application.routes())
	t.Cleanup(server.Close)

	response, err := http.Get(server.URL + "/api/library")
	if err != nil {
		t.Fatalf("GET library: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("GET library status = %d", response.StatusCode)
	}
	if response.Header.Get("Content-Security-Policy") == "" {
		t.Error("Content-Security-Policy header is missing")
	}
	if response.Header.Get("Cache-Control") != "no-cache" {
		t.Errorf("library Cache-Control = %q, want no-cache", response.Header.Get("Cache-Control"))
	}
	var catalog library
	if err := json.NewDecoder(response.Body).Decode(&catalog); err != nil {
		t.Fatalf("decode library: %v", err)
	}
	if catalog.TrackCount != 1 {
		t.Fatalf("TrackCount = %d, want 1", catalog.TrackCount)
	}
	if catalog.StarterCount != 1 || !catalog.Tracks[0].Starter {
		t.Fatalf("starter catalog = %d / %t, want 1 / true", catalog.StarterCount, catalog.Tracks[0].Starter)
	}
	if len(catalog.Artwork) != 1 {
		t.Fatalf("artwork count = %d, want 1", len(catalog.Artwork))
	}

	request, err := http.NewRequest(http.MethodGet, server.URL+catalog.Tracks[0].URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Range", "bytes=2-5")
	rangeResponse, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("range request: %v", err)
	}
	defer rangeResponse.Body.Close()
	body, err := io.ReadAll(rangeResponse.Body)
	if err != nil {
		t.Fatalf("read range response: %v", err)
	}
	if rangeResponse.StatusCode != http.StatusPartialContent {
		t.Errorf("range status = %d, want %d", rangeResponse.StatusCode, http.StatusPartialContent)
	}
	if string(body) != "2345" {
		t.Errorf("range body = %q, want %q", body, "2345")
	}
	if rangeResponse.Header.Get("Accept-Ranges") != "bytes" {
		t.Errorf("Accept-Ranges = %q, want bytes", rangeResponse.Header.Get("Accept-Ranges"))
	}

	artworkResponse, err := http.Get(server.URL + catalog.Artwork[0].URL)
	if err != nil {
		t.Fatalf("GET artwork: %v", err)
	}
	artworkBody, err := io.ReadAll(artworkResponse.Body)
	artworkResponse.Body.Close()
	if err != nil {
		t.Fatalf("read artwork: %v", err)
	}
	if artworkResponse.StatusCode != http.StatusOK || string(artworkBody) != "photo" {
		t.Errorf("artwork response = %d %q, want 200 photo", artworkResponse.StatusCode, artworkBody)
	}

	logoResponse, err := http.Get(server.URL + "/logo.png")
	if err != nil {
		t.Fatalf("GET logo: %v", err)
	}
	logoBody, err := io.ReadAll(logoResponse.Body)
	logoResponse.Body.Close()
	if err != nil {
		t.Fatalf("read logo: %v", err)
	}
	if string(logoBody) != "dark-logo" {
		t.Errorf("logo body = %q, want dark logo only", logoBody)
	}

	for _, path := range []string{"/media/lightlogo.png", "/artwork/lightlogo.png", "/media/starters/test%20beat.mp3"} {
		unindexedResponse, err := http.Get(server.URL + path)
		if err != nil {
			t.Fatalf("GET unindexed file %s: %v", path, err)
		}
		unindexedResponse.Body.Close()
		if unindexedResponse.StatusCode != http.StatusNotFound {
			t.Errorf("unindexed file %s status = %d, want %d", path, unindexedResponse.StatusCode, http.StatusNotFound)
		}
	}

	postResponse, err := http.Post(server.URL+"/api/library", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("POST library: %v", err)
	}
	postResponse.Body.Close()
	if postResponse.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("POST status = %d, want %d", postResponse.StatusCode, http.StatusMethodNotAllowed)
	}
	if postResponse.Header.Get("Allow") != "GET, HEAD" {
		t.Errorf("Allow = %q, want GET, HEAD", postResponse.Header.Get("Allow"))
	}
}

func TestScanLibraryRejectsUnmatchedStarter(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, root, "2022/April/library.mp3", "library")
	writeTestFile(t, root, "starters/missing.mp3", "starter")

	_, _, _, err := scanLibrary(root)
	if err == nil || !strings.Contains(err.Error(), "does not match a library track") {
		t.Fatalf("scanLibrary() error = %v, want unmatched starter error", err)
	}
}

func writeTestFile(t *testing.T, root, relative, content string) {
	t.Helper()
	filename := filepath.Join(root, filepath.FromSlash(relative))
	if err := os.MkdirAll(filepath.Dir(filename), 0o755); err != nil {
		t.Fatalf("mkdir fixture: %v", err)
	}
	if err := os.WriteFile(filename, []byte(content), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
}
