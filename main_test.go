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

func TestScanLibraryPreservesHierarchyAndFiltersFiles(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, root, "2022/April/mp3s/beat #1 (demo).mp3", "0123456789")
	writeTestFile(t, root, "2021/December/mp3s/older.wav", "wave")
	writeTestFile(t, root, "2022/April/notes.txt", "not audio")
	writeTestFile(t, root, "lightlogo.png", "not a track")

	catalog, paths, err := scanLibrary(root)
	if err != nil {
		t.Fatalf("scanLibrary() error = %v", err)
	}
	if catalog.TrackCount != 2 {
		t.Fatalf("TrackCount = %d, want 2", catalog.TrackCount)
	}
	if catalog.TotalBytes != 14 {
		t.Fatalf("TotalBytes = %d, want 14", catalog.TotalBytes)
	}
	if len(paths) != 2 {
		t.Fatalf("indexed paths = %d, want 2", len(paths))
	}

	var found track
	for _, item := range catalog.Tracks {
		if strings.Contains(item.Filename, "beat #1") {
			found = item
			break
		}
	}
	if found.Path != "2022/April/mp3s/beat #1 (demo).mp3" {
		t.Errorf("Path = %q", found.Path)
	}
	if found.Directory != "2022/April/mp3s" {
		t.Errorf("Directory = %q", found.Directory)
	}
	if found.Title != "beat #1 (demo)" {
		t.Errorf("Title = %q", found.Title)
	}
	if !strings.Contains(found.URL, "beat%20%231") {
		t.Errorf("URL = %q, want escaped filename", found.URL)
	}
}

func TestRoutesExposeReadOnlyCatalogAndRangePlayback(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, root, "darklogo.png", "dark-logo")
	writeTestFile(t, root, "lightlogo.png", "light-logo")
	writeTestFile(t, root, "2023/January/mp3s/test beat.mp3", "0123456789")

	application, _, err := newApp(root)
	if err != nil {
		t.Fatalf("newApp() error = %v", err)
	}
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
	var catalog library
	if err := json.NewDecoder(response.Body).Decode(&catalog); err != nil {
		t.Fatalf("decode library: %v", err)
	}
	if catalog.TrackCount != 1 {
		t.Fatalf("TrackCount = %d, want 1", catalog.TrackCount)
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

	lightResponse, err := http.Get(server.URL + "/media/lightlogo.png")
	if err != nil {
		t.Fatalf("GET unindexed file: %v", err)
	}
	lightResponse.Body.Close()
	if lightResponse.StatusCode != http.StatusNotFound {
		t.Errorf("unindexed file status = %d, want %d", lightResponse.StatusCode, http.StatusNotFound)
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
