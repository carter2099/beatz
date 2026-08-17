package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const maxPlayBodyBytes = 4096

var errSessionTrackConflict = errors.New("session already recorded for another track")

type playRequest struct {
	TrackID   string `json:"trackId"`
	SessionID string `json:"sessionId"`
}

type playEvent struct {
	SessionID string `json:"sessionId"`
	TrackID   string `json:"trackId"`
	PlayedAt  string `json:"playedAt"`
}

type playStore struct {
	mu       sync.RWMutex
	file     *os.File
	filename string
	catalog  map[string]struct{}
	sessions map[string]playEvent
	all      map[string]int
	years    map[string]map[string]int
	months   map[string]map[string]int
}

func openPlayStore(dataRoot string, tracks []track) (*playStore, error) {
	if strings.TrimSpace(dataRoot) == "" {
		return nil, errors.New("data root is empty")
	}
	root, err := filepath.Abs(dataRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve data root: %w", err)
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, fmt.Errorf("create data root: %w", err)
	}
	if err := syncDirectory(filepath.Dir(root)); err != nil {
		return nil, fmt.Errorf("sync data-root parent: %w", err)
	}
	filename := filepath.Join(root, "plays.jsonl")
	file, err := os.OpenFile(filename, os.O_RDWR|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", filename, err)
	}
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("secure %s: %w", filename, err)
	}
	if err := syncDirectory(root); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("sync data root: %w", err)
	}
	store := &playStore{
		file:     file,
		filename: filename,
		catalog:  make(map[string]struct{}, len(tracks)),
		sessions: make(map[string]playEvent),
		all:      make(map[string]int),
		years:    make(map[string]map[string]int),
		months:   make(map[string]map[string]int),
	}
	for _, item := range tracks {
		store.catalog[item.ID] = struct{}{}
	}
	if err := store.replay(); err != nil {
		_ = file.Close()
		return nil, err
	}
	return store, nil
}

func syncDirectory(name string) error {
	directory, err := os.Open(name)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func (p *playStore) replay() error {
	if _, err := p.file.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("seek %s: %w", p.filename, err)
	}
	reader := bufio.NewReaderSize(p.file, maxPlayBodyBytes)
	var completeBytes int64
	for lineNumber := 1; ; lineNumber++ {
		line, err := reader.ReadSlice('\n')
		switch {
		case err == nil:
			event, decodeErr := decodePlayEvent(line[:len(line)-1])
			if decodeErr != nil {
				return fmt.Errorf("history line %d: %w", lineNumber, decodeErr)
			}
			if commitErr := p.commitMemory(event); commitErr != nil {
				return fmt.Errorf("history line %d: %w", lineNumber, commitErr)
			}
			completeBytes += int64(len(line))
		case errors.Is(err, io.EOF):
			if len(line) > 0 {
				if truncateErr := p.file.Truncate(completeBytes); truncateErr != nil {
					return fmt.Errorf("truncate unterminated history: %w", truncateErr)
				}
				if syncErr := p.file.Sync(); syncErr != nil {
					return fmt.Errorf("sync truncated history: %w", syncErr)
				}
			}
			if _, seekErr := p.file.Seek(0, io.SeekEnd); seekErr != nil {
				return fmt.Errorf("seek end of %s: %w", p.filename, seekErr)
			}
			return nil
		case errors.Is(err, bufio.ErrBufferFull):
			return fmt.Errorf("history line %d exceeds %d bytes", lineNumber, maxPlayBodyBytes)
		default:
			return fmt.Errorf("read %s: %w", p.filename, err)
		}
	}
}

func decodePlayEvent(line []byte) (playEvent, error) {
	if len(bytes.TrimSpace(line)) == 0 {
		return playEvent{}, errors.New("empty record")
	}
	if !utf8.Valid(line) {
		return playEvent{}, errors.New("record is not valid UTF-8")
	}
	decoder := json.NewDecoder(bytes.NewReader(line))
	var event playEvent
	if err := decodeStrictObject(decoder, map[string]func(json.RawMessage) error{
		"sessionId": func(raw json.RawMessage) error {
			return decodeJSONString(raw, &event.SessionID)
		},
		"trackId": func(raw json.RawMessage) error {
			return decodeJSONString(raw, &event.TrackID)
		},
		"playedAt": func(raw json.RawMessage) error {
			return decodeJSONString(raw, &event.PlayedAt)
		},
	}); err != nil {
		return playEvent{}, fmt.Errorf("invalid JSON: %w", err)
	}
	if err := requireJSONEOF(decoder); err != nil {
		return playEvent{}, fmt.Errorf("trailing JSON: %w", err)
	}
	if err := validateStoredEvent(event); err != nil {
		return playEvent{}, err
	}
	return event, nil
}

func decodeStrictObject(decoder *json.Decoder, fields map[string]func(json.RawMessage) error) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	opening, ok := token.(json.Delim)
	if !ok || opening != '{' {
		return errors.New("value must be an object")
	}
	seen := make(map[string]struct{}, len(fields))
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		key, ok := token.(string)
		if !ok {
			return errors.New("object key is not a string")
		}
		if _, duplicate := seen[key]; duplicate {
			return fmt.Errorf("duplicate field %q", key)
		}
		seen[key] = struct{}{}
		decode, known := fields[key]
		if !known {
			return fmt.Errorf("unknown field %q", key)
		}
		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			return err
		}
		if err := decode(raw); err != nil {
			return fmt.Errorf("field %q: %w", key, err)
		}
	}
	token, err = decoder.Token()
	if err != nil {
		return err
	}
	closing, ok := token.(json.Delim)
	if !ok || closing != '}' {
		return errors.New("object is not closed")
	}
	if len(seen) != len(fields) {
		return errors.New("object has missing fields")
	}
	return nil
}

func decodeJSONString(raw json.RawMessage, destination *string) error {
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return errors.New("value must be a string")
	}
	*destination = value
	return nil
}

func requireJSONEOF(decoder *json.Decoder) error {
	var extra any
	err := decoder.Decode(&extra)
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err == nil {
		return errors.New("multiple JSON values")
	}
	return err
}

func validateStoredEvent(event playEvent) error {
	if event.SessionID == "" {
		return errors.New("sessionId is empty")
	}
	if !utf8.ValidString(event.SessionID) {
		return errors.New("sessionId is not valid UTF-8")
	}
	if len([]byte(event.SessionID)) > 128 {
		return errors.New("sessionId exceeds 128 bytes")
	}
	if event.TrackID == "" {
		return errors.New("trackId is empty")
	}
	if !utf8.ValidString(event.TrackID) {
		return errors.New("trackId is not valid UTF-8")
	}
	if _, err := time.Parse(time.RFC3339Nano, event.PlayedAt); err != nil {
		return fmt.Errorf("playedAt is not RFC3339: %w", err)
	}
	return nil
}

func (p *playStore) commitMemory(event playEvent) error {
	if previous, ok := p.sessions[event.SessionID]; ok {
		if previous.TrackID != event.TrackID {
			return errSessionTrackConflict
		}
		return nil
	}
	playedAt, err := time.Parse(time.RFC3339Nano, event.PlayedAt)
	if err != nil {
		return fmt.Errorf("playedAt is not RFC3339: %w", err)
	}
	year := playedAt.UTC().Format("2006")
	month := playedAt.UTC().Format("2006-01")
	p.sessions[event.SessionID] = event
	p.all[event.TrackID]++
	if p.years[year] == nil {
		p.years[year] = make(map[string]int)
	}
	p.years[year][event.TrackID]++
	if p.months[month] == nil {
		p.months[month] = make(map[string]int)
	}
	p.months[month][event.TrackID]++
	return nil
}

func (p *playStore) record(sessionID, trackID string) (playEvent, bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.file == nil {
		return playEvent{}, false, errors.New("play history is closed")
	}
	if previous, ok := p.sessions[sessionID]; ok {
		if previous.TrackID != trackID {
			return playEvent{}, false, errSessionTrackConflict
		}
		return previous, false, nil
	}

	event := playEvent{
		SessionID: sessionID,
		TrackID:   trackID,
		PlayedAt:  time.Now().UTC().Format(time.RFC3339Nano),
	}
	encoded, err := json.Marshal(event)
	if err != nil {
		return playEvent{}, false, fmt.Errorf("encode play: %w", err)
	}
	line := make([]byte, len(encoded)+1)
	copy(line, encoded)
	line[len(encoded)] = '\n'
	fileInfo, err := p.file.Stat()
	if err != nil {
		return playEvent{}, false, fmt.Errorf("stat play history: %w", err)
	}
	start := fileInfo.Size()
	written, err := p.file.Write(line)
	if err != nil || written != len(line) {
		rollbackErr := p.rollback(start)
		if err != nil {
			if rollbackErr != nil {
				return playEvent{}, false, p.failClosed(fmt.Errorf("append play: %w", err), rollbackErr)
			}
			return playEvent{}, false, fmt.Errorf("append play: %w", err)
		}
		if rollbackErr != nil {
			cause := fmt.Errorf("short append play (%d/%d)", written, len(line))
			return playEvent{}, false, p.failClosed(cause, rollbackErr)
		}
		return playEvent{}, false, fmt.Errorf("short append play (%d/%d)", written, len(line))
	}
	if err := p.file.Sync(); err != nil {
		rollbackErr := p.rollback(start)
		if rollbackErr != nil {
			return playEvent{}, false, p.failClosed(fmt.Errorf("sync play: %w", err), rollbackErr)
		}
		return playEvent{}, false, fmt.Errorf("sync play: %w", err)
	}
	if err := p.commitMemory(event); err != nil {
		rollbackErr := p.rollback(start)
		if rollbackErr != nil {
			return playEvent{}, false, p.failClosed(fmt.Errorf("commit play: %w", err), rollbackErr)
		}
		return playEvent{}, false, fmt.Errorf("commit play: %w", err)
	}
	return event, true, nil
}

func (p *playStore) rollback(size int64) error {
	if err := p.file.Truncate(size); err != nil {
		return err
	}
	return p.file.Sync()
}

func (p *playStore) failClosed(cause, rollbackErr error) error {
	closeErr := p.file.Close()
	p.file = nil
	if closeErr != nil {
		return fmt.Errorf("%v (rollback: %v; close: %v)", cause, rollbackErr, closeErr)
	}
	return fmt.Errorf("%v (rollback: %v; play history closed)", cause, rollbackErr)
}

func (p *playStore) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.file == nil {
		return nil
	}
	err := p.file.Close()
	p.file = nil
	return err
}

type statsQuery struct {
	period string
	year   string
	month  string
	offset int
	limit  int
}

type ranking struct {
	TrackID string `json:"trackId"`
	Plays   int    `json:"plays"`
}

type yearSummary struct {
	Year  string `json:"year"`
	Plays int    `json:"plays"`
}

type monthSummary struct {
	Month string `json:"month"`
	Plays int    `json:"plays"`
}

type periodSummaries struct {
	Years  []yearSummary  `json:"years"`
	Months []monthSummary `json:"months"`
}

type statsResponse struct {
	Period      string          `json:"period"`
	Year        string          `json:"year,omitempty"`
	Month       string          `json:"month,omitempty"`
	Offset      int             `json:"offset"`
	Limit       int             `json:"limit"`
	TotalPlays  int             `json:"totalPlays"`
	TotalTracks int             `json:"totalTracks"`
	HasMore     bool            `json:"hasMore"`
	Rankings    []ranking       `json:"rankings"`
	Periods     periodSummaries `json:"periods"`
}

func parseStatsQuery(r *http.Request) (statsQuery, error) {
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return statsQuery{}, errors.New("malformed query")
	}
	for key, items := range values {
		if key != "period" && key != "year" && key != "month" && key != "offset" && key != "limit" {
			return statsQuery{}, fmt.Errorf("unknown query parameter %q", key)
		}
		if len(items) != 1 {
			return statsQuery{}, fmt.Errorf("duplicate query parameter %q", key)
		}
	}
	query := statsQuery{period: "all", offset: 0, limit: 10}
	if items, ok := values["period"]; ok {
		switch items[0] {
		case "all", "year", "month":
			query.period = items[0]
		default:
			return statsQuery{}, errors.New("invalid period")
		}
	}
	if items, ok := values["offset"]; ok {
		query.offset, err = parseQueryInteger(items[0], 0)
		if err != nil {
			return statsQuery{}, errors.New("invalid offset")
		}
	}
	if items, ok := values["limit"]; ok {
		query.limit, err = parseQueryInteger(items[0], 1)
		if err != nil || query.limit > 100 {
			return statsQuery{}, errors.New("invalid limit")
		}
	}
	if items, ok := values["year"]; ok {
		if len(items[0]) != 4 || !allASCIIDigits(items[0]) {
			return statsQuery{}, errors.New("invalid year")
		}
		query.year = items[0]
	}
	if items, ok := values["month"]; ok {
		if !validMonth(items[0]) {
			return statsQuery{}, errors.New("invalid month")
		}
		query.month = items[0]
	}
	switch query.period {
	case "all":
		if query.year != "" || query.month != "" {
			return statsQuery{}, errors.New("all period forbids year and month")
		}
	case "year":
		if query.year == "" || query.month != "" {
			return statsQuery{}, errors.New("year period requires year and forbids month")
		}
	case "month":
		if query.month == "" || query.year != "" {
			return statsQuery{}, errors.New("month period requires month and forbids year")
		}
	}
	return query, nil
}

func parseQueryInteger(value string, minimum int) (int, error) {
	if value == "" || !allASCIIDigits(value) {
		return 0, errors.New("not a nonnegative integer")
	}
	parsed, err := strconv.ParseUint(value, 10, 64)
	if err != nil || parsed > uint64(^uint(0)>>1) {
		return 0, errors.New("integer out of range")
	}
	result := int(parsed)
	if result < minimum {
		return 0, errors.New("integer below minimum")
	}
	return result, nil
}

func allASCIIDigits(value string) bool {
	if value == "" {
		return false
	}
	for index := range value {
		if value[index] < '0' || value[index] > '9' {
			return false
		}
	}
	return true
}

func validMonth(value string) bool {
	if len(value) != 7 || value[4] != '-' || !allASCIIDigits(value[:4]) || !allASCIIDigits(value[5:]) {
		return false
	}
	month, err := strconv.Atoi(value[5:])
	return err == nil && month >= 1 && month <= 12
}

func (p *playStore) stats(query statsQuery) statsResponse {
	p.mu.RLock()
	defer p.mu.RUnlock()

	response := statsResponse{
		Period:   query.period,
		Year:     query.year,
		Month:    query.month,
		Offset:   query.offset,
		Limit:    query.limit,
		Rankings: make([]ranking, 0),
		Periods: periodSummaries{
			Years:  make([]yearSummary, 0, len(p.years)),
			Months: make([]monthSummary, 0, len(p.months)),
		},
	}
	counts := p.all
	switch query.period {
	case "year":
		counts = p.years[query.year]
	case "month":
		counts = p.months[query.month]
	}
	items := make([]ranking, 0, len(counts))
	for trackID, plays := range counts {
		if plays <= 0 {
			continue
		}
		if _, known := p.catalog[trackID]; !known {
			continue
		}
		items = append(items, ranking{TrackID: trackID, Plays: plays})
		response.TotalPlays += plays
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Plays != items[j].Plays {
			return items[i].Plays > items[j].Plays
		}
		return items[i].TrackID < items[j].TrackID
	})
	response.TotalTracks = len(items)
	rankingCap := response.TotalTracks
	if rankingCap > 100 {
		rankingCap = 100
	}
	start := query.offset
	if start < rankingCap {
		end := start + query.limit
		if end > rankingCap {
			end = rankingCap
		}
		response.Rankings = append(response.Rankings, items[start:end]...)
	}
	response.HasMore = start+len(response.Rankings) < rankingCap

	for year, yearCounts := range p.years {
		plays := 0
		for trackID, count := range yearCounts {
			if _, known := p.catalog[trackID]; known {
				plays += count
			}
		}
		if plays > 0 {
			response.Periods.Years = append(response.Periods.Years, yearSummary{Year: year, Plays: plays})
		}
	}
	for month, monthCounts := range p.months {
		plays := 0
		for trackID, count := range monthCounts {
			if _, known := p.catalog[trackID]; known {
				plays += count
			}
		}
		if plays > 0 {
			response.Periods.Months = append(response.Periods.Months, monthSummary{Month: month, Plays: plays})
		}
	}
	sort.Slice(response.Periods.Years, func(i, j int) bool {
		if response.Periods.Years[i].Plays != response.Periods.Years[j].Plays {
			return response.Periods.Years[i].Plays > response.Periods.Years[j].Plays
		}
		return response.Periods.Years[i].Year > response.Periods.Years[j].Year
	})
	sort.Slice(response.Periods.Months, func(i, j int) bool {
		if response.Periods.Months[i].Plays != response.Periods.Months[j].Plays {
			return response.Periods.Months[i].Plays > response.Periods.Months[j].Plays
		}
		return response.Periods.Months[i].Month > response.Periods.Months[j].Month
	})
	return response
}

func (a *app) servePlay(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !sameSiteRequest(r) {
		http.Error(w, "cross-site request rejected", http.StatusForbidden)
		return
	}
	contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || !strings.EqualFold(contentType, "application/json") {
		http.Error(w, "content type must be application/json", http.StatusUnsupportedMediaType)
		return
	}
	request, err := decodePlayRequest(w, r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if _, known := a.plays.catalog[request.TrackID]; !known {
		http.Error(w, "unknown trackId", http.StatusNotFound)
		return
	}
	if request.SessionID == "" || !utf8.ValidString(request.SessionID) || len([]byte(request.SessionID)) > 128 {
		http.Error(w, "invalid sessionId", http.StatusBadRequest)
		return
	}
	event, counted, err := a.plays.record(request.SessionID, request.TrackID)
	if err != nil {
		if errors.Is(err, errSessionTrackConflict) {
			http.Error(w, "session already recorded for another track", http.StatusConflict)
			return
		}
		http.Error(w, "could not record play", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	status := http.StatusCreated
	if !counted {
		status = http.StatusOK
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(struct {
		TrackID   string `json:"trackId"`
		SessionID string `json:"sessionId"`
		PlayedAt  string `json:"playedAt"`
		Counted   bool   `json:"counted"`
	}{event.TrackID, event.SessionID, event.PlayedAt, counted})
}

func decodePlayRequest(w http.ResponseWriter, r *http.Request) (playRequest, error) {
	limited := http.MaxBytesReader(w, r.Body, maxPlayBodyBytes+1)
	body, err := io.ReadAll(limited)
	if err != nil || len(body) > maxPlayBodyBytes {
		return playRequest{}, errors.New("request body is too large or unreadable")
	}
	if !utf8.Valid(body) {
		return playRequest{}, errors.New("request body is not valid UTF-8")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	var request playRequest
	if err := decodeStrictObject(decoder, map[string]func(json.RawMessage) error{
		"trackId": func(raw json.RawMessage) error {
			return decodeJSONString(raw, &request.TrackID)
		},
		"sessionId": func(raw json.RawMessage) error {
			return decodeJSONString(raw, &request.SessionID)
		},
	}); err != nil {
		return playRequest{}, errors.New("request must be one strict JSON object")
	}
	if err := requireJSONEOF(decoder); err != nil {
		return playRequest{}, errors.New("request must contain exactly one JSON object")
	}
	return request, nil
}

func sameSiteRequest(r *http.Request) bool {
	if fetchSite := strings.ToLower(strings.TrimSpace(r.Header.Get("Sec-Fetch-Site"))); fetchSite == "cross-site" {
		return false
	}
	for _, header := range []string{"Origin", "Referer"} {
		value := strings.TrimSpace(r.Header.Get(header))
		if value == "" {
			continue
		}
		parsed, err := url.Parse(value)
		if err != nil || parsed.User != nil || parsed.Scheme == "" || parsed.Host == "" || !strings.EqualFold(parsed.Host, r.Host) {
			return false
		}
	}
	return true
}

func (a *app) serveStats(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	query, err := parseStatsQuery(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(a.plays.stats(query))
}
