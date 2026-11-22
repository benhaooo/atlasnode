package main

import (
	"encoding/json"
	"fmt"
	"math"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type NetworkTarget struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Host     string `json:"host"`
	Port     int    `json:"port,omitempty"`
	Protocol string `json:"protocol"` // "icmp" | "tcp"
	Group    string `json:"group"`    // "电信" | "联通" | "移动" | "国际" | "自定义"
	Enabled  bool   `json:"enabled"`
}

// Per-server monitoring mode:
// - "off": no background probing (manual tests & live kernel inspection only)
// - "routine": low-overhead 5-minute probe heartbeat (default for daily servers)
// - "inspect": new-VPS evaluation mode (1-min high-freq probes + hourly single-thread speed + 30-min route hop check, auto-downgrades after duration)
type ServerNetworkMode struct {
	Mode                 string `json:"mode"` // "off" | "routine" | "inspect"
	InspectUntil         string `json:"inspectUntil,omitempty"`
	EnableSpeedInInspect bool   `json:"enableSpeedInInspect"`
	EnableRouteInInspect bool   `json:"enableRouteInInspect"`
	UpdatedAt            string `json:"updatedAt,omitempty"`
}

type NetworkProbeSample struct {
	TS       int64    `json:"ts"`
	TargetID string   `json:"targetId"`
	MinMs    *float64 `json:"minMs"`
	AvgMs    *float64 `json:"avgMs"`
	MaxMs    *float64 `json:"maxMs"`
	JitterMs *float64 `json:"jitterMs"`
	LossPct  float64  `json:"lossPct"`
}

type NetworkPeriodStats struct {
	Samples  int      `json:"samples"`
	AvgMs    *float64 `json:"avgMs"`
	P95Ms    *float64 `json:"p95Ms"`
	JitterMs *float64 `json:"jitterMs"`
	LossPct  float64  `json:"lossPct"`
}

type NetworkTargetSummary struct {
	Target      NetworkTarget        `json:"target"`
	Latest      *NetworkProbeSample  `json:"latest,omitempty"`
	Overall     NetworkPeriodStats   `json:"overall"`
	Peak        NetworkPeriodStats   `json:"peak"`    // 20:00 - 23:59 UTC+8
	OffPeak     NetworkPeriodStats   `json:"offPeak"` // 00:00 - 19:59 UTC+8
	PeakDeltaMs *float64             `json:"peakDeltaMs,omitempty"`
	Grade       string               `json:"grade"` // "excellent" | "good" | "degraded" | "poor" | "unknown"
	Points      []NetworkProbeSample `json:"points"`
}

type NetworkSpeedSample struct {
	TS           int64   `json:"ts"`
	EndpointID   string  `json:"endpointId"`
	EndpointName string  `json:"endpointName"`
	Mbps         float64 `json:"mbps"`
	TTFBMs       float64 `json:"ttfbMs"`
	Bytes        int64   `json:"bytes"`
	DurationMs   int64   `json:"durationMs"`
	Error        string  `json:"error,omitempty"`
	IsPeak       bool    `json:"isPeak"`
}

type NetworkRouteSnapshot struct {
	TS          int64    `json:"ts"`
	TargetID    string   `json:"targetId"`
	TargetName  string   `json:"targetName"`
	HopsCount   int      `json:"hopsCount"`
	FinalMs     *float64 `json:"finalMs"`
	PathSummary string   `json:"pathSummary"`
	Hops        []string `json:"hops"`
	IsPeak      bool     `json:"isPeak"`
	Changed     bool     `json:"changed"`
}

type NetworkVerdict struct {
	Grade    string   `json:"grade"` // "excellent" | "good" | "degraded" | "poor" | "collecting"
	Headline string   `json:"headline"`
	Reasons  []string `json:"reasons"`
}

type NetworkMonitorResponse struct {
	Range            string                 `json:"range"`
	SampleIntervalMs int                    `json:"sampleIntervalMs"`
	ModeConfig       ServerNetworkMode      `json:"modeConfig"`
	Verdict          NetworkVerdict         `json:"verdict"`
	Targets          []NetworkTargetSummary `json:"targets"`
	SpeedSamples     []NetworkSpeedSample   `json:"speedSamples"`
	RouteSnapshots   []NetworkRouteSnapshot `json:"routeSnapshots"`
	UpdatedAt        string                 `json:"updatedAt"`
}

type LivePortConnSummary struct {
	Port            int      `json:"port"`
	Process         string   `json:"process"`
	ActiveCount     int      `json:"activeCount"`
	AvgRttMs        *float64 `json:"avgRttMs"`
	MaxRttMs        *float64 `json:"maxRttMs"`
	AvgDeliveryMbps *float64 `json:"avgDeliveryMbps"`
	RetransTotal    int      `json:"retransTotal"`
	LostTotal       int      `json:"lostTotal"`
}

type LivePeerConn struct {
	LocalPort    int      `json:"localPort"`
	Process      string   `json:"process"`
	RemoteAddr   string   `json:"remoteAddr"`
	RttMs        *float64 `json:"rttMs"`
	RttVarMs     *float64 `json:"rttVarMs"`
	DeliveryMbps *float64 `json:"deliveryMbps"`
	PacingMbps   *float64 `json:"pacingMbps"`
	Retrans      int      `json:"retrans"`
	Lost         int      `json:"lost"`
	BytesSent    int64    `json:"bytesSent"`
	BytesRecv    int64    `json:"bytesRecv"`
}

type LiveTcpHealth struct {
	TotalEstablished int                   `json:"totalEstablished"`
	Ports            []LivePortConnSummary `json:"ports"`
	TopPeers         []LivePeerConn        `json:"topPeers"`
	CollectedAt      string                `json:"collectedAt"`
}

type NetworkRouteInfo struct {
	Destination string `json:"destination"`
	Gateway     string `json:"gateway"`
	Device      string `json:"device"`
	Src         string `json:"src,omitempty"`
}

type NetworkNICDetail struct {
	Name    string   `json:"name"`
	State   string   `json:"state"`
	MTU     int      `json:"mtu"`
	MAC     string   `json:"mac,omitempty"`
	IPv4    []string `json:"ipv4"`
	IPv6    []string `json:"ipv6"`
	RxBytes int64    `json:"rxBytes"`
	TxBytes int64    `json:"txBytes"`
	RxDrops int64    `json:"rxDrops"`
	TxDrops int64    `json:"txDrops"`
}

type NetworkProfile struct {
	PublicIPv4     string             `json:"publicIpv4,omitempty"`
	PublicIPv6     string             `json:"publicIpv6,omitempty"`
	DefaultGateway string             `json:"defaultGateway,omitempty"`
	DefaultDev     string             `json:"defaultDev,omitempty"`
	TCPCC          string             `json:"tcpCc"`
	Qdisc          string             `json:"qdisc"`
	IPForward      bool               `json:"ipForward"`
	TCPFastOpen    string             `json:"tcpFastOpen,omitempty"`
	RmemMax        string             `json:"rmemMax,omitempty"`
	WmemMax        string             `json:"wmemMax,omitempty"`
	DNSServers     []string           `json:"dnsServers"`
	TCPStates      map[string]int     `json:"tcpStates"`
	TotalConns     int                `json:"totalConns"`
	Interfaces     []NetworkNICDetail `json:"interfaces"`
	Routes         []NetworkRouteInfo `json:"routes"`
	CollectedAt    string             `json:"collectedAt"`
}

type NetworkBurstItem struct {
	TargetID   string    `json:"targetId"`
	TargetName string    `json:"targetName"`
	Host       string    `json:"host"`
	Protocol   string    `json:"protocol"`
	Sent       int       `json:"sent"`
	Received   int       `json:"received"`
	LossPct    float64   `json:"lossPct"`
	MinMs      *float64  `json:"minMs"`
	AvgMs      *float64  `json:"avgMs"`
	P95Ms      *float64  `json:"p95Ms"`
	MaxMs      *float64  `json:"maxMs"`
	JitterMs   *float64  `json:"jitterMs"`
	Rtts       []float64 `json:"rtts"` // -1 means timeout/loss
}

var (
	netSamplerOnce sync.Once
	cstZone        = time.FixedZone("CST", 8*3600)
	netTickMu      sync.Mutex
	lastProbeAt    = map[string]time.Time{}
	lastSpeedAt    = map[string]time.Time{}
	lastRouteAt    = map[string]time.Time{}
)

func isPeakCST(tsMs int64) bool {
	hr := time.UnixMilli(tsMs).In(cstZone).Hour()
	return hr >= 20 && hr <= 23
}

func defaultServerNetworkMode() ServerNetworkMode {
	return ServerNetworkMode{
		Mode:                 "routine",
		EnableSpeedInInspect: true,
		EnableRouteInInspect: true,
	}
}

func loadAllServerNetworkModes() map[string]ServerNetworkMode {
	storeLock.RLock()
	var m map[string]ServerNetworkMode
	ok := readJSON(filepath.Join(getDataDir(), "network-modes.json"), &m)
	storeLock.RUnlock()
	if !ok || m == nil {
		return map[string]ServerNetworkMode{}
	}
	return m
}

func getServerNetworkMode(serverID string) ServerNetworkMode {
	m := loadAllServerNetworkModes()
	cfg, ok := m[serverID]
	if !ok || cfg.Mode == "" {
		return defaultServerNetworkMode()
	}
	// Auto-downgrade expired inspect mode back to routine
	if cfg.Mode == "inspect" && cfg.InspectUntil != "" {
		if until, err := time.Parse(time.RFC3339, cfg.InspectUntil); err == nil && time.Now().After(until) {
			cfg.Mode = "routine"
			cfg.InspectUntil = ""
			cfg.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
			_ = saveServerNetworkMode(serverID, cfg)
		}
	}
	return cfg
}

func saveServerNetworkMode(serverID string, cfg ServerNetworkMode) error {
	storeLock.Lock()
	defer storeLock.Unlock()
	var m map[string]ServerNetworkMode
	if !readJSON(filepath.Join(getDataDir(), "network-modes.json"), &m) || m == nil {
		m = map[string]ServerNetworkMode{}
	}
	cfg.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	m[serverID] = cfg
	return writeJSONAtomic(filepath.Join(getDataDir(), "network-modes.json"), m)
}

func defaultNetworkTargets() []NetworkTarget {
	return []NetworkTarget{
		{ID: "ct-sh", Name: "上海电信", Host: "202.96.209.133", Protocol: "icmp", Group: "电信", Enabled: true},
		{ID: "cu-sh", Name: "上海联通", Host: "210.22.70.3", Protocol: "icmp", Group: "联通", Enabled: true},
		{ID: "cm-sh", Name: "上海移动", Host: "211.136.112.50", Protocol: "icmp", Group: "移动", Enabled: true},
		{ID: "ct-gz", Name: "广州电信", Host: "202.96.128.86", Protocol: "icmp", Group: "电信", Enabled: true},
		{ID: "cf-edge", Name: "Cloudflare 1.1.1.1", Host: "1.1.1.1", Port: 443, Protocol: "tcp", Group: "国际", Enabled: true},
		{ID: "gg-dns", Name: "Google 8.8.8.8", Host: "8.8.8.8", Port: 443, Protocol: "tcp", Group: "国际", Enabled: true},
	}
}

func loadNetworkTargets() []NetworkTarget {
	storeLock.RLock()
	var list []NetworkTarget
	ok := readJSON(filepath.Join(getDataDir(), "network-targets.json"), &list)
	storeLock.RUnlock()
	if ok && len(list) > 0 {
		return list
	}
	defaults := defaultNetworkTargets()
	_ = saveNetworkTargets(defaults)
	return defaults
}

func saveNetworkTargets(targets []NetworkTarget) error {
	storeLock.Lock()
	defer storeLock.Unlock()
	return writeJSONAtomic(filepath.Join(getDataDir(), "network-targets.json"), targets)
}

func initNetworkDB() error {
	if metricsDB == nil {
		if err := initMetricsDB(); err != nil {
			return err
		}
	}
	_, err := metricsDB.Exec(`
		CREATE TABLE IF NOT EXISTS network_probes (
			server_id TEXT NOT NULL,
			target_id TEXT NOT NULL,
			ts INTEGER NOT NULL,
			min_ms REAL,
			avg_ms REAL,
			max_ms REAL,
			jitter_ms REAL,
			loss_pct REAL NOT NULL,
			PRIMARY KEY (server_id, target_id, ts)
		);
		CREATE INDEX IF NOT EXISTS idx_network_probes_srv_ts ON network_probes (server_id, ts);

		CREATE TABLE IF NOT EXISTS network_speed_samples (
			server_id TEXT NOT NULL,
			endpoint_id TEXT NOT NULL,
			endpoint_name TEXT NOT NULL,
			ts INTEGER NOT NULL,
			mbps REAL NOT NULL,
			ttfb_ms REAL NOT NULL,
			bytes INTEGER NOT NULL,
			duration_ms INTEGER NOT NULL,
			error TEXT NOT NULL DEFAULT '',
			PRIMARY KEY (server_id, endpoint_id, ts)
		);
		CREATE INDEX IF NOT EXISTS idx_network_speed_srv_ts ON network_speed_samples (server_id, ts);

		CREATE TABLE IF NOT EXISTS network_route_snapshots (
			server_id TEXT NOT NULL,
			target_id TEXT NOT NULL,
			target_name TEXT NOT NULL,
			ts INTEGER NOT NULL,
			hops_count INTEGER NOT NULL,
			final_ms REAL,
			path_summary TEXT NOT NULL,
			hops_json TEXT NOT NULL,
			PRIMARY KEY (server_id, target_id, ts)
		);
		CREATE INDEX IF NOT EXISTS idx_network_route_srv_ts ON network_route_snapshots (server_id, ts);
	`)
	return err
}

func insertNetworkProbeSamples(serverID string, samples []NetworkProbeSample) {
	if metricsDB == nil {
		if err := initNetworkDB(); err != nil {
			return
		}
	}
	tx, err := metricsDB.Begin()
	if err != nil {
		return
	}
	stmt, err := tx.Prepare(`
		INSERT OR REPLACE INTO network_probes
			(server_id, target_id, ts, min_ms, avg_ms, max_ms, jitter_ms, loss_pct)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`)
	if err != nil {
		_ = tx.Rollback()
		return
	}
	defer stmt.Close()
	for _, s := range samples {
		_, _ = stmt.Exec(serverID, s.TargetID, s.TS, s.MinMs, s.AvgMs, s.MaxMs, s.JitterMs, s.LossPct)
	}
	_ = tx.Commit()
}

func insertNetworkSpeedSamples(serverID string, samples []NetworkSpeedSample) {
	if metricsDB == nil {
		if err := initNetworkDB(); err != nil {
			return
		}
	}
	tx, err := metricsDB.Begin()
	if err != nil {
		return
	}
	stmt, err := tx.Prepare(`
		INSERT OR REPLACE INTO network_speed_samples
			(server_id, endpoint_id, endpoint_name, ts, mbps, ttfb_ms, bytes, duration_ms, error)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`)
	if err != nil {
		_ = tx.Rollback()
		return
	}
	defer stmt.Close()
	for _, s := range samples {
		_, _ = stmt.Exec(serverID, s.EndpointID, s.EndpointName, s.TS, s.Mbps, s.TTFBMs, s.Bytes, s.DurationMs, s.Error)
	}
	_ = tx.Commit()
}

func insertNetworkRouteSnapshots(serverID string, snaps []NetworkRouteSnapshot) {
	if metricsDB == nil {
		if err := initNetworkDB(); err != nil {
			return
		}
	}
	tx, err := metricsDB.Begin()
	if err != nil {
		return
	}
	stmt, err := tx.Prepare(`
		INSERT OR REPLACE INTO network_route_snapshots
			(server_id, target_id, target_name, ts, hops_count, final_ms, path_summary, hops_json)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`)
	if err != nil {
		_ = tx.Rollback()
		return
	}
	defer stmt.Close()
	for _, s := range snaps {
		hj, _ := json.Marshal(s.Hops)
		_, _ = stmt.Exec(serverID, s.TargetID, s.TargetName, s.TS, s.HopsCount, s.FinalMs, s.PathSummary, string(hj))
	}
	_ = tx.Commit()
}

func pruneOldNetworkProbes(retentionDays int) {
	if metricsDB == nil {
		return
	}
	cutoff := time.Now().Add(-time.Duration(retentionDays) * 24 * time.Hour).UnixMilli()
	_, _ = metricsDB.Exec(`DELETE FROM network_probes WHERE ts < ?`, cutoff)
	_, _ = metricsDB.Exec(`DELETE FROM network_speed_samples WHERE ts < ?`, cutoff)
	_, _ = metricsDB.Exec(`DELETE FROM network_route_snapshots WHERE ts < ?`, cutoff)
}

const networkProbePy = `
import concurrent.futures, json, math, re, socket, subprocess, sys, time

targets = json.loads(sys.argv[1])
count = max(2, min(30, int(sys.argv[2]) if len(sys.argv) > 2 else 4))
want_rtts = len(sys.argv) > 3 and sys.argv[3] == '1'

def summarize(rtts, sent):
    ok = [x for x in rtts if x is not None and x >= 0]
    loss = round((1.0 - len(ok) / max(1, sent)) * 100.0, 1)
    if not ok:
        return None, None, None, None, None, loss, len(ok)
    mn = round(min(ok), 1)
    mx = round(max(ok), 1)
    avg = round(sum(ok) / len(ok), 1)
    sorted_ok = sorted(ok)
    p95 = round(sorted_ok[min(len(sorted_ok) - 1, int(math.ceil(0.95 * len(sorted_ok))) - 1)], 1)
    if len(ok) > 1:
        diffs = [abs(ok[i] - ok[i - 1]) for i in range(1, len(ok))]
        jitter = round(sum(diffs) / len(diffs), 1)
    else:
        jitter = 0.0
    return mn, avg, p95, mx, jitter, loss, len(ok)

def probe_icmp(t):
    host = t['host']
    interval = '0.2' if count >= 8 else '0.25'
    rtts = []
    try:
        r = subprocess.run(
            ['ping', '-n', '-c', str(count), '-i', interval, '-W', '2', host],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=max(8, count * 1.2 + 5)
        )
        seq_map = {}
        for line in r.stdout.splitlines():
            m = re.search(r'icmp_seq=(\d+).*?time=([0-9.]+)\s*ms', line)
            if m:
                seq_map[int(m.group(1))] = round(float(m.group(2)), 1)
        for seq in range(1, count + 1):
            rtts.append(seq_map.get(seq, -1.0))
    except Exception:
        rtts = [-1.0] * count
    return rtts

def probe_tcp(t):
    host = t['host']
    port = int(t.get('port') or 443)
    rtts = []
    for i in range(count):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(2.2)
        t0 = time.monotonic()
        try:
            s.connect((host, port))
            rtts.append(round((time.monotonic() - t0) * 1000.0, 1))
        except Exception:
            rtts.append(-1.0)
        finally:
            s.close()
        if i + 1 < count:
            time.sleep(0.15 if count >= 8 else 0.2)
    return rtts

def run_one(t):
    proto = t.get('protocol', 'icmp')
    rtts = probe_tcp(t) if proto == 'tcp' else probe_icmp(t)
    mn, avg, p95, mx, jitter, loss, recvd = summarize(rtts, count)
    item = {
        'targetId': t['id'],
        'targetName': t.get('name', t['id']),
        'host': t['host'],
        'protocol': proto,
        'sent': count,
        'received': recvd,
        'lossPct': loss,
        'minMs': mn,
        'avgMs': avg,
        'p95Ms': p95,
        'maxMs': mx,
        'jitterMs': jitter,
    }
    if want_rtts:
        item['rtts'] = rtts
    return item

results = []
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
    futs = [ex.submit(run_one, t) for t in targets]
    for f in futs:
        try:
            results.append(f.result())
        except Exception:
            pass

print(json.dumps({'results': results}))
`

func runNetworkProbes(srv ServerConfig, targets []NetworkTarget, count int, wantRtts bool) ([]NetworkBurstItem, error) {
	activeTargets := make([]NetworkTarget, 0, len(targets))
	for _, t := range targets {
		if t.Enabled && strings.TrimSpace(t.Host) != "" {
			activeTargets = append(activeTargets, t)
		}
	}
	if len(activeTargets) == 0 {
		return []NetworkBurstItem{}, nil
	}
	tJSON, _ := json.Marshal(activeTargets)
	wantFlag := "0"
	if wantRtts {
		wantFlag = "1"
	}
	timeout := 15 * time.Second
	if count >= 10 {
		timeout = 35 * time.Second
	}
	res, err := execScript(srv, "python3 - \"$1\" \"$2\" \"$3\" <<'PYEOF'\n"+networkProbePy+"\nPYEOF\n", ExecOpts{
		Args:    []string{string(tJSON), jsonNumberStr(count), wantFlag},
		Timeout: timeout,
	})
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Results []NetworkBurstItem `json:"results"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(res.Stdout)), &parsed); err != nil {
		return nil, err
	}
	if parsed.Results == nil {
		parsed.Results = []NetworkBurstItem{}
	}
	return parsed.Results, nil
}

func jsonNumberStr(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func runAndStoreNetworkProbe(srv ServerConfig, count int, wantRtts bool) ([]NetworkBurstItem, error) {
	targets := loadNetworkTargets()
	items, err := runNetworkProbes(srv, targets, count, wantRtts)
	if err != nil {
		return nil, err
	}
	now := time.Now().UnixMilli()
	samples := make([]NetworkProbeSample, 0, len(items))
	for _, it := range items {
		samples = append(samples, NetworkProbeSample{
			TS:       now,
			TargetID: it.TargetID,
			MinMs:    it.MinMs,
			AvgMs:    it.AvgMs,
			MaxMs:    it.MaxMs,
			JitterMs: it.JitterMs,
			LossPct:  it.LossPct,
		})
	}
	insertNetworkProbeSamples(srv.ID, samples)
	return items, nil
}

// Single-thread 4-second HTTP download speedtest (low traffic ~5-12MB max, reflects real proxy single-stream throughput!)
const singleThreadSpeedPy = `
import json, subprocess, time

endpoints = [
    ('cn-aliyun', '国内阿里云镜像 (华东)', 'https://mirrors.aliyun.com/ubuntu/ls-lR.gz', True),
    ('cf-global', 'Cloudflare 边缘出口', 'https://speed.cloudflare.com/__down?bytes=12000000', False),
    ('global-cdn', '国际直连 (CacheFly CDN)', 'https://cachefly.cachefly.net/10mb.test', False),
]

results = []
for eid, ename, url, use_range in endpoints:
    cmd = ['curl', '-4', '-sS', '-L', '--max-time', '4', '-o', '/dev/null', '-w', '%{size_download}\t%{time_total}\t%{time_starttransfer}\t%{http_code}']
    if use_range:
        cmd += ['-r', '0-12582911']
    cmd.append(url)
    t0 = time.monotonic()
    try:
        r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=6)
        parts = r.stdout.strip().split('\t')
        if len(parts) >= 4:
            sz = int(float(parts[0]))
            tt = float(parts[1])
            ttfb = float(parts[2])
            code = int(parts[3])
            dur = max(0.05, tt - ttfb) if tt > ttfb + 0.05 else max(0.05, tt)
            mbps = round((sz * 8.0) / dur / 1_000_000.0, 1) if sz > 0 else 0.0
            err = '' if (sz > 50_000 and code in (200, 206)) else (f'HTTP {code}' if code else r.stderr.strip()[:60])
            results.append({
                'endpointId': eid,
                'endpointName': ename,
                'mbps': mbps,
                'ttfbMs': round(ttfb * 1000.0, 1),
                'bytes': sz,
                'durationMs': int(tt * 1000),
                'error': err,
            })
        else:
            results.append({'endpointId': eid, 'endpointName': ename, 'mbps': 0, 'ttfbMs': 0, 'bytes': 0, 'durationMs': int((time.monotonic()-t0)*1000), 'error': '测速失败'})
    except Exception as e:
        results.append({'endpointId': eid, 'endpointName': ename, 'mbps': 0, 'ttfbMs': 0, 'bytes': 0, 'durationMs': int((time.monotonic()-t0)*1000), 'error': str(e)[:60]})

print(json.dumps({'results': results}))
`

func runAndStoreSpeedTest(srv ServerConfig) ([]NetworkSpeedSample, error) {
	res, err := execScript(srv, "python3 - <<'PYEOF'\n"+singleThreadSpeedPy+"\nPYEOF\n", ExecOpts{
		Timeout: 25 * time.Second,
	})
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Results []NetworkSpeedSample `json:"results"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(res.Stdout)), &parsed); err != nil {
		return nil, err
	}
	now := time.Now().UnixMilli()
	peak := isPeakCST(now)
	for i := range parsed.Results {
		parsed.Results[i].TS = now
		parsed.Results[i].IsPeak = peak
	}
	insertNetworkSpeedSamples(srv.ID, parsed.Results)
	return parsed.Results, nil
}

// Lightweight route hop snapshot (detects peak-hour detour / route switches!)
const routeCheckPy = `
import concurrent.futures, json, re, shutil, subprocess, sys

targets = json.loads(sys.argv[1])

def trace_one(t):
    host = t['host']
    hops = []
    final_ms = None
    if shutil.which('mtr'):
        try:
            r = subprocess.run(['mtr', '-r', '-n', '-c', '2', '-w', '-m', '18', host], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=14)
            for line in r.stdout.splitlines():
                m = re.match(r'^\s*(\d+)\.\|--\s+(\S+)\s+[\d.]+%\s+\d+\s+[\d.]+\s+([\d.]+)', line)
                if m:
                    ip = m.group(2)
                    ms = float(m.group(3))
                    hops.append(f'{m.group(1)}: {ip} ({ms:.1f}ms)' if ip != '???' else f'{m.group(1)}: *')
                    if ip != '???':
                        final_ms = round(ms, 1)
        except Exception:
            pass
    elif shutil.which('traceroute'):
        try:
            r = subprocess.run(['traceroute', '-n', '-q', '1', '-w', '1', '-m', '18', host], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=14)
            for line in r.stdout.splitlines()[1:]:
                m = re.match(r'^\s*(\d+)\s+(\S+)(?:\s+([\d.]+)\s*ms)?', line)
                if m:
                    ip = m.group(2)
                    ms = float(m.group(3)) if m.group(3) else None
                    hops.append(f'{m.group(1)}: {ip} ({ms:.1f}ms)' if ms is not None else f'{m.group(1)}: {ip}')
                    if ms is not None:
                        final_ms = round(ms, 1)
        except Exception:
            pass
    elif shutil.which('tracepath'):
        try:
            r = subprocess.run(['tracepath', '-n', '-m', '16', host], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=14)
            for line in r.stdout.splitlines():
                m = re.match(r'^\s*(\d+):\s+(\S+)\s+([\d.]+)ms', line)
                if m:
                    ip = m.group(2)
                    ms = float(m.group(3))
                    hops.append(f'{m.group(1)}: {ip} ({ms:.1f}ms)')
                    final_ms = round(ms, 1)
        except Exception:
            pass

    # Build compact path signature from non-wildcard IPs (first 2 + last 2)
    valid_ips = []
    for h in hops:
        p = h.split(': ', 1)[1].split(' ')[0] if ': ' in h else ''
        if p and p != '*' and p != '???' and p != 'no':
            valid_ips.append(p)
    if len(valid_ips) > 4:
        summary = f"{valid_ips[0]} -> {valid_ips[1]} -> ... -> {valid_ips[-2]} -> {valid_ips[-1]}"
    else:
        summary = ' -> '.join(valid_ips) if valid_ips else '无路由响应'

    return {
        'targetId': t['id'],
        'targetName': t['name'],
        'hopsCount': len(hops),
        'finalMs': final_ms,
        'pathSummary': summary,
        'hops': hops[:18],
    }

out = []
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:
    futs = [ex.submit(trace_one, t) for t in targets[:3]]
    for f in futs:
        try:
            out.append(f.result())
        except Exception:
            pass

print(json.dumps({'results': out}))
`

func runAndStoreRouteCheck(srv ServerConfig) ([]NetworkRouteSnapshot, error) {
	allTargets := loadNetworkTargets()
	// Pick up to 3 representative enabled targets (prefer CN ISPs)
	picked := []NetworkTarget{}
	for _, t := range allTargets {
		if t.Enabled && (t.Group == "电信" || t.Group == "联通" || t.Group == "移动") {
			picked = append(picked, t)
			if len(picked) >= 3 {
				break
			}
		}
	}
	if len(picked) == 0 {
		for _, t := range allTargets {
			if t.Enabled {
				picked = append(picked, t)
				if len(picked) >= 3 {
					break
				}
			}
		}
	}
	if len(picked) == 0 {
		return []NetworkRouteSnapshot{}, nil
	}
	tJSON, _ := json.Marshal(picked)
	res, err := execScript(srv, "python3 - \"$1\" <<'PYEOF'\n"+routeCheckPy+"\nPYEOF\n", ExecOpts{
		Args:    []string{string(tJSON)},
		Timeout: 25 * time.Second,
	})
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Results []NetworkRouteSnapshot `json:"results"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(res.Stdout)), &parsed); err != nil {
		return nil, err
	}
	now := time.Now().UnixMilli()
	peak := isPeakCST(now)
	for i := range parsed.Results {
		parsed.Results[i].TS = now
		parsed.Results[i].IsPeak = peak
		if parsed.Results[i].Hops == nil {
			parsed.Results[i].Hops = []string{}
		}
	}
	insertNetworkRouteSnapshots(srv.ID, parsed.Results)
	return parsed.Results, nil
}

// Zero-traffic real kernel TCP connection health inspector (`ss -ti -p state established`)
const liveTcpHealthPy = `
import json, re, subprocess

def parse_rate_mbps(txt):
    m = re.match(r'^([\d.]+)(bps|Kbps|Mbps|Gbps)$', txt)
    if not m:
        return None
    val = float(m.group(1))
    unit = m.group(2)
    if unit == 'Gbps': return round(val * 1000.0, 2)
    if unit == 'Mbps': return round(val, 2)
    if unit == 'Kbps': return round(val / 1000.0, 3)
    return round(val / 1_000_000.0, 4)

out = ''
try:
    out = subprocess.run(['ss', '-tinpH', 'state', 'established'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=6).stdout
except Exception:
    pass

lines = out.splitlines()
peers = []
i = 0
while i < len(lines):
    head = lines[i].strip()
    detail = lines[i+1].strip() if i + 1 < len(lines) and (lines[i+1].startswith('\t') or lines[i+1].startswith(' ')) else ''
    i += 2 if detail else 1
    parts = head.split()
    if len(parts) < 4:
        continue
    local = parts[2]
    remote = parts[3]
    if local.startswith(('127.', '[::1]')) or remote.startswith(('127.', '[::1]')):
        continue
    lidx = local.rfind(':')
    if lidx < 0:
        continue
    try:
        lport = int(local[lidx+1:])
    except Exception:
        continue
    proc = ''
    pm = re.search(r'"([^"]+)"', head)
    if pm:
        proc = pm.group(1)

    rtt, rttvar = None, None
    rm = re.search(r'\brtt:([\d.]+)/([\d.]+)', detail)
    if rm:
        rtt = round(float(rm.group(1)), 1)
        rttvar = round(float(rm.group(2)), 1)

    deliv, pacing = None, None
    dm = re.search(r'\bdelivery_rate\s+(\S+)', detail)
    if dm:
        deliv = parse_rate_mbps(dm.group(1))
    pcm = re.search(r'\bpacing_rate\s+(\S+)', detail)
    if pcm:
        pacing = parse_rate_mbps(pcm.group(1))

    retrans = 0
    rtm = re.search(r'\bretrans:\d+/(\d+)', detail)
    if rtm:
        retrans = int(rtm.group(1))
    lost = 0
    lm = re.search(r'\blost:(\d+)', detail)
    if lm:
        lost = int(lm.group(1))

    bsent, brecv = 0, 0
    sm = re.search(r'\bbytes_sent:(\d+)', detail)
    if sm: bsent = int(sm.group(1))
    rvm = re.search(r'\bbytes_received:(\d+)', detail)
    if rvm: brecv = int(rvm.group(1))

    peers.append({
        'localPort': lport,
        'process': proc or 'unknown',
        'remoteAddr': remote,
        'rttMs': rtt,
        'rttVarMs': rttvar,
        'deliveryMbps': deliv,
        'pacingMbps': pacing,
        'retrans': retrans,
        'lost': lost,
        'bytesSent': bsent,
        'bytesRecv': brecv,
    })

# Group by local listening/service port (prefer ports <= 32768 as server ports)
port_groups = {}
for p in peers:
    lp = p['localPort']
    if lp > 32768:
        continue
    g = port_groups.setdefault(lp, {'port': lp, 'process': p['process'], 'rtts': [], 'delivs': [], 'retrans': 0, 'lost': 0, 'cnt': 0})
    g['cnt'] += 1
    if g['process'] == 'unknown' and p['process'] != 'unknown':
        g['process'] = p['process']
    if p['rttMs'] is not None:
        g['rtts'].append(p['rttMs'])
    if p['deliveryMbps'] is not None:
        g['delivs'].append(p['deliveryMbps'])
    g['retrans'] += p['retrans']
    g['lost'] += p['lost']

port_summaries = []
for g in sorted(port_groups.values(), key=lambda x: x['cnt'], reverse=True)[:10]:
    rtts = g['rtts']
    delivs = g['delivs']
    port_summaries.append({
        'port': g['port'],
        'process': g['process'],
        'activeCount': g['cnt'],
        'avgRttMs': round(sum(rtts) / len(rtts), 1) if rtts else None,
        'maxRttMs': round(max(rtts), 1) if rtts else None,
        'avgDeliveryMbps': round(sum(delivs) / len(delivs), 1) if delivs else None,
        'retransTotal': g['retrans'],
        'lostTotal': g['lost'],
    })

# Top active peers by traffic + retrans
peers.sort(key=lambda x: (x['bytesSent'] + x['bytesRecv'], x['retrans']), reverse=True)
print(json.dumps({
    'totalEstablished': len(peers),
    'ports': port_summaries,
    'topPeers': peers[:12],
}))
`

func collectLiveTcpHealth(srv ServerConfig) (LiveTcpHealth, error) {
	res, err := execScript(srv, "python3 - <<'PYEOF'\n"+liveTcpHealthPy+"\nPYEOF\n", ExecOpts{
		Timeout: 10 * time.Second,
		Sudo:    true,
	})
	if err != nil {
		return LiveTcpHealth{}, err
	}
	var h LiveTcpHealth
	if err := json.Unmarshal([]byte(strings.TrimSpace(res.Stdout)), &h); err != nil {
		return LiveTcpHealth{}, err
	}
	if h.Ports == nil {
		h.Ports = []LivePortConnSummary{}
	}
	if h.TopPeers == nil {
		h.TopPeers = []LivePeerConn{}
	}
	h.CollectedAt = time.Now().UTC().Format(time.RFC3339)
	return h, nil
}

func startNetworkProbeSampler(interval time.Duration) {
	netSamplerOnce.Do(func() {
		_ = initNetworkDB()
		tick := func() {
			servers := loadServers()
			targets := loadNetworkTargets()
			now := time.Now()
			var wg sync.WaitGroup
			for _, srv := range servers {
				if !srv.IsProxyEnabled() {
					continue
				}
				modeCfg := getServerNetworkMode(srv.ID)
				if modeCfg.Mode == "off" {
					continue
				}
				probeEvery := 5 * time.Minute
				if modeCfg.Mode == "inspect" {
					probeEvery = 1 * time.Minute
				}

				netTickMu.Lock()
				shouldProbe := lastProbeAt[srv.ID].IsZero() || now.Sub(lastProbeAt[srv.ID]) >= probeEvery-5*time.Second
				shouldSpeed := modeCfg.Mode == "inspect" && modeCfg.EnableSpeedInInspect && (lastSpeedAt[srv.ID].IsZero() || now.Sub(lastSpeedAt[srv.ID]) >= 60*time.Minute)
				shouldRoute := modeCfg.Mode == "inspect" && modeCfg.EnableRouteInInspect && (lastRouteAt[srv.ID].IsZero() || now.Sub(lastRouteAt[srv.ID]) >= 30*time.Minute)
				if shouldProbe {
					lastProbeAt[srv.ID] = now
				}
				if shouldSpeed {
					lastSpeedAt[srv.ID] = now
				}
				if shouldRoute {
					lastRouteAt[srv.ID] = now
				}
				netTickMu.Unlock()

				if !shouldProbe && !shouldSpeed && !shouldRoute {
					continue
				}
				wg.Add(1)
				go func(s ServerConfig, doProbe, doSpeed, doRoute bool) {
					defer wg.Done()
					if doProbe {
						items, err := runNetworkProbes(s, targets, 4, false)
						if err == nil && len(items) > 0 {
							ts := time.Now().UnixMilli()
							samples := make([]NetworkProbeSample, 0, len(items))
							for _, it := range items {
								samples = append(samples, NetworkProbeSample{
									TS:       ts,
									TargetID: it.TargetID,
									MinMs:    it.MinMs,
									AvgMs:    it.AvgMs,
									MaxMs:    it.MaxMs,
									JitterMs: it.JitterMs,
									LossPct:  it.LossPct,
								})
							}
							insertNetworkProbeSamples(s.ID, samples)
						}
					}
					if doRoute {
						_, _ = runAndStoreRouteCheck(s)
					}
					if doSpeed {
						_, _ = runAndStoreSpeedTest(s)
					}
				}(srv, shouldProbe, shouldSpeed, shouldRoute)
			}
			wg.Wait()
		}

		go func() {
			time.Sleep(8 * time.Second)
			tick()
			sampleTicker := time.NewTicker(interval)
			pruneTicker := time.NewTicker(6 * time.Hour)
			defer sampleTicker.Stop()
			defer pruneTicker.Stop()
			for {
				select {
				case <-sampleTicker.C:
					tick()
				case <-pruneTicker.C:
					pruneOldNetworkProbes(7)
				}
			}
		}()
	})
}

func computePeriodStats(rows []NetworkProbeSample) NetworkPeriodStats {
	if len(rows) == 0 {
		return NetworkPeriodStats{}
	}
	avgs := []float64{}
	jitters := []float64{}
	lossSum := 0.0
	for _, r := range rows {
		lossSum += r.LossPct
		if r.AvgMs != nil {
			avgs = append(avgs, *r.AvgMs)
		}
		if r.JitterMs != nil {
			jitters = append(jitters, *r.JitterMs)
		}
	}
	st := NetworkPeriodStats{
		Samples: len(rows),
		LossPct: round1(lossSum / float64(len(rows))),
	}
	if len(avgs) > 0 {
		sum := 0.0
		for _, v := range avgs {
			sum += v
		}
		a := round1(sum / float64(len(avgs)))
		st.AvgMs = &a

		sorted := append([]float64{}, avgs...)
		sort.Float64s(sorted)
		idx := int(math.Ceil(0.95*float64(len(sorted)))) - 1
		if idx < 0 {
			idx = 0
		}
		p95 := round1(sorted[idx])
		st.P95Ms = &p95
	}
	if len(jitters) > 0 {
		sum := 0.0
		for _, v := range jitters {
			sum += v
		}
		j := round1(sum / float64(len(jitters)))
		st.JitterMs = &j
	}
	return st
}

func gradeStability(overall, peak NetworkPeriodStats, peakDelta *float64) string {
	if overall.Samples == 0 {
		return "unknown"
	}
	loss := overall.LossPct
	if peak.Samples >= 3 && peak.LossPct > loss {
		loss = peak.LossPct
	}
	jitter := 0.0
	if overall.JitterMs != nil {
		jitter = *overall.JitterMs
	}
	if peak.Samples >= 3 && peak.JitterMs != nil && *peak.JitterMs > jitter {
		jitter = *peak.JitterMs
	}
	delta := 0.0
	if peakDelta != nil {
		delta = *peakDelta
	}

	if loss >= 5.0 || jitter >= 35.0 || delta >= 60.0 {
		return "poor"
	}
	if loss >= 1.0 || jitter >= 15.0 || delta >= 25.0 {
		return "degraded"
	}
	if loss == 0 && jitter <= 5.0 && delta <= 10.0 {
		return "excellent"
	}
	return "good"
}

func buildNetworkVerdict(targets []NetworkTargetSummary, routes []NetworkRouteSnapshot, speeds []NetworkSpeedSample) NetworkVerdict {
	totalSamples := 0
	poorCount, degradedCount, peakTargets := 0, 0, 0
	maxLoss := 0.0
	maxPeakDelta := 0.0
	for _, t := range targets {
		totalSamples += t.Overall.Samples
		if t.Overall.LossPct > maxLoss {
			maxLoss = t.Overall.LossPct
		}
		if t.Peak.Samples > 0 {
			peakTargets++
			if t.Peak.LossPct > maxLoss {
				maxLoss = t.Peak.LossPct
			}
		}
		if t.PeakDeltaMs != nil && *t.PeakDeltaMs > maxPeakDelta {
			maxPeakDelta = *t.PeakDeltaMs
		}
		if t.Grade == "poor" {
			poorCount++
		} else if t.Grade == "degraded" {
			degradedCount++
		}
	}
	if totalSamples == 0 {
		return NetworkVerdict{
			Grade:    "collecting",
			Headline: "正在积累线路基线样本",
			Reasons:  []string{"尚未采集到探针记录，可点击「立即采样」或开启「新机验机模式」持续观察晚高峰"},
		}
	}

	reasons := []string{}
	routeChanged := false
	for _, r := range routes {
		if r.Changed {
			routeChanged = true
			break
		}
	}

	if peakTargets > 0 {
		reasons = append(reasons, fmt.Sprintf("晚高峰最高延迟增量 %+.1fms，最高丢包 %.1f%%", maxPeakDelta, maxLoss))
	} else {
		reasons = append(reasons, fmt.Sprintf("当前窗口最高丢包 %.1f%%（尚无 20:00–24:00 晚高峰样本）", maxLoss))
	}
	if routeChanged {
		reasons = append(reasons, "检测到路由跳数/路径变动（存在晚高峰切线风险）")
	}
	if len(speeds) > 0 {
		latest := speeds[0]
		if latest.Mbps > 0 {
			reasons = append(reasons, fmt.Sprintf("最近单线程实测 %s: %.1f Mbps", latest.EndpointName, latest.Mbps))
		}
	}

	if poorCount >= 2 || maxLoss >= 8.0 {
		return NetworkVerdict{Grade: "poor", Headline: "线路存在明显丢包或高峰炸线，不建议主力使用", Reasons: reasons}
	}
	if poorCount >= 1 || degradedCount >= 2 || routeChanged {
		return NetworkVerdict{Grade: "degraded", Headline: "日常可用，但部分线路或晚高峰有明显波动", Reasons: reasons}
	}
	if maxLoss == 0 && maxPeakDelta <= 12 {
		return NetworkVerdict{Grade: "excellent", Headline: "线路表现稳健，适合长期主力 / 代理使用", Reasons: reasons}
	}
	return NetworkVerdict{Grade: "good", Headline: "整体网络平稳，偶有轻微波动", Reasons: reasons}
}

func downsampleProbes(rows []NetworkProbeSample, maxPoints int) []NetworkProbeSample {
	if len(rows) <= maxPoints {
		return rows
	}
	bucket := (len(rows) + maxPoints - 1) / maxPoints
	out := make([]NetworkProbeSample, 0, maxPoints)
	for i := 0; i < len(rows); i += bucket {
		end := i + bucket
		if end > len(rows) {
			end = len(rows)
		}
		sl := rows[i:end]
		var minV, maxV, avgSum, jitSum, lossSum float64
		hasLatency := false
		latCnt := 0
		jitCnt := 0
		for _, r := range sl {
			lossSum += r.LossPct
			if r.AvgMs != nil {
				if !hasLatency {
					hasLatency = true
					minV = *r.AvgMs
					maxV = *r.AvgMs
				}
				if r.MinMs != nil && *r.MinMs < minV {
					minV = *r.MinMs
				}
				if r.MaxMs != nil && *r.MaxMs > maxV {
					maxV = *r.MaxMs
				}
				avgSum += *r.AvgMs
				latCnt++
			}
			if r.JitterMs != nil {
				jitSum += *r.JitterMs
				jitCnt++
			}
		}
		pt := NetworkProbeSample{
			TS:       sl[len(sl)/2].TS,
			TargetID: sl[0].TargetID,
			LossPct:  round1(lossSum / float64(len(sl))),
		}
		if hasLatency && latCnt > 0 {
			mn := round1(minV)
			mx := round1(maxV)
			av := round1(avgSum / float64(latCnt))
			pt.MinMs = &mn
			pt.AvgMs = &av
			pt.MaxMs = &mx
		}
		if jitCnt > 0 {
			jt := round1(jitSum / float64(jitCnt))
			pt.JitterMs = &jt
		}
		out = append(out, pt)
	}
	return out
}

func getServerNetworkBrief(serverID string) *NetworkHealthBrief {
	mon := queryNetworkMonitor(serverID, "24h")
	totalSamples := 0
	lossSum := 0.0
	lossCount := 0
	maxLoss := 0.0
	var maxPeakDelta *float64
	for _, t := range mon.Targets {
		totalSamples += t.Overall.Samples
		if t.Overall.Samples > 0 {
			lossSum += t.Overall.LossPct
			lossCount++
			if t.Overall.LossPct > maxLoss {
				maxLoss = t.Overall.LossPct
			}
		}
		if t.Peak.Samples > 0 && t.Peak.LossPct > maxLoss {
			maxLoss = t.Peak.LossPct
		}
		if t.PeakDeltaMs != nil {
			if maxPeakDelta == nil || *t.PeakDeltaMs > *maxPeakDelta {
				v := *t.PeakDeltaMs
				maxPeakDelta = &v
			}
		}
	}
	avgLoss := 0.0
	if lossCount > 0 {
		avgLoss = round1(lossSum / float64(lossCount))
	}
	return &NetworkHealthBrief{
		Mode:        mon.ModeConfig.Mode,
		Grade:       mon.Verdict.Grade,
		Headline:    mon.Verdict.Headline,
		AvgLossPct:  avgLoss,
		MaxLossPct:  round1(maxLoss),
		PeakDeltaMs: maxPeakDelta,
		Samples:     totalSamples,
	}
}

func queryNetworkMonitor(serverID, rng string) NetworkMonitorResponse {
	if metricsDB == nil {
		_ = initNetworkDB()
	}
	dur := 24 * time.Hour
	switch rng {
	case "1h":
		dur = time.Hour
	case "6h":
		dur = 6 * time.Hour
	case "24h":
		dur = 24 * time.Hour
	case "7d":
		dur = 7 * 24 * time.Hour
	default:
		rng = "24h"
	}
	since := time.Now().Add(-dur).UnixMilli()
	targets := loadNetworkTargets()
	modeCfg := getServerNetworkMode(serverID)

	byTarget := map[string][]NetworkProbeSample{}
	speedSamples := []NetworkSpeedSample{}
	routeSnaps := []NetworkRouteSnapshot{}

	if metricsDB != nil {
		if q, err := metricsDB.Query(`
			SELECT target_id, ts, min_ms, avg_ms, max_ms, jitter_ms, loss_pct
			FROM network_probes
			WHERE server_id = ? AND ts >= ?
			ORDER BY ts ASC
		`, serverID, since); err == nil {
			defer q.Close()
			for q.Next() {
				var s NetworkProbeSample
				if q.Scan(&s.TargetID, &s.TS, &s.MinMs, &s.AvgMs, &s.MaxMs, &s.JitterMs, &s.LossPct) == nil {
					byTarget[s.TargetID] = append(byTarget[s.TargetID], s)
				}
			}
		}

		if q, err := metricsDB.Query(`
			SELECT ts, endpoint_id, endpoint_name, mbps, ttfb_ms, bytes, duration_ms, error
			FROM network_speed_samples
			WHERE server_id = ? AND ts >= ?
			ORDER BY ts DESC
			LIMIT 36
		`, serverID, since); err == nil {
			defer q.Close()
			for q.Next() {
				var s NetworkSpeedSample
				if q.Scan(&s.TS, &s.EndpointID, &s.EndpointName, &s.Mbps, &s.TTFBMs, &s.Bytes, &s.DurationMs, &s.Error) == nil {
					s.IsPeak = isPeakCST(s.TS)
					speedSamples = append(speedSamples, s)
				}
			}
		}

		if q, err := metricsDB.Query(`
			SELECT ts, target_id, target_name, hops_count, final_ms, path_summary, hops_json
			FROM network_route_snapshots
			WHERE server_id = ? AND ts >= ?
			ORDER BY ts ASC
		`, serverID, since); err == nil {
			defer q.Close()
			prevHopsByTarget := map[string]int{}
			for q.Next() {
				var r NetworkRouteSnapshot
				var hopsJSON string
				if q.Scan(&r.TS, &r.TargetID, &r.TargetName, &r.HopsCount, &r.FinalMs, &r.PathSummary, &hopsJSON) == nil {
					_ = json.Unmarshal([]byte(hopsJSON), &r.Hops)
					if r.Hops == nil {
						r.Hops = []string{}
					}
					r.IsPeak = isPeakCST(r.TS)
					if prev, ok := prevHopsByTarget[r.TargetID]; ok && prev > 0 && r.HopsCount > 0 && int(math.Abs(float64(r.HopsCount-prev))) >= 3 {
						r.Changed = true
					}
					if r.HopsCount > 0 {
						prevHopsByTarget[r.TargetID] = r.HopsCount
					}
					routeSnaps = append(routeSnaps, r)
				}
			}
		}
	}

	// Reverse routeSnaps so newest is first, cap to 24
	for i, j := 0, len(routeSnaps)-1; i < j; i, j = i+1, j-1 {
		routeSnaps[i], routeSnaps[j] = routeSnaps[j], routeSnaps[i]
	}
	if len(routeSnaps) > 24 {
		routeSnaps = routeSnaps[:24]
	}

	summaries := make([]NetworkTargetSummary, 0, len(targets))
	for _, t := range targets {
		if !t.Enabled {
			continue
		}
		rows := byTarget[t.ID]
		peakRows := []NetworkProbeSample{}
		offPeakRows := []NetworkProbeSample{}
		for _, r := range rows {
			if isPeakCST(r.TS) {
				peakRows = append(peakRows, r)
			} else {
				offPeakRows = append(offPeakRows, r)
			}
		}
		overall := computePeriodStats(rows)
		peak := computePeriodStats(peakRows)
		offPeak := computePeriodStats(offPeakRows)

		var peakDelta *float64
		if peak.AvgMs != nil && offPeak.AvgMs != nil {
			d := round1(*peak.AvgMs - *offPeak.AvgMs)
			peakDelta = &d
		}
		var latest *NetworkProbeSample
		if len(rows) > 0 {
			cp := rows[len(rows)-1]
			latest = &cp
		}

		pts := downsampleProbes(rows, 120)
		if pts == nil {
			pts = []NetworkProbeSample{}
		}
		summaries = append(summaries, NetworkTargetSummary{
			Target:      t,
			Latest:      latest,
			Overall:     overall,
			Peak:        peak,
			OffPeak:     offPeak,
			PeakDeltaMs: peakDelta,
			Grade:       gradeStability(overall, peak, peakDelta),
			Points:      pts,
		})
	}

	intervalMs := 300_000
	if modeCfg.Mode == "inspect" {
		intervalMs = 60_000
	} else if modeCfg.Mode == "off" {
		intervalMs = 0
	}

	return NetworkMonitorResponse{
		Range:            rng,
		SampleIntervalMs: intervalMs,
		ModeConfig:       modeCfg,
		Verdict:          buildNetworkVerdict(summaries, routeSnaps, speedSamples),
		Targets:          summaries,
		SpeedSamples:     speedSamples,
		RouteSnapshots:   routeSnaps,
		UpdatedAt:        time.Now().UTC().Format(time.RFC3339),
	}
}

const networkProfilePy = `
import json, os, subprocess

def run(cmd, timeout=5):
    try:
        return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=timeout).stdout
    except Exception:
        return ''

def read_sysctl(path, default=''):
    try:
        with open('/proc/sys/' + path.replace('.', '/')) as f:
            return f.read().strip()
    except Exception:
        return default

net_stats = {}
try:
    with open('/proc/net/dev') as f:
        for line in f.readlines()[2:]:
            if ':' not in line: continue
            n, rest = line.split(':', 1)
            c = rest.split()
            if len(c) >= 12:
                net_stats[n.strip()] = (int(c[0]), int(c[8]), int(c[3]), int(c[11]))
except Exception:
    pass

ifaces = []
try:
    data = json.loads(run(['ip', '-j', 'addr']) or '[]')
    for item in data:
        name = item.get('ifname', '')
        if name == 'lo' or name.startswith(('veth', 'br-', 'docker')):
            continue
        ipv4, ipv6 = [], []
        for a in item.get('addr_info', []):
            if a.get('family') == 'inet':
                ipv4.append(f"{a.get('local')}/{a.get('prefixlen', 32)}")
            elif a.get('family') == 'inet6' and not str(a.get('local', '')).startswith('fe80'):
                ipv6.append(f"{a.get('local')}/{a.get('prefixlen', 128)}")
        rx, tx, rxd, txd = net_stats.get(name, (0, 0, 0, 0))
        ifaces.append({
            'name': name,
            'state': item.get('operstate', 'UNKNOWN'),
            'mtu': int(item.get('mtu') or 1500),
            'mac': item.get('address', ''),
            'ipv4': ipv4,
            'ipv6': ipv6,
            'rxBytes': rx,
            'txBytes': tx,
            'rxDrops': rxd,
            'txDrops': txd,
        })
except Exception:
    pass

routes = []
default_gw = ''
default_dev = ''
try:
    rdata = json.loads(run(['ip', '-j', 'route']) or '[]')
    for r in rdata:
        dst = r.get('dst', '')
        gw = r.get('gateway', '')
        dev = r.get('dev', '')
        src = r.get('prefsrc', '')
        if dst == 'default' and not default_gw:
            default_gw = gw or 'direct'
            default_dev = dev
        if dev and not dev.startswith(('veth', 'br-', 'docker')):
            routes.append({'destination': dst, 'gateway': gw or 'direct', 'device': dev, 'src': src})
except Exception:
    pass

tcp_states = {}
total_conns = 0
for line in run(['ss', '-tanH']).splitlines():
    parts = line.split()
    if not parts: continue
    st = parts[0]
    tcp_states[st] = tcp_states.get(st, 0) + 1
    total_conns += 1

dns = []
try:
    with open('/etc/resolv.conf') as f:
        for line in f:
            s = line.strip()
            if s.startswith('nameserver '):
                dns.append(s.split()[1])
except Exception:
    pass

pub4 = run(['curl', '-s4', '--max-time', '2', 'https://api.ipify.org']).strip()
pub6 = run(['curl', '-s6', '--max-time', '2', 'https://api6.ipify.org']).strip()

print(json.dumps({
    'publicIpv4': pub4 if len(pub4) <= 45 and '.' in pub4 else '',
    'publicIpv6': pub6 if len(pub6) <= 64 and ':' in pub6 else '',
    'defaultGateway': default_gw,
    'defaultDev': default_dev,
    'tcpCc': read_sysctl('net.ipv4.tcp_congestion_control', 'unknown'),
    'qdisc': read_sysctl('net.core.default_qdisc', 'unknown'),
    'ipForward': read_sysctl('net.ipv4.ip_forward', '0') == '1',
    'tcpFastOpen': read_sysctl('net.ipv4.tcp_fastopen', ''),
    'rmemMax': read_sysctl('net.core.rmem_max', ''),
    'wmemMax': read_sysctl('net.core.wmem_max', ''),
    'dnsServers': dns[:6],
    'tcpStates': tcp_states,
    'totalConns': total_conns,
    'interfaces': ifaces,
    'routes': routes[:12],
}))
`

func collectNetworkProfile(srv ServerConfig) (NetworkProfile, error) {
	res, err := execScript(srv, "python3 - <<'PYEOF'\n"+networkProfilePy+"\nPYEOF\n", ExecOpts{
		Timeout: 12 * time.Second,
		Sudo:    true,
	})
	if err != nil {
		return NetworkProfile{}, err
	}
	var p NetworkProfile
	if err := json.Unmarshal([]byte(strings.TrimSpace(res.Stdout)), &p); err != nil {
		return NetworkProfile{}, err
	}
	if p.PublicIPv4 == "" {
		p.PublicIPv4 = srv.PublicIP
	}
	if p.DNSServers == nil {
		p.DNSServers = []string{}
	}
	if p.TCPStates == nil {
		p.TCPStates = map[string]int{}
	}
	if p.Interfaces == nil {
		p.Interfaces = []NetworkNICDetail{}
	}
	if p.Routes == nil {
		p.Routes = []NetworkRouteInfo{}
	}
	p.CollectedAt = time.Now().UTC().Format(time.RFC3339)
	return p, nil
}
