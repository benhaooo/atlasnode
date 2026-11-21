package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
	"time"
)

type AuthStore struct {
	PasswordHash  string `json:"passwordHash"`
	SessionSecret string `json:"sessionSecret"`
	UpdatedAt     string `json:"updatedAt"`
}

var (
	dataDir   string
	storeLock sync.RWMutex
	reSafeID  = regexp.MustCompile(`[^a-zA-Z0-9_-]`)
)

func getDataDir() string {
	if dataDir != "" {
		return dataDir
	}
	if env := os.Getenv("ATLASNODE_DATA_DIR"); env != "" {
		dataDir = env
	} else {
		cwd, _ := os.Getwd()
		dataDir = filepath.Join(cwd, "data")
	}
	return dataDir
}

func initStore() error {
	d := getDataDir()
	if err := os.MkdirAll(d, 0o755); err != nil {
		return err
	}
	return os.MkdirAll(filepath.Join(d, "nodequality"), 0o755)
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func writeJSONAtomic(filePath string, data any) error {
	if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	tmp := filePath + "." + randomHex(4) + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filePath)
}

func readJSON(filePath string, dst any) bool {
	raw, err := os.ReadFile(filePath)
	if err != nil {
		return false
	}
	return json.Unmarshal(raw, dst) == nil
}

func sanitizeID(input string) string {
	return reSafeID.ReplaceAllString(input, "_")
}

func loadAuth() *AuthStore {
	storeLock.RLock()
	defer storeLock.RUnlock()
	var a AuthStore
	if !readJSON(filepath.Join(getDataDir(), "auth.json"), &a) {
		return nil
	}
	return &a
}

func saveAuth(a AuthStore) error {
	storeLock.Lock()
	defer storeLock.Unlock()
	return writeJSONAtomic(filepath.Join(getDataDir(), "auth.json"), a)
}

func loadServers() []ServerConfig {
	storeLock.RLock()
	var list []ServerConfig
	ok := readJSON(filepath.Join(getDataDir(), "servers.json"), &list)
	storeLock.RUnlock()
	if ok && list != nil {
		for i := range list {
			if list[i].Tags == nil {
				list[i].Tags = []string{}
			}
			if list[i].QuickLinks == nil {
				list[i].QuickLinks = []QuickLink{}
			}
		}
		return list
	}
	defaults := defaultServers()
	_ = saveServers(defaults)
	return defaults
}

func saveServers(servers []ServerConfig) error {
	storeLock.Lock()
	defer storeLock.Unlock()
	return writeJSONAtomic(filepath.Join(getDataDir(), "servers.json"), servers)
}

func getServerByID(id string) *ServerConfig {
	for _, s := range loadServers() {
		if s.ID == id {
			cp := s
			return &cp
		}
	}
	return nil
}

func upsertServer(srv ServerConfig) []ServerConfig {
	list := loadServers()
	found := false
	for i := range list {
		if list[i].ID == srv.ID {
			list[i] = srv
			found = true
			break
		}
	}
	if !found {
		list = append(list, srv)
	}
	_ = saveServers(list)
	return list
}

func deleteServerByID(id string) []ServerConfig {
	list := loadServers()
	out := make([]ServerConfig, 0, len(list))
	for _, s := range list {
		if s.ID != id {
			out = append(out, s)
		}
	}
	_ = saveServers(out)
	return out
}

func saveNodeQualityRun(run NodeQualityRun) error {
	storeLock.Lock()
	defer storeLock.Unlock()
	dir := filepath.Join(getDataDir(), "nodequality", sanitizeID(run.ServerID))
	return writeJSONAtomic(filepath.Join(dir, sanitizeID(run.ID)+".json"), run)
}

func listNodeQualityRuns(serverID string) []NodeQualityRun {
	storeLock.RLock()
	defer storeLock.RUnlock()
	dir := filepath.Join(getDataDir(), "nodequality", sanitizeID(serverID))
	entries, err := os.ReadDir(dir)
	if err != nil {
		return []NodeQualityRun{}
	}
	runs := make([]NodeQualityRun, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		var r NodeQualityRun
		if readJSON(filepath.Join(dir, e.Name()), &r) {
			runs = append(runs, r)
		}
	}
	sort.Slice(runs, func(i, j int) bool {
		ti, _ := time.Parse(time.RFC3339, runs[i].StartedAt)
		tj, _ := time.Parse(time.RFC3339, runs[j].StartedAt)
		return ti.After(tj)
	})
	return runs
}

func getNodeQualityRun(serverID, runID string) *NodeQualityRun {
	storeLock.RLock()
	defer storeLock.RUnlock()
	p := filepath.Join(getDataDir(), "nodequality", sanitizeID(serverID), sanitizeID(runID)+".json")
	var r NodeQualityRun
	if !readJSON(p, &r) {
		return nil
	}
	return &r
}

func getLatestNodeQualityRun(serverID string) *NodeQualityRun {
	runs := listNodeQualityRuns(serverID)
	for i := range runs {
		if runs[i].Status == "completed" {
			return &runs[i]
		}
	}
	if len(runs) > 0 {
		return &runs[0]
	}
	return nil
}

func deleteNodeQualityRun(serverID, runID string) bool {
	storeLock.Lock()
	defer storeLock.Unlock()
	p := filepath.Join(getDataDir(), "nodequality", sanitizeID(serverID), sanitizeID(runID)+".json")
	if err := os.Remove(p); err != nil {
		return false
	}
	return true
}

func defaultServers() []ServerConfig {
	now := time.Now().UTC().Format(time.RFC3339)
	hostname, _ := os.Hostname()
	if hostname == "" {
		hostname = "local-host"
	}
	return []ServerConfig{
		{
			ID:         "local-host",
			Name:       hostname,
			Role:       "Control Plane (Local)",
			Notes:      "",
			Tags:       []string{"Control Plane"},
			Mode:       "local",
			Host:       "127.0.0.1",
			Port:       22,
			Username:   "root",
			UseSudo:    false,
			QuickLinks: []QuickLink{},
			CreatedAt:  now,
		},
	}
}
