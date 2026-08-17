package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPlayRecordingIsDurableAndSessionScoped(t *testing.T) {
	dataRoot := t.TempDir()
	mediaRoot := t.TempDir()
	writeTestFile(t, mediaRoot, "darklogo.png", "logo")
	writeTestFile(t, mediaRoot, "track.mp3", "audio")
	writeTestFile(t, mediaRoot, "other.mp3", "other")
	application, catalog, err := newApp(mediaRoot, dataRoot)
	if err != nil {
		t.Fatalf("newApp() error = %v", err)
	}
	server := httptest.NewServer(application.routes())
	defer server.Close()
	defer application.plays.Close()
	trackID := catalog.Tracks[0].ID

	first := postTestPlay(t, server.URL, trackID, "session-1")
	if first.status != http.StatusCreated || !first.counted {
		t.Fatalf("first play = %d counted=%t, want 201 counted=true", first.status, first.counted)
	}
	if first.playedAt == "" {
		t.Fatal("first play has no server timestamp")
	}
	duplicate := postTestPlay(t, server.URL, trackID, "session-1")
	if duplicate.status != http.StatusOK || duplicate.counted || duplicate.playedAt != first.playedAt {
		t.Fatalf("duplicate = %d counted=%t playedAt=%q, want 200 false and original timestamp", duplicate.status, duplicate.counted, duplicate.playedAt)
	}
	conflict := postTestPlay(t, server.URL, catalog.Tracks[1].ID, "session-1")
	if conflict.status != http.StatusConflict {
		t.Fatalf("same-session different-track status = %d, want 409", conflict.status)
	}

	history, err := os.ReadFile(filepath.Join(dataRoot, "plays.jsonl"))
	if err != nil {
		t.Fatalf("read history: %v", err)
	}
	if bytes.Count(history, []byte("\n")) != 1 {
		t.Fatalf("history records = %d, want 1", bytes.Count(history, []byte("\n")))
	}
	if !bytes.Contains(history, []byte(trackID)) || !bytes.Contains(history, []byte("session-1")) {
		t.Fatalf("history does not contain durable event: %q", history)
	}

	if err := application.plays.Close(); err != nil {
		t.Fatalf("close first store: %v", err)
	}
	restarted, _, err := newApp(mediaRoot, dataRoot)
	if err != nil {
		t.Fatalf("restart newApp() error = %v", err)
	}
	defer restarted.plays.Close()
	request := httptest.NewRequest(http.MethodGet, "/api/stats", nil)
	response := httptest.NewRecorder()
	restarted.serveStats(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("replayed stats status = %d", response.Code)
	}
	var stats statsResponse
	if err := json.NewDecoder(response.Body).Decode(&stats); err != nil {
		t.Fatalf("decode replayed stats: %v", err)
	}
	if stats.TotalPlays != 1 || stats.TotalTracks != 1 || len(stats.Rankings) != 1 || stats.Rankings[0].Plays != 1 {
		t.Fatalf("replayed stats = %+v, want one play", stats)
	}
}

func TestStatsPeriodsRankAndSummarizeCurrentCatalog(t *testing.T) {
	dataRoot := t.TempDir()
	mediaRoot := t.TempDir()
	writeTestFile(t, mediaRoot, "darklogo.png", "logo")
	writeTestFile(t, mediaRoot, "a.mp3", "a")
	writeTestFile(t, mediaRoot, "b.mp3", "b")
	catalog, _, _, err := scanLibrary(mediaRoot)
	if err != nil {
		t.Fatalf("scanLibrary() error = %v", err)
	}
	writeHistory(t, dataRoot,
		playEvent{SessionID: "a-1", TrackID: catalog.Tracks[0].ID, PlayedAt: "2024-01-01T00:00:00Z"},
		playEvent{SessionID: "a-2", TrackID: catalog.Tracks[0].ID, PlayedAt: "2024-01-15T00:00:00Z"},
		playEvent{SessionID: "b-1", TrackID: catalog.Tracks[1].ID, PlayedAt: "2024-01-20T00:00:00Z"},
		playEvent{SessionID: "b-2", TrackID: catalog.Tracks[1].ID, PlayedAt: "2025-01-01T00:00:00Z"},
		playEvent{SessionID: "old-unknown", TrackID: "missing-track", PlayedAt: "2025-02-01T00:00:00Z"},
	)
	application, _, err := newApp(mediaRoot, dataRoot)
	if err != nil {
		t.Fatalf("newApp() error = %v", err)
	}
	defer application.plays.Close()
	server := httptest.NewServer(application.routes())
	defer server.Close()

	all := getTestStats(t, server.URL+"/api/stats?limit=100")
	if all.TotalPlays != 4 || all.TotalTracks != 2 {
		t.Fatalf("all totals = %d plays / %d tracks, want 4 / 2", all.TotalPlays, all.TotalTracks)
	}
	if len(all.Periods.Years) != 2 || all.Periods.Years[0] != (yearSummary{Year: "2024", Plays: 3}) || all.Periods.Years[1] != (yearSummary{Year: "2025", Plays: 1}) {
		t.Fatalf("year summaries = %+v", all.Periods.Years)
	}
	if len(all.Periods.Months) != 2 || all.Periods.Months[0] != (monthSummary{Month: "2024-01", Plays: 3}) || all.Periods.Months[1] != (monthSummary{Month: "2025-01", Plays: 1}) {
		t.Fatalf("month summaries = %+v", all.Periods.Months)
	}

	year := getTestStats(t, server.URL+"/api/stats?period=year&year=2024")
	if year.TotalPlays != 3 || year.TotalTracks != 2 || len(year.Rankings) != 2 {
		t.Fatalf("year stats = %+v, want 3 plays and 2 tracks", year)
	}
	if year.Rankings[0].TrackID != catalog.Tracks[0].ID || year.Rankings[0].Plays != 2 {
		t.Fatalf("year ranking = %+v, want first track twice", year.Rankings)
	}
	month := getTestStats(t, server.URL+"/api/stats?period=month&month=2024-01")
	if month.TotalPlays != 3 || month.TotalTracks != 2 || month.Period != "month" || month.Month != "2024-01" {
		t.Fatalf("month stats = %+v", month)
	}
}

func TestStatsPaginationStopsAtRank100(t *testing.T) {
	dataRoot := t.TempDir()
	mediaRoot := t.TempDir()
	writeTestFile(t, mediaRoot, "darklogo.png", "logo")
	for index := range 105 {
		writeTestFile(t, mediaRoot, fmt.Sprintf("tracks/%03d.mp3", index), "audio")
	}
	catalog, _, _, err := scanLibrary(mediaRoot)
	if err != nil {
		t.Fatalf("scanLibrary() error = %v", err)
	}
	events := make([]playEvent, 0, len(catalog.Tracks))
	for index, item := range catalog.Tracks {
		events = append(events, playEvent{SessionID: fmt.Sprintf("session-%03d", index), TrackID: item.ID, PlayedAt: "2024-01-01T00:00:00Z"})
	}
	writeHistory(t, dataRoot, events...)
	application, _, err := newApp(mediaRoot, dataRoot)
	if err != nil {
		t.Fatalf("newApp() error = %v", err)
	}
	defer application.plays.Close()
	server := httptest.NewServer(application.routes())
	defer server.Close()

	first := getTestStats(t, server.URL+"/api/stats?limit=100")
	if first.TotalTracks != 105 || len(first.Rankings) != 100 || first.HasMore {
		t.Fatalf("first page = %d total, %d rankings, hasMore=%t", first.TotalTracks, len(first.Rankings), first.HasMore)
	}
	last := getTestStats(t, server.URL+"/api/stats?offset=99&limit=10")
	if len(last.Rankings) != 1 || last.HasMore {
		t.Fatalf("rank 100 window = %d rankings, hasMore=%t", len(last.Rankings), last.HasMore)
	}
	beyond := getTestStats(t, server.URL+"/api/stats?offset=100&limit=10")
	if len(beyond.Rankings) != 0 || beyond.HasMore {
		t.Fatalf("beyond rank cap = %d rankings, hasMore=%t", len(beyond.Rankings), beyond.HasMore)
	}
}

func TestPlayAndStatsValidationAndMethods(t *testing.T) {
	dataRoot := t.TempDir()
	mediaRoot := t.TempDir()
	writeTestFile(t, mediaRoot, "darklogo.png", "logo")
	writeTestFile(t, mediaRoot, "track.mp3", "audio")
	application, catalog, err := newApp(mediaRoot, dataRoot)
	if err != nil {
		t.Fatalf("newApp() error = %v", err)
	}
	defer application.plays.Close()
	server := httptest.NewServer(application.routes())
	defer server.Close()
	trackID := catalog.Tracks[0].ID

	cases := []struct {
		name      string
		body      string
		typeValue string
		origin    string
		want      int
	}{
		{name: "missing content type", body: `{"trackId":"` + trackID + `","sessionId":"one"}`, want: http.StatusUnsupportedMediaType},
		{name: "unknown field", body: `{"trackId":"` + trackID + `","sessionId":"two","playedAt":"now"}`, typeValue: "application/json", want: http.StatusBadRequest},
		{name: "trailing object", body: `{"trackId":"` + trackID + `","sessionId":"three"}{}`, typeValue: "application/json", want: http.StatusBadRequest},
		{name: "unknown track", body: `{"trackId":"missing","sessionId":"four"}`, typeValue: "application/json", want: http.StatusNotFound},
		{name: "cross site", body: `{"trackId":"` + trackID + `","sessionId":"five"}`, typeValue: "application/json", origin: "https://evil.example", want: http.StatusForbidden},
		{name: "empty session", body: `{"trackId":"` + trackID + `","sessionId":""}`, typeValue: "application/json", want: http.StatusBadRequest},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			request, err := http.NewRequest(http.MethodPost, server.URL+"/api/plays", strings.NewReader(item.body))
			if err != nil {
				t.Fatal(err)
			}
			if item.typeValue != "" {
				request.Header.Set("Content-Type", item.typeValue)
			}
			if item.origin != "" {
				request.Header.Set("Origin", item.origin)
			}
			response, err := http.DefaultClient.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if response.StatusCode != item.want {
				t.Errorf("status = %d, want %d", response.StatusCode, item.want)
			}
		})
	}
	longSession := strings.Repeat("x", 129)
	tooLong := postTestPlayWithBody(t, server.URL, `{"trackId":"`+trackID+`","sessionId":"`+longSession+`"}`, "application/json")
	if tooLong.status != http.StatusBadRequest {
		t.Errorf("long session status = %d, want 400", tooLong.status)
	}
	tooLarge := postTestPlayWithBody(t, server.URL, strings.Repeat("x", maxPlayBodyBytes+1), "application/json")
	if tooLarge.status != http.StatusBadRequest {
		t.Errorf("oversized body status = %d, want 400", tooLarge.status)
	}

	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
		request, err := http.NewRequest(method, server.URL+"/api/plays", nil)
		if err != nil {
			t.Fatal(err)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusMethodNotAllowed || response.Header.Get("Allow") != "POST" {
			t.Errorf("%s /api/plays = %d Allow=%q, want 405 POST", method, response.StatusCode, response.Header.Get("Allow"))
		}
	}
	request, err := http.NewRequest(http.MethodPost, server.URL+"/api/stats", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusMethodNotAllowed || response.Header.Get("Allow") != "GET, HEAD" {
		t.Errorf("POST /api/stats = %d Allow=%q, want 405 GET, HEAD", response.StatusCode, response.Header.Get("Allow"))
	}
	for _, query := range []string{
		"?period=year",
		"?period=all&year=2024",
		"?period=month&year=2024&month=2024-01",
		"?period=all&period=all",
		"?unknown=x",
		"?limit=0",
		"?limit=101",
		"?month=2024-13",
	} {
		statsResponse := getRaw(t, server.URL+"/api/stats"+query)
		if statsResponse.StatusCode != http.StatusBadRequest {
			t.Errorf("GET /api/stats%s = %d, want 400", query, statsResponse.StatusCode)
		}
		statsResponse.Body.Close()
	}
}

func TestHistoryReplayRejectsCorruptionAndDropsTornTail(t *testing.T) {
	dataRoot := t.TempDir()
	trackID := "known"
	tracks := []track{{ID: trackID}}
	writeHistory(t, dataRoot, playEvent{SessionID: "complete", TrackID: trackID, PlayedAt: "2024-01-01T00:00:00Z"})
	file := filepath.Join(dataRoot, "plays.jsonl")
	if err := os.WriteFile(file, append(mustJSON(t, playEvent{SessionID: "complete", TrackID: trackID, PlayedAt: "2024-01-01T00:00:00Z"}), '\n'), 0o644); err != nil {
		t.Fatalf("rewrite history: %v", err)
	}
	content, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	content = append(content, []byte(`{"sessionId":"torn","trackId":"known"}`)...)
	if err := os.WriteFile(file, content, 0o644); err != nil {
		t.Fatal(err)
	}
	store, err := openPlayStore(dataRoot, tracks)
	if err != nil {
		t.Fatalf("open torn history: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	truncated, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasSuffix(truncated, []byte{'\n'}) || bytes.Contains(truncated, []byte("torn")) {
		t.Fatalf("torn tail was not discarded: %q", truncated)
	}

	corruptRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(corruptRoot, "plays.jsonl"), []byte("{not-json}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := openPlayStore(corruptRoot, tracks); err == nil {
		t.Fatal("newline-terminated corrupt history unexpectedly opened")
	}
}

type testPlayResult struct {
	status   int
	playedAt string
	counted  bool
}

func postTestPlay(t *testing.T, endpoint, trackID, sessionID string) testPlayResult {
	t.Helper()
	return postTestPlayWithBody(t, endpoint, fmt.Sprintf(`{"trackId":%q,"sessionId":%q}`, trackID, sessionID), "application/json")
}

func postTestPlayWithBody(t *testing.T, endpoint, body, contentType string) testPlayResult {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, endpoint+"/api/plays", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", contentType)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	result := testPlayResult{status: response.StatusCode}
	if response.StatusCode == http.StatusCreated || response.StatusCode == http.StatusOK {
		var body struct {
			PlayedAt string `json:"playedAt"`
			Counted  bool   `json:"counted"`
		}
		if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		result.playedAt = body.PlayedAt
		result.counted = body.Counted
	}
	return result
}

func getTestStats(t *testing.T, endpoint string) statsResponse {
	t.Helper()
	response := getRaw(t, endpoint)
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("GET stats status = %d", response.StatusCode)
	}
	var stats statsResponse
	if err := json.NewDecoder(response.Body).Decode(&stats); err != nil {
		t.Fatal(err)
	}
	return stats
}

func getRaw(t *testing.T, endpoint string) *http.Response {
	t.Helper()
	response, err := http.Get(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func writeHistory(t *testing.T, root string, events ...playEvent) {
	t.Helper()
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	file, err := os.Create(filepath.Join(root, "plays.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	for _, event := range events {
		if _, err := file.Write(append(mustJSON(t, event), '\n')); err != nil {
			t.Fatal(err)
		}
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}
