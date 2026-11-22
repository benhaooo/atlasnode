package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	processStartedAt = time.Now()
	snapshotCache    = NewTtlCache[ServerSnapshot](8 * time.Second)
	reSlug           = regexp.MustCompile(`[^a-z0-9-]+`)
)

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func readProcessRSSBytes() uint64 {
	if raw, err := os.ReadFile("/proc/self/statm"); err == nil {
		fields := strings.Fields(string(raw))
		if len(fields) >= 2 {
			if pages, err2 := strconv.ParseUint(fields[1], 10, 64); err2 == nil {
				return pages * uint64(os.Getpagesize())
			}
		}
	}
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	return ms.Sys
}

func main() {
	if err := initStore(); err != nil {
		log.Fatalf("init store: %v", err)
	}
	if err := initMetricsDB(); err != nil {
		log.Fatalf("init metrics db: %v", err)
	}
	if err := initNetworkDB(); err != nil {
		log.Fatalf("init network db: %v", err)
	}
	startBackgroundSampler(60 * time.Second)
	startNetworkProbeSampler(60 * time.Second)
	startAutoNodeQualityScheduler()
	initialPassword := ensureAuthInitialized()

	mux := http.NewServeMux()

	// Auth
	mux.HandleFunc("GET /api/auth/status", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"authenticated": isRequestAuthenticated(r)})
	})
	mux.HandleFunc("POST /api/auth/login", handleLogin)
	mux.HandleFunc("POST /api/auth/logout", handleLogout)
	mux.HandleFunc("POST /api/auth/password", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			CurrentPassword string `json:"currentPassword"`
			NewPassword     string `json:"newPassword"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		ok, errMsg := changePassword(body.CurrentPassword, body.NewPassword)
		if !ok {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": errMsg})
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}))

	// Manager key & runtime
	mux.HandleFunc("GET /api/manager-key", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"publicKey": getManagerPublicKey()})
	}))
	mux.HandleFunc("GET /api/system/runtime", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"pool":           getPoolStats(),
			"metricsDb":      getDBStats(),
			"memoryRssBytes": readProcessRSSBytes(),
			"uptimeSeconds":  int(time.Since(processStartedAt).Seconds()),
		})
	}))

	// Fleet & Server CRUD
	mux.HandleFunc("GET /api/servers", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"servers": loadServers()})
	}))

	mux.HandleFunc("GET /api/fleet/snapshots", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		fresh := r.URL.Query().Get("fresh") == "1"
		servers := loadServers()
		snaps := make([]ServerSnapshot, len(servers))
		var wg sync.WaitGroup
		for i, s := range servers {
			wg.Add(1)
			go func(idx int, srv ServerConfig) {
				defer wg.Done()
				snap, _ := snapshotCache.GetOrLoad(srv.ID, fresh, func() (ServerSnapshot, error) {
					return collectServerSnapshot(srv, getActiveNodeQualityJob(srv.ID)), nil
				})
				snaps[idx] = snap
			}(i, s)
		}
		wg.Wait()
		writeJSON(w, http.StatusOK, map[string]any{"snapshots": snaps})
	}))

	mux.HandleFunc("POST /api/servers", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ID          string          `json:"id"`
			Name        string          `json:"name"`
			Role        string          `json:"role"`
			Notes       *string         `json:"notes"`
			Tags        []string        `json:"tags"`
			Region      string          `json:"region"`
			Mode        string          `json:"mode"`
			Host        string          `json:"host"`
			Port        int             `json:"port"`
			Username    string          `json:"username"`
			UseSudo     bool            `json:"useSudo"`
			PublicIP    string          `json:"publicIp"`
			TailscaleIP string          `json:"tailscaleIp"`
			JumpHost     *JumpHostConfig `json:"jumpHost"`
			QuickLinks   []QuickLink     `json:"quickLinks"`
			ProxyEnabled *bool           `json:"proxyEnabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		name := strings.TrimSpace(body.Name)
		host := strings.TrimSpace(body.Host)
		if name == "" || host == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "服务器名称和地址不能为空"})
			return
		}
		id := strings.TrimSpace(body.ID)
		if id == "" {
			id = reSlug.ReplaceAllString(strings.ToLower(name), "-")
			if id == "" {
				id = randomHex(4)
			}
		}
		existing := getServerByID(id)
		mode := "ssh"
		if body.Mode == "local" {
			mode = "local"
		}
		port := body.Port
		if port <= 0 {
			port = 22
		}
		user := strings.TrimSpace(body.Username)
		if user == "" {
			user = "root"
		}
		role := strings.TrimSpace(body.Role)
		if role == "" && existing != nil {
			role = existing.Role
		}
		if role == "" {
			role = "Linux 服务器"
		}
		notes := ""
		if body.Notes != nil {
			notes = strings.TrimSpace(*body.Notes)
		} else if existing != nil {
			notes = existing.Notes
		}
		tags := []string{}
		if body.Tags != nil {
			for _, t := range body.Tags {
				if tt := strings.TrimSpace(t); tt != "" {
					tags = append(tags, tt)
				}
			}
		} else if existing != nil {
			tags = existing.Tags
		}
		var jh *JumpHostConfig
		if body.JumpHost != nil && strings.TrimSpace(body.JumpHost.Host) != "" {
			jp := body.JumpHost.Port
			if jp <= 0 {
				jp = 22
			}
			ju := strings.TrimSpace(body.JumpHost.Username)
			if ju == "" {
				ju = "root"
			}
			jh = &JumpHostConfig{Host: strings.TrimSpace(body.JumpHost.Host), Port: jp, Username: ju}
		}
		ql := []QuickLink{}
		if body.QuickLinks != nil {
			ql = body.QuickLinks
		} else if existing != nil {
			ql = existing.QuickLinks
		}
		createdAt := time.Now().UTC().Format(time.RFC3339)
		if existing != nil && existing.CreatedAt != "" {
			createdAt = existing.CreatedAt
		}
		srv := ServerConfig{
			ID:          id,
			Name:        name,
			Role:        role,
			Notes:       notes,
			Tags:        tags,
			Region:      firstNonEmpty(body.Region, func() string { if existing != nil { return existing.Region }; return "" }()),
			Mode:        mode,
			Host:        host,
			Port:        port,
			Username:    user,
			UseSudo:     body.UseSudo,
			PublicIP:    firstNonEmpty(body.PublicIP, func() string { if existing != nil { return existing.PublicIP }; return "" }()),
			TailscaleIP: firstNonEmpty(body.TailscaleIP, func() string { if existing != nil { return existing.TailscaleIP }; return "" }()),
			JumpHost:     jh,
			QuickLinks:   ql,
			TrafficPlan:  func() *TrafficPlan { if existing != nil { return existing.TrafficPlan }; return nil }(),
			ProxyEnabled: func() *bool { if body.ProxyEnabled != nil { return body.ProxyEnabled }; if existing != nil { return existing.ProxyEnabled }; return nil }(),
			CreatedAt:    createdAt,
		}
		upsertServer(srv)
		writeJSON(w, http.StatusOK, map[string]any{"server": srv})
	}))

	mux.HandleFunc("PUT /api/servers/{id}", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		existing := getServerByID(r.PathValue("id"))
		if existing == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		var body map[string]json.RawMessage
		_ = json.NewDecoder(r.Body).Decode(&body)
		updated := *existing
		if v, ok := body["name"]; ok {
			var s string
			if json.Unmarshal(v, &s) == nil {
				updated.Name = strings.TrimSpace(s)
			}
		}
		if v, ok := body["role"]; ok {
			var s string
			if json.Unmarshal(v, &s) == nil {
				updated.Role = strings.TrimSpace(s)
			}
		}
		if v, ok := body["notes"]; ok {
			var s string
			if json.Unmarshal(v, &s) == nil {
				updated.Notes = strings.TrimSpace(s)
			}
		}
		if v, ok := body["tags"]; ok {
			var t []string
			if json.Unmarshal(v, &t) == nil {
				clean := []string{}
				for _, x := range t {
					if s := strings.TrimSpace(x); s != "" {
						clean = append(clean, s)
					}
				}
				updated.Tags = clean
			}
		}
		if v, ok := body["region"]; ok {
			var s string
			if json.Unmarshal(v, &s) == nil {
				updated.Region = strings.TrimSpace(s)
			}
		}
		if v, ok := body["host"]; ok {
			var s string
			if json.Unmarshal(v, &s) == nil {
				updated.Host = strings.TrimSpace(s)
			}
		}
		if v, ok := body["port"]; ok {
			var p int
			if json.Unmarshal(v, &p) == nil && p > 0 {
				updated.Port = p
			}
		}
		if v, ok := body["username"]; ok {
			var s string
			if json.Unmarshal(v, &s) == nil {
				updated.Username = strings.TrimSpace(s)
			}
		}
		if v, ok := body["useSudo"]; ok {
			var b bool
			if json.Unmarshal(v, &b) == nil {
				updated.UseSudo = b
			}
		}
		if v, ok := body["publicIp"]; ok {
			var s string
			if json.Unmarshal(v, &s) == nil {
				updated.PublicIP = strings.TrimSpace(s)
			}
		}
		if v, ok := body["tailscaleIp"]; ok {
			var s string
			if json.Unmarshal(v, &s) == nil {
				updated.TailscaleIP = strings.TrimSpace(s)
			}
		}
		if v, ok := body["jumpHost"]; ok {
			var jh JumpHostConfig
			if json.Unmarshal(v, &jh) == nil && strings.TrimSpace(jh.Host) != "" {
				if jh.Port <= 0 {
					jh.Port = 22
				}
				if jh.Username == "" {
					jh.Username = "root"
				}
				updated.JumpHost = &jh
			} else {
				updated.JumpHost = nil
			}
		}
		if v, ok := body["quickLinks"]; ok {
			var ql []QuickLink
			if json.Unmarshal(v, &ql) == nil {
				updated.QuickLinks = ql
			}
		}
		if v, ok := body["proxyEnabled"]; ok {
			if strings.TrimSpace(string(v)) == "null" {
				updated.ProxyEnabled = nil
			} else {
				var b bool
				if json.Unmarshal(v, &b) == nil {
					updated.ProxyEnabled = &b
				}
			}
		}
		if v, ok := body["trafficPlan"]; ok {
			if strings.TrimSpace(string(v)) == "null" {
				updated.TrafficPlan = nil
			} else {
				var tp TrafficPlan
				if json.Unmarshal(v, &tp) == nil {
					norm := normalizeTrafficPlan(&tp)
					updated.TrafficPlan = &norm
				}
			}
		}
		upsertServer(updated)
		snapshotCache.Invalidate(updated.ID)
		writeJSON(w, http.StatusOK, map[string]any{"server": updated})
	}))

	mux.HandleFunc("PUT /api/servers/{id}/traffic-plan", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		existing := getServerByID(r.PathValue("id"))
		if existing == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		var body struct {
			BandwidthMbps   int      `json:"bandwidthMbps"`
			MonthlyQuotaGB  float64  `json:"monthlyQuotaGb"`
			BillingMode     string   `json:"billingMode"`
			ResetDay        int      `json:"resetDay"`
			CalibrateUsedGB *float64 `json:"calibrateUsedGb"`
			ClearBaseline   bool     `json:"clearBaseline"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "无效的流量套餐参数"})
			return
		}
		prev := normalizeTrafficPlan(existing.TrafficPlan)
		next := normalizeTrafficPlan(&TrafficPlan{
			BandwidthMbps:    body.BandwidthMbps,
			MonthlyQuotaGB:   body.MonthlyQuotaGB,
			BillingMode:      body.BillingMode,
			ResetDay:         body.ResetDay,
			BaselineGB:       prev.BaselineGB,
			BaselineCycleKey: prev.BaselineCycleKey,
		})
		if body.ClearBaseline {
			next.BaselineGB = 0
			next.BaselineCycleKey = ""
		}
		if body.CalibrateUsedGB != nil && *body.CalibrateUsedGB >= 0 {
			// Compute tracked usage in the target billing cycle/mode without baseline, then store exact delta
			tempSrv := *existing
			noBase := next
			noBase.BaselineGB = 0
			noBase.BaselineCycleKey = ""
			tempSrv.TrafficPlan = &noBase
			ts := getServerTrafficSummary(tempSrv)
			trackedGB := float64(ts.BilledBytes) / bytesPerGB
			delta := *body.CalibrateUsedGB - trackedGB
			if delta < 0 {
				delta = 0
			}
			next.BaselineGB = round2(delta)
			next.BaselineCycleKey = ts.CycleStart
		}
		updated := *existing
		if next.BandwidthMbps == 0 && next.MonthlyQuotaGB == 0 && next.BaselineGB == 0 && next.BillingMode == "both" && next.ResetDay == 1 {
			updated.TrafficPlan = nil
		} else {
			updated.TrafficPlan = &next
		}
		upsertServer(updated)
		snapshotCache.Invalidate(updated.ID)
		writeJSON(w, http.StatusOK, map[string]any{
			"server":         updated,
			"trafficSummary": getServerTrafficSummary(updated),
		})
	}))

	mux.HandleFunc("DELETE /api/servers/{id}", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		existing := getServerByID(r.PathValue("id"))
		if existing == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		if existing.Mode == "local" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "不能删除当前管控主机"})
			return
		}
		deleteServerByID(existing.ID)
		snapshotCache.Invalidate(existing.ID)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}))

	mux.HandleFunc("POST /api/servers/test", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Mode     string          `json:"mode"`
			Host     string          `json:"host"`
			Port     int             `json:"port"`
			Username string          `json:"username"`
			UseSudo  bool            `json:"useSudo"`
			JumpHost *JumpHostConfig `json:"jumpHost"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mode := "ssh"
		if body.Mode == "local" {
			mode = "local"
		}
		port := body.Port
		if port <= 0 {
			port = 22
		}
		user := strings.TrimSpace(body.Username)
		if user == "" {
			user = "root"
		}
		temp := ServerConfig{
			ID:       "test",
			Name:     "test",
			Mode:     mode,
			Host:     strings.TrimSpace(body.Host),
			Port:     port,
			Username: user,
			UseSudo:  body.UseSudo,
			JumpHost: body.JumpHost,
		}
		writeJSON(w, http.StatusOK, testServerConnection(temp))
	}))

	mux.HandleFunc("GET /api/tailscale/peers", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		src, peers := discoverTailscalePeers(loadServers())
		writeJSON(w, http.StatusOK, map[string]any{"source": src, "peers": peers})
	}))

	// Snapshot, history, live metrics & SSE stream
	mux.HandleFunc("GET /api/servers/{id}/snapshot", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		fresh := r.URL.Query().Get("fresh") == "1"
		snap, _ := snapshotCache.GetOrLoad(srv.ID, fresh, func() (ServerSnapshot, error) {
			return collectServerSnapshot(*srv, getActiveNodeQualityJob(srv.ID)), nil
		})
		writeJSON(w, http.StatusOK, map[string]any{"snapshot": snap})
	}))

	mux.HandleFunc("GET /api/servers/{id}/history", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		rng := r.URL.Query().Get("range")
		writeJSON(w, http.StatusOK, queryMetricHistory(srv.ID, rng))
	}))

	mux.HandleFunc("GET /api/servers/{id}/metrics", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		m, err := collectSingleMetrics(*srv)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"metrics": m})
	}))

	mux.HandleFunc("GET /api/servers/{id}/stream", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache, no-transform")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")
		flusher.Flush()

		proc, err := spawnMetricsStream(*srv)
		if err != nil {
			_, _ = fmt.Fprintf(w, "event: warn\ndata: %s\n\n", mustJSON(map[string]string{"message": err.Error()}))
			flusher.Flush()
			return
		}
		defer proc.Kill()

		var writeMu sync.Mutex
		done := make(chan struct{})

		go func() {
			<-r.Context().Done()
			proc.Kill()
		}()

		go func() {
			ticker := time.NewTicker(15 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-done:
					return
				case <-r.Context().Done():
					return
				case <-ticker.C:
					writeMu.Lock()
					_, _ = w.Write([]byte(": ping\n\n"))
					flusher.Flush()
					writeMu.Unlock()
				}
			}
		}()

		go func() {
			sc := bufio.NewScanner(proc.Stderr)
			for sc.Scan() {
				msg := strings.TrimSpace(sc.Text())
				if msg == "" {
					continue
				}
				writeMu.Lock()
				_, _ = fmt.Fprintf(w, "event: warn\ndata: %s\n\n", mustJSON(map[string]string{"message": msg}))
				flusher.Flush()
				writeMu.Unlock()
			}
		}()

		sc := bufio.NewScanner(proc.Stdout)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" {
				continue
			}
			writeMu.Lock()
			_, _ = fmt.Fprintf(w, "event: metrics\ndata: %s\n\n", line)
			flusher.Flush()
			writeMu.Unlock()
		}
		_ = proc.Wait()
		close(done)
		writeMu.Lock()
		_, _ = w.Write([]byte("event: end\ndata: {}\n\n"))
		flusher.Flush()
		writeMu.Unlock()
	}))

	// Quick IP probe
	mux.HandleFunc("GET /api/servers/{id}/ip-probe", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"probe": runQuickIPProbe(*srv)})
	}))

	// Docker & Systemd
	mux.HandleFunc("GET /api/servers/{id}/services", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		data, err := collectServicesDetail(*srv)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, data)
	}))

	mux.HandleFunc("POST /api/servers/{id}/docker/{containerId}/{action}", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		action := r.PathValue("action")
		if action == "remove" {
			var body struct {
				RemoveVolumes bool `json:"removeVolumes"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			out, err := runDockerRemove(*srv, r.PathValue("containerId"), body.RemoveVolumes)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			snapshotCache.Invalidate(srv.ID)
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "output": out})
			return
		}
		if action != "start" && action != "stop" && action != "restart" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "不支持的操作"})
			return
		}
		out, err := runDockerAction(*srv, r.PathValue("containerId"), action)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		snapshotCache.Invalidate(srv.ID)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "output": out})
	}))

	mux.HandleFunc("GET /api/servers/{id}/docker/{containerId}/logs", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		tail, _ := strconv.Atoi(r.URL.Query().Get("tail"))
		if tail == 0 {
			tail = 180
		}
		logs, err := getDockerLogs(*srv, r.PathValue("containerId"), tail)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"logs": logs})
	}))

	mux.HandleFunc("GET /api/servers/{id}/systemd/{unit}/logs", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		lines, _ := strconv.Atoi(r.URL.Query().Get("lines"))
		if lines == 0 {
			lines = 120
		}
		logs, err := getSystemdLogs(*srv, r.PathValue("unit"), lines)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"logs": logs})
	}))

	mux.HandleFunc("POST /api/servers/{id}/systemd/{unit}/{action}", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		action := r.PathValue("action")
		if action != "start" && action != "stop" && action != "restart" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "不支持的操作"})
			return
		}
		if err := runSystemdAction(*srv, r.PathValue("unit"), action); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}))

	// NodeQuality
	mux.HandleFunc("GET /api/servers/{id}/nodequality", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		rawRuns := listNodeQualityRuns(srv.ID)
		runs := make([]NodeQualityRunLight, 0, len(rawRuns))
		for _, raw := range rawRuns {
			rr := raw
			if raw.Status == "completed" {
				rr = reparseNodeQualityRun(raw, *srv)
			}
			runs = append(runs, NodeQualityRunLight{
				ID:         rr.ID,
				ServerID:   rr.ServerID,
				Mode:       rr.Mode,
				Status:     rr.Status,
				StartedAt:  rr.StartedAt,
				FinishedAt: rr.FinishedAt,
				Phase:      rr.Phase,
				ReportURL:  rr.ReportURL,
				Error:      rr.Error,
				Summary:    rr.Summary,
			})
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"runs":      runs,
			"activeJob": getActiveNodeQualityJob(srv.ID),
		})
	}))

	mux.HandleFunc("GET /api/servers/{id}/nodequality/stream", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache, no-transform")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")
		flusher.Flush()

		active := getActiveNodeQualityJob(srv.ID)
		if active == nil {
			_, _ = w.Write([]byte("event: idle\ndata: {}\n\n"))
			flusher.Flush()
			return
		}
		backlog := active.LogLines
		if len(backlog) > 200 {
			backlog = backlog[len(backlog)-200:]
		}
		_, _ = fmt.Fprintf(w, "event: init\ndata: %s\n\n", mustJSON(map[string]any{
			"id":        active.ID,
			"mode":      active.Mode,
			"phase":     active.Phase,
			"startedAt": active.StartedAt,
			"lines":     backlog,
		}))
		flusher.Flush()

		ch, unsub := subscribeNodeQualityJob(srv.ID)
		if ch == nil {
			return
		}
		defer unsub()

		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case <-ticker.C:
				_, _ = w.Write([]byte(": ping\n\n"))
				flusher.Flush()
			case ev := <-ch:
				_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.Type, mustJSON(ev.Data))
				flusher.Flush()
				if ev.Type == "done" {
					return
				}
			}
		}
	}))

	mux.HandleFunc("GET /api/servers/{id}/nodequality/{runId}", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		raw := getNodeQualityRun(r.PathValue("id"), r.PathValue("runId"))
		if srv == nil || raw == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "未找到测试记录"})
			return
		}
		run := *raw
		if run.Status == "completed" {
			run = reparseNodeQualityRun(run, *srv)
		}
		writeJSON(w, http.StatusOK, map[string]any{"run": run})
	}))

	mux.HandleFunc("POST /api/servers/{id}/nodequality/run", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		var body struct {
			Mode string `json:"mode"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mode := body.Mode
		if mode != "fast" && mode != "full" && mode != "ip_hw" && mode != "net" {
			mode = "fast"
		}
		run, err := startNodeQualityJob(*srv, mode)
		if err != nil {
			writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"run": run})
	}))

	mux.HandleFunc("POST /api/servers/{id}/nodequality/cancel", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": cancelNodeQualityJob(r.PathValue("id"))})
	}))

	mux.HandleFunc("DELETE /api/servers/{id}/nodequality/{runId}", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": deleteNodeQualityRun(r.PathValue("id"), r.PathValue("runId"))})
	}))

	// Firewall (UFW + nftables)
	mux.HandleFunc("GET /api/servers/{id}/firewall", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		fw, err := collectFirewall(*srv)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"firewall": fw})
	}))

	mux.HandleFunc("POST /api/servers/{id}/firewall/ufw/add", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		var body struct {
			Port    string `json:"port"`
			Proto   string `json:"proto"`
			Action  string `json:"action"`
			From    string `json:"from"`
			Comment string `json:"comment"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		out, err := addUfwRule(*srv, body.Port, body.Proto, body.Action, body.From, body.Comment)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		snapshotCache.Invalidate(srv.ID)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "output": out})
	}))

	mux.HandleFunc("POST /api/servers/{id}/firewall/ufw/delete", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		var body struct {
			Num int `json:"num"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		out, err := deleteUfwRule(*srv, body.Num)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		snapshotCache.Invalidate(srv.ID)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "output": out})
	}))

	mux.HandleFunc("POST /api/servers/{id}/firewall/ufw/toggle", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		var body struct {
			Enable bool `json:"enable"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		out, err := toggleUfw(*srv, body.Enable)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		snapshotCache.Invalidate(srv.ID)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "output": out})
	}))

	mux.HandleFunc("POST /api/servers/{id}/firewall/nft/add", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		var body struct {
			Table   string `json:"table"`
			Chain   string `json:"chain"`
			Port    string `json:"port"`
			Proto   string `json:"proto"`
			Comment string `json:"comment"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		out, err := addNftPortRule(*srv, body.Table, body.Chain, body.Port, body.Proto, body.Comment)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		snapshotCache.Invalidate(srv.ID)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "output": out})
	}))

	mux.HandleFunc("POST /api/servers/{id}/firewall/nft/delete", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		var body struct {
			Table  string `json:"table"`
			Chain  string `json:"chain"`
			Handle int    `json:"handle"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		out, err := deleteNftRule(*srv, body.Table, body.Chain, body.Handle)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		snapshotCache.Invalidate(srv.ID)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "output": out})
	}))

	// Files
	mux.HandleFunc("GET /api/servers/{id}/files/list", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		p, entries, err := listDirectory(*srv, r.URL.Query().Get("path"))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"path": p, "entries": entries})
	}))

	mux.HandleFunc("GET /api/servers/{id}/files/read", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		f, err := readFilePreview(*srv, r.URL.Query().Get("path"))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, f)
	}))

	mux.HandleFunc("POST /api/servers/{id}/files/write", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		var body struct {
			Path    string `json:"path"`
			Content string `json:"content"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if err := writeFileContent(*srv, body.Path, body.Content); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}))

	mux.HandleFunc("POST /api/servers/{id}/files/upload", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		var body struct {
			Path   string `json:"path"`
			Base64 string `json:"base64"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if err := uploadFileBase64(*srv, body.Path, body.Base64); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}))

	mux.HandleFunc("POST /api/servers/{id}/files/upload-stream", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		target := r.URL.Query().Get("path")
		if !strings.HasPrefix(target, "/") {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "目标路径必须以 / 开头"})
			return
		}
		if err := writeRemoteStream(*srv, target, r.Body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}))

	mux.HandleFunc("GET /api/servers/{id}/files/download", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		target := r.URL.Query().Get("path")
		stream, err := openDownloadStream(*srv, target)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		defer stream.Close()
		filename := filepath.Base(target)
		if filename == "" || filename == "/" || filename == "." {
			filename = "download"
		}
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, url.PathEscape(filename)))
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = io.Copy(w, stream)
	}))

	mux.HandleFunc("POST /api/servers/{id}/files/mkdir", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		var body struct {
			Path string `json:"path"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if err := createRemoteDirectory(*srv, body.Path); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}))

	mux.HandleFunc("POST /api/servers/{id}/files/delete", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		var body struct {
			Path string `json:"path"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if err := deleteRemotePath(*srv, body.Path); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}))

	// SSH Keys
	mux.HandleFunc("GET /api/servers/{id}/keys", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		info, err := collectSshKeys(*srv)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, info)
	}))

	mux.HandleFunc("POST /api/servers/{id}/keys/add", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		var body struct {
			PublicKey string `json:"publicKey"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if err := addSshKey(*srv, body.PublicKey); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}))

	mux.HandleFunc("POST /api/servers/{id}/keys/delete", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		var body struct {
			Index int `json:"index"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if err := removeSshKey(*srv, body.Index); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}))

	mux.HandleFunc("POST /api/keys/sync-all", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			PublicKey string `json:"publicKey"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		pk := strings.TrimSpace(body.PublicKey)
		if pk == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "公钥不能为空"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"results": syncSshKeyToAllServers(loadServers(), pk)})
	}))

	// Proxies, Assets, Docker Prune, Compose, Mesh, Alerts
	mux.HandleFunc("GET /api/servers/{id}/proxies", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		routes, err := collectProxyRoutes(*srv)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"routes": routes})
	}))

	mux.HandleFunc("GET /api/servers/{id}/assets", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		assets, err := collectDiskAndAssets(*srv)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"assets": assets})
	}))

	mux.HandleFunc("POST /api/servers/{id}/docker-prune", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		var body struct {
			Target string `json:"target"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		target := body.Target
		if target != "images" && target != "builder" && target != "containers" {
			target = "images"
		}
		out, err := pruneDockerSpace(*srv, target)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		snapshotCache.Invalidate(srv.ID)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "output": out})
	}))

	mux.HandleFunc("GET /api/servers/{id}/compose/file", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		dir := r.URL.Query().Get("dir")
		fp, err := findComposeFile(*srv, dir)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		f, err := readFilePreview(*srv, fp)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, f)
	}))

	mux.HandleFunc("POST /api/servers/{id}/compose/action", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		var body struct {
			Dir           string `json:"dir"`
			Project       string `json:"project"`
			Action        string `json:"action"`
			RemoveVolumes bool   `json:"removeVolumes"`
			RemoveDir     bool   `json:"removeDir"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		dir := strings.TrimSpace(body.Dir)
		project := strings.TrimSpace(body.Project)
		if !strings.HasPrefix(dir, "/") && project == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "非法的 Compose 目录或项目名"})
			return
		}
		action := body.Action
		if action != "pull_up" && action != "up" && action != "restart" && action != "stop" && action != "remove" {
			action = "up"
		}
		proc, err := spawnComposeAction(*srv, dir, project, action, body.RemoveVolumes, body.RemoveDir)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		defer proc.Kill()

		flusher, _ := w.(http.Flusher)
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		if flusher != nil {
			flusher.Flush()
		}

		var wmu sync.Mutex
		pump := func(rd io.Reader) {
			buf := make([]byte, 4096)
			for {
				n, err := rd.Read(buf)
				if n > 0 {
					wmu.Lock()
					_, _ = w.Write(buf[:n])
					if flusher != nil {
						flusher.Flush()
					}
					wmu.Unlock()
				}
				if err != nil {
					return
				}
			}
		}

		go func() {
			<-r.Context().Done()
			proc.Kill()
		}()

		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); pump(proc.Stdout) }()
		go func() { defer wg.Done(); pump(proc.Stderr) }()
		code := proc.Wait()
		wg.Wait()

		snapshotCache.Invalidate(srv.ID)
		wmu.Lock()
		_, _ = fmt.Fprintf(w, "\n[AtlasNode] 执行完成 (exit=%d)\n", code)
		if flusher != nil {
			flusher.Flush()
		}
		wmu.Unlock()
	}))

	mux.HandleFunc("POST /api/fleet/mesh-latency", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		matrix, testedAt := measureMeshLatency(loadServers())
		writeJSON(w, http.StatusOK, map[string]any{"matrix": matrix, "testedAt": testedAt})
	}))

	mux.HandleFunc("GET /api/alerts/config", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"config":  loadAlertConfig(),
			"history": loadAlertHistory(),
		})
	}))

	mux.HandleFunc("PUT /api/alerts/config", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Config *AlertConfig `json:"config"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Config == nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "无效的告警配置"})
			return
		}
		_ = saveAlertConfig(*body.Config)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "config": loadAlertConfig()})
	}))

	mux.HandleFunc("POST /api/alerts/test", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Config *AlertConfig `json:"config"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		cfg := loadAlertConfig()
		if body.Config != nil {
			cfg = *body.Config
		}
		ok, details := sendTestAlert(cfg)
		writeJSON(w, http.StatusOK, map[string]any{"ok": ok, "details": details})
	}))

	// Network Profile & Continuous Peak/Stability Monitor
	mux.HandleFunc("GET /api/servers/{id}/network/profile", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		profile, err := collectNetworkProfile(*srv)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"profile": profile})
	}))

	mux.HandleFunc("GET /api/servers/{id}/network/monitor", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		rng := r.URL.Query().Get("range")
		writeJSON(w, http.StatusOK, queryNetworkMonitor(srv.ID, rng))
	}))

	mux.HandleFunc("POST /api/servers/{id}/network/probe", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		var body struct {
			Count int `json:"count"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		count := clampInt(body.Count, 4, 2, 25)
		wantRtts := count >= 8
		items, err := runAndStoreNetworkProbe(*srv, count, wantRtts)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"results":  items,
			"testedAt": time.Now().UTC().Format(time.RFC3339),
		})
	}))

	mux.HandleFunc("POST /api/servers/{id}/network/probe-single", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		var t NetworkTarget
		if err := json.NewDecoder(r.Body).Decode(&t); err != nil || strings.TrimSpace(t.Host) == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "请输入有效的 IP 或域名"})
			return
		}
		t.ID = "test-single"
		t.Enabled = true
		if t.Protocol != "tcp" {
			t.Protocol = "icmp"
		}
		if t.Protocol == "tcp" && t.Port <= 0 {
			t.Port = 443
		}
		items, err := runNetworkProbes(*srv, []NetworkTarget{t}, 3, false)
		if err != nil || len(items) == 0 {
			msg := "探测失败"
			if err != nil {
				msg = err.Error()
			}
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": msg})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"result": items[0]})
	}))

	mux.HandleFunc("PUT /api/servers/{id}/network/mode", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		var body struct {
			Mode                 string `json:"mode"`
			DurationHours        int    `json:"durationHours"` // 0 = no auto-expire, e.g. 24 or 72
			EnableSpeedInInspect *bool  `json:"enableSpeedInInspect"`
			EnableRouteInInspect *bool  `json:"enableRouteInInspect"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "无效的配置"})
			return
		}
		mode := body.Mode
		if mode != "off" && mode != "routine" && mode != "inspect" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "不支持的监测模式"})
			return
		}
		cur := getServerNetworkMode(srv.ID)
		cur.Mode = mode
		if mode == "inspect" {
			if body.DurationHours > 0 {
				cur.InspectUntil = time.Now().Add(time.Duration(body.DurationHours) * time.Hour).UTC().Format(time.RFC3339)
			} else {
				cur.InspectUntil = ""
			}
			if body.EnableSpeedInInspect != nil {
				cur.EnableSpeedInInspect = *body.EnableSpeedInInspect
			}
			if body.EnableRouteInInspect != nil {
				cur.EnableRouteInInspect = *body.EnableRouteInInspect
			}
		} else {
			cur.InspectUntil = ""
		}
		_ = saveServerNetworkMode(srv.ID, cur)
		// Reset tick timers so switching to inspect kicks off fresh checks promptly
		netTickMu.Lock()
		delete(lastProbeAt, srv.ID)
		if mode == "inspect" {
			delete(lastRouteAt, srv.ID)
		}
		netTickMu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "modeConfig": cur})
	}))

	mux.HandleFunc("GET /api/servers/{id}/network/live-conns", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		health, err := collectLiveTcpHealth(*srv)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"health": health})
	}))

	mux.HandleFunc("POST /api/servers/{id}/network/speedtest", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		samples, err := runAndStoreSpeedTest(*srv)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"samples": samples})
	}))

	mux.HandleFunc("POST /api/servers/{id}/network/route-check", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		srv := getServerByID(r.PathValue("id"))
		if srv == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "服务器不存在"})
			return
		}
		snaps, err := runAndStoreRouteCheck(*srv)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"snapshots": snaps})
	}))

	mux.HandleFunc("GET /api/network/targets", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"targets": loadNetworkTargets()})
	}))

	mux.HandleFunc("PUT /api/network/targets", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Targets []NetworkTarget `json:"targets"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.Targets) == 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "探测目标不能为空"})
			return
		}
		clean := make([]NetworkTarget, 0, len(body.Targets))
		for i, t := range body.Targets {
			host := strings.TrimSpace(t.Host)
			if host == "" {
				continue
			}
			id := strings.TrimSpace(t.ID)
			if id == "" {
				id = fmt.Sprintf("custom-%d-%s", i+1, randomHex(2))
			}
			proto := t.Protocol
			if proto != "tcp" {
				proto = "icmp"
			}
			port := t.Port
			if proto == "tcp" && port <= 0 {
				port = 443
			}
			name := strings.TrimSpace(t.Name)
			if name == "" {
				name = host
			}
			grp := strings.TrimSpace(t.Group)
			if grp == "" {
				grp = "自定义"
			}
			clean = append(clean, NetworkTarget{
				ID:       id,
				Name:     name,
				Host:     host,
				Port:     port,
				Protocol: proto,
				Group:    grp,
				Enabled:  t.Enabled,
			})
		}
		if len(clean) == 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "至少需要一个有效探测目标"})
			return
		}
		_ = saveNetworkTargets(clean)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "targets": loadNetworkTargets()})
	}))

	mux.HandleFunc("GET /api/nodequality/schedule", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"config": loadAutoNQConfig()})
	}))

	mux.HandleFunc("PUT /api/nodequality/schedule", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Config AutoNQConfig `json:"config"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "无效的定时复测配置"})
			return
		}
		if err := saveAutoNQConfig(body.Config); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "config": loadAutoNQConfig()})
	}))

	// WebSSH Terminal WebSocket
	mux.HandleFunc("/ws/terminal", handleTerminalWS)

	// Embedded/External React SPA
	mux.Handle("/", newSPAHandler())

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")
		mux.ServeHTTP(w, r)
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "9800"
	}
	host := os.Getenv("HOST")
	if host == "" {
		host = "0.0.0.0"
	}
	addr := host + ":" + port

	log.Printf("[AtlasNode-Go] Server listening on http://%s", addr)
	if initialPassword != "" {
		log.Printf("[AtlasNode-Go] Initial access password initialized.")
	}
	if err := http.ListenAndServe(addr, handler); err != nil {
		log.Fatalf("listen failed: %v", err)
	}
}

func mustJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
