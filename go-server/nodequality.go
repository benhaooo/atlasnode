package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

type nqEvent struct {
	Type string
	Data any
}

type activeNQJob struct {
	mu        sync.Mutex
	run       NodeQualityRun
	proc      *StreamProcess
	logLines  []string
	listeners map[chan nqEvent]struct{}
	cancelled bool
}

var (
	nqJobsMu   sync.Mutex
	activeJobs = map[string]*activeNQJob{}
)

var provinceNames = map[string]string{
	"京": "北京", "津": "天津", "冀": "河北", "晋": "山西", "蒙": "内蒙古",
	"辽": "辽宁", "吉": "吉林", "黑": "黑龙江", "沪": "上海", "苏": "江苏",
	"浙": "浙江", "皖": "安徽", "闽": "福建", "赣": "江西", "鲁": "山东",
	"豫": "河南", "鄂": "湖北", "湘": "湖南", "粤": "广东", "桂": "广西",
	"琼": "海南", "渝": "重庆", "川": "四川", "贵": "贵州", "云": "云南",
	"藏": "西藏", "陕": "陕西", "甘": "甘肃", "青": "青海", "宁": "宁夏", "新": "新疆",
}

func getActiveNodeQualityJob(serverID string) *ActiveNQJobInfo {
	nqJobsMu.Lock()
	job := activeJobs[serverID]
	nqJobsMu.Unlock()
	if job == nil {
		return nil
	}
	job.mu.Lock()
	defer job.mu.Unlock()
	lines := make([]string, len(job.logLines))
	copy(lines, job.logLines)
	phase := job.run.Phase
	if phase == "" {
		phase = "正在运行"
	}
	return &ActiveNQJobInfo{
		ID:        job.run.ID,
		Mode:      job.run.Mode,
		Phase:     phase,
		StartedAt: job.run.StartedAt,
		LogLines:  lines,
	}
}

func subscribeNodeQualityJob(serverID string) (chan nqEvent, func()) {
	nqJobsMu.Lock()
	job := activeJobs[serverID]
	nqJobsMu.Unlock()
	if job == nil {
		return nil, func() {}
	}
	ch := make(chan nqEvent, 128)
	job.mu.Lock()
	job.listeners[ch] = struct{}{}
	job.mu.Unlock()
	return ch, func() {
		job.mu.Lock()
		delete(job.listeners, ch)
		job.mu.Unlock()
	}
}

func emitNQJob(job *activeNQJob, evType string, data any) {
	job.mu.Lock()
	defer job.mu.Unlock()
	for ch := range job.listeners {
		select {
		case ch <- nqEvent{Type: evType, Data: data}:
		default:
		}
	}
}

func cancelNodeQualityJob(serverID string) bool {
	nqJobsMu.Lock()
	job := activeJobs[serverID]
	if job == nil {
		nqJobsMu.Unlock()
		return false
	}
	delete(activeJobs, serverID)
	nqJobsMu.Unlock()

	job.mu.Lock()
	job.cancelled = true
	proc := job.proc
	job.run.Status = "cancelled"
	job.run.FinishedAt = time.Now().UTC().Format(time.RFC3339)
	job.run.Phase = "已取消"
	runCopy := job.run
	job.mu.Unlock()

	if proc != nil {
		proc.Kill()
	}
	_ = saveNodeQualityRun(runCopy)
	emitNQJob(job, "done", map[string]any{"status": "cancelled", "runId": runCopy.ID})
	return true
}

var (
	reAnsiCSI      = regexp.MustCompile(`\x1b\[[0-9;?]*[a-zA-Z]`)
	reAnsiOSC      = regexp.MustCompile(`\x1b\][^\x07]*\x07`)
	reSpinnerBan   = regexp.MustCompile(`[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*\d+%\s*([#+*]{20,}.*)$`)
	reSpinnerOnly  = regexp.MustCompile(`[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*\d+%`)
	reProgressLine = regexp.MustCompile(`^[\s#O=-]*\d+\.\d+%[\s#O=-]*$`)
	reSponsor      = regexp.MustCompile(`(?i)(SPONSORSPONSOR|LISAHOST|VMRACK|RFCHOST|KFCHOST|SWIFTPROXY|RAPIDPROXY|丽萨主机|VMRack\s+CN2|RFChost|KFChost|Swiftproxy|RapidProxy|affid=ipcheck|PROXY90)`)
	reNQReportURL  = regexp.MustCompile(`(?i)https?://(?:www\.)?nodequality\.com/r/[A-Za-z0-9_-]+`)
	reNumFloat     = regexp.MustCompile(`(\d+(?:\.\d+)?)`)
	reNumFloatHead = regexp.MustCompile(`^(\d+(?:\.\d+)?)`)
)

func stripAnsi(s string) string {
	s = reAnsiCSI.ReplaceAllString(s, "")
	s = reAnsiOSC.ReplaceAllString(s, "")
	return strings.ReplaceAll(s, "\u200b", "")
}

func isRepeatedUpperBanner(s string) bool {
	s = strings.TrimSpace(s)
	if len(s) < 16 {
		return false
	}
	for _, r := range s {
		if r < 'A' || r > 'Z' {
			return false
		}
	}
	for pLen := 4; pLen <= 14 && pLen*4 <= len(s); pLen++ {
		unit := s[:pLen]
		if strings.Repeat(unit, 4) == s[:pLen*4] {
			return true
		}
	}
	return false
}

func cleanReportText(raw string) string {
	if raw == "" {
		return ""
	}
	noAnsi := stripAnsi(raw)
	out := []string{}
	for _, rawLine := range strings.Split(noAnsi, "\n") {
		crParts := []string{}
		for _, p := range strings.Split(rawLine, "\r") {
			if strings.TrimSpace(p) != "" {
				crParts = append(crParts, p)
			}
		}
		if len(crParts) == 0 {
			continue
		}
		line := strings.TrimRight(crParts[len(crParts)-1], " \t")
		if line == "" {
			continue
		}
		if m := reSpinnerBan.FindStringSubmatch(line); m != nil {
			line = m[1]
		} else if reSpinnerOnly.MatchString(line) {
			continue
		}
		if reProgressLine.MatchString(line) || (strings.Contains(line, "####") && strings.Contains(line, "%")) {
			continue
		}
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "#=#=#") {
			continue
		}
		if reSponsor.MatchString(line) || isRepeatedUpperBanner(trimmed) {
			continue
		}
		if strings.Contains(line, "TERM environment variable not set") {
			continue
		}
		out = append(out, line)
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}

func emptySummary() NodeQualitySummary {
	return NodeQualitySummary{
		IP: NodeQualityIPSummary{
			RiskLevel:   "unknown",
			RiskSources: []NodeQualityRiskSource{},
			TypeMatrix:  []NodeQualityTypeMatrixRow{},
			RiskFactors: []NodeQualityRiskFactorRow{},
		},
		Unlocks:  []NodeQualityUnlock{},
		Hardware: NodeQualityHardwareSummary{},
		Network: NodeQualityNetworkSummary{
			Delays:          []NodeQualityDelayRow{},
			Transfers:       []NodeQualityTransferRow{},
			Routes:          []NodeQualityRoute{},
			BackrouteTraces: []NodeQualityBackrouteTrace{},
			Speedtests:      []NodeQualitySpeedtestRow{},
		},
	}
}

func detectPhase(line, current string) string {
	lower := strings.ToLower(line)
	switch {
	case strings.Contains(lower, "load benchos") || strings.Contains(line, "加载 BenchOs"):
		return "加载 BenchOS 沙盒环境"
	case strings.Contains(lower, "hardware info") || strings.Contains(line, "硬件信息"):
		return "采集基础硬件信息"
	case strings.Contains(lower, "hardware quality") || strings.Contains(line, "硬件质量测试"):
		return "运行 HardwareQuality 硬件基准测试"
	case strings.Contains(lower, "ip quality") || strings.Contains(line, "IP 质量测试"):
		return "运行 IPQuality 质量与流媒体解锁测试"
	case strings.Contains(lower, "network quality") || strings.Contains(line, "网络质量测试"):
		return "运行 NetQuality 网络质量测试"
	case strings.Contains(lower, "backroute") || strings.Contains(line, "回程路由追踪"):
		return "运行三网回程路由追踪"
	case strings.Contains(line, "nodequality.com/r/") || strings.Contains(line, "api.nodequality.com"):
		return "上传并生成官方报告"
	case strings.Contains(line, "安装后清理") || strings.Contains(lower, "clean up after"):
		return "清理测试沙盒并汇总结果"
	}
	return current
}

func answersForMode(mode string) string {
	switch mode {
	case "full":
		return `y\ny\ny\ny\n`
	case "ip_hw":
		return `f\ny\nn\nn\n`
	case "net":
		return `n\nn\nl\ny\n`
	default:
		return `f\ny\nl\ny\n`
	}
}

const patchNQScriptPy = `
import sys
sf, sd = sys.argv[1], sys.argv[2]
with open(sf, 'r', encoding='utf-8', errors='replace') as f:
    src = f.read()

src = src.replace('curl "-L#o" BenchOs.tar.gz', 'curl -sLo BenchOs.tar.gz')

copy_cmd = f'mkdir -p "{sd}" && cp -a "$result_directory"/. "{sd}/" 2>/dev/null || true'
if '    upload_result' in src:
    src = src.replace('    upload_result', f'    {copy_cmd}\n    upload_result', 1)
elif '    post_cleanup' in src:
    src = src.replace('    post_cleanup', f'    {copy_cmd}\n    post_cleanup', 1)

src = src.replace('    exit 1\n}\n\nfunction sig_cleanup', '    exit 0\n}\n\nfunction sig_cleanup')

with open(sf, 'w', encoding='utf-8') as f:
    f.write(src)
`

func startNodeQualityJob(srv ServerConfig, mode string) (NodeQualityRun, error) {
	nqJobsMu.Lock()
	if _, exists := activeJobs[srv.ID]; exists {
		nqJobsMu.Unlock()
		return NodeQualityRun{}, errors.New("该服务器当前已有正在运行的 NodeQuality 测试任务")
	}

	runID := fmt.Sprintf("nq_%d_%s", time.Now().UnixMilli(), randomHex(3))
	run := NodeQualityRun{
		ID:        runID,
		ServerID:  srv.ID,
		Mode:      mode,
		Status:    "running",
		StartedAt: time.Now().UTC().Format(time.RFC3339),
		Phase:     "初始化测试环境",
		Summary:   emptySummary(),
	}
	_ = saveNodeQualityRun(run)

	saveDir := "/tmp/atlasnode-nq-" + runID
	runnerScript := strings.Join([]string{
		"set -o pipefail",
		"export TERM=xterm-256color",
		fmt.Sprintf(`SAVE_DIR="%s"`, saveDir),
		fmt.Sprintf(`SCRIPT_FILE="/tmp/atlasnode-nq-script-%s.sh"`, runID),
		`mkdir -p "$SAVE_DIR"`,
		`echo "[AtlasNode] 正在获取官方 NodeQuality 脚本..."`,
		`curl -sL --max-time 30 https://run.NodeQuality.com -o "$SCRIPT_FILE"`,
		`if [ ! -s "$SCRIPT_FILE" ]; then echo "[AtlasNode] 下载 NodeQuality 脚本失败" >&2; exit 1; fi`,
		`python3 - "$SCRIPT_FILE" "$SAVE_DIR" <<'PYEOF'`,
		strings.TrimSpace(patchNQScriptPy),
		`PYEOF`,
		fmt.Sprintf(`echo "[AtlasNode] 启动 NodeQuality 测试 (模式: %s)..."`, mode),
		fmt.Sprintf(`printf '%s' | bash "$SCRIPT_FILE" -d /tmp || true`, answersForMode(mode)),
		`rm -f "$SCRIPT_FILE"`,
		`echo "[AtlasNode] NODEQUALITY_EXEC_DONE"`,
	}, "\n")

	proc, err := spawnScriptStream(srv, runnerScript, ExecOpts{Sudo: true})
	if err != nil {
		nqJobsMu.Unlock()
		run.Status = "failed"
		run.Error = err.Error()
		run.FinishedAt = time.Now().UTC().Format(time.RFC3339)
		_ = saveNodeQualityRun(run)
		return NodeQualityRun{}, err
	}

	job := &activeNQJob{
		run:       run,
		proc:      proc,
		logLines:  []string{},
		listeners: map[chan nqEvent]struct{}{},
	}
	activeJobs[srv.ID] = job
	nqJobsMu.Unlock()

	go runNodeQualityWorker(srv, job, saveDir)
	return run, nil
}

func runNodeQualityWorker(srv ServerConfig, job *activeNQJob, saveDir string) {
	var bufMu sync.Mutex
	buffer := ""

	processText := func(text string) {
		bufMu.Lock()
		buffer += stripAnsi(text)
		parts := strings.Split(buffer, "\n")
		buffer = parts[len(parts)-1]
		lines := parts[:len(parts)-1]
		bufMu.Unlock()

		for _, rawLine := range lines {
			cleaned := cleanReportText(rawLine)
			if cleaned == "" {
				continue
			}
			for _, line := range strings.Split(cleaned, "\n") {
				if strings.TrimSpace(line) == "" {
					continue
				}
				job.mu.Lock()
				job.logLines = append(job.logLines, line)
				if len(job.logLines) > 2500 {
					job.logLines = job.logLines[len(job.logLines)-2500:]
				}
				var newURL, newPhase string
				if m := reNQReportURL.FindString(line); m != "" {
					job.run.ReportURL = m
					newURL = m
				}
				np := detectPhase(line, job.run.Phase)
				if np != job.run.Phase {
					job.run.Phase = np
					newPhase = np
				}
				job.mu.Unlock()

				if newURL != "" {
					emitNQJob(job, "reportUrl", map[string]string{"reportUrl": newURL})
				}
				if newPhase != "" {
					emitNQJob(job, "phase", map[string]string{"phase": newPhase})
				}
				emitNQJob(job, "log", map[string]string{"line": line})
			}
		}
	}

	pump := func(r io.Reader) {
		b := make([]byte, 4096)
		for {
			n, err := r.Read(b)
			if n > 0 {
				processText(string(b[:n]))
			}
			if err != nil {
				return
			}
		}
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); pump(job.proc.Stdout) }()
	go func() { defer wg.Done(); pump(job.proc.Stderr) }()
	code := job.proc.Wait()
	wg.Wait()

	bufMu.Lock()
	if strings.TrimSpace(buffer) != "" {
		if last := cleanReportText(buffer); last != "" {
			job.mu.Lock()
			job.logLines = append(job.logLines, last)
			job.mu.Unlock()
		}
	}
	bufMu.Unlock()

	job.mu.Lock()
	if job.cancelled {
		job.mu.Unlock()
		return
	}
	combinedLog := strings.Join(job.logLines, "\n")
	job.mu.Unlock()

	emitNQJob(job, "phase", map[string]string{"phase": "提取并解析结构化测试报告"})
	fetched, err := fetchAndCleanRemoteResults(srv, saveDir)

	job.mu.Lock()
	if err != nil {
		job.run.Status = "failed"
		job.run.Error = err.Error()
		job.run.Phase = "解析失败"
		job.run.FinishedAt = time.Now().UTC().Format(time.RFC3339)
		job.run.Logs.Combined = tailString(combinedLog, 160_000)
		runCopy := job.run
		job.mu.Unlock()
		_ = saveNodeQualityRun(runCopy)
		emitNQJob(job, "done", map[string]any{"status": "failed", "runId": runCopy.ID, "error": runCopy.Error})
	} else {
		job.run.Logs = NodeQualityLogs{
			Header:    cleanReportText(fetched.Logs.Header),
			Hardware:  cleanReportText(fetched.Logs.Hardware),
			IP:        cleanReportText(fetched.Logs.IP),
			Net:       cleanReportText(fetched.Logs.Net),
			Backroute: cleanReportText(fetched.Logs.Backroute),
			Combined:  tailString(combinedLog, 160_000),
		}
		job.run.RawJSON = &fetched.RawJSON
		job.run.Summary = parseNodeQualityResults(fetched.RawJSON, job.run.Logs, srv)

		hasData := job.run.ReportURL != "" ||
			fetched.RawJSON.IP != nil || fetched.RawJSON.Hardware != nil ||
			fetched.RawJSON.Net != nil || fetched.RawJSON.Backroute != nil ||
			fetched.Logs.IP != "" || fetched.Logs.Hardware != "" ||
			fetched.Logs.Net != "" || fetched.Logs.Backroute != "" ||
			strings.Contains(combinedLog, "体检报告")

		if hasData || code == 0 {
			job.run.Status = "completed"
			job.run.Phase = "已完成"
		} else {
			job.run.Status = "failed"
			job.run.Error = "NodeQuality 执行未产出有效报告数据，请查看日志详情"
			job.run.Phase = "执行失败"
		}
		job.run.FinishedAt = time.Now().UTC().Format(time.RFC3339)
		runCopy := job.run
		job.mu.Unlock()
		_ = saveNodeQualityRun(runCopy)
		if runCopy.Status == "completed" {
			go checkNodeQualityDegradation(srv, runCopy)
		}
		emitNQJob(job, "done", map[string]any{"status": runCopy.Status, "runId": runCopy.ID})
	}

	nqJobsMu.Lock()
	if activeJobs[srv.ID] == job {
		delete(activeJobs, srv.ID)
	}
	nqJobsMu.Unlock()
}

func tailString(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[len(s)-maxLen:]
}

var autoNQOnce sync.Once

func defaultAutoNQConfig() AutoNQConfig {
	return AutoNQConfig{
		Enabled:        false,
		IntervalDays:   7,
		Mode:           "fast",
		AlertOnDegrade: true,
	}
}

func loadAutoNQConfig() AutoNQConfig {
	cfg := defaultAutoNQConfig()
	readJSON(filepath.Join(getDataDir(), "nq-schedule.json"), &cfg)
	if cfg.IntervalDays <= 0 {
		cfg.IntervalDays = 7
	}
	if cfg.Mode == "" {
		cfg.Mode = "fast"
	}
	return cfg
}

func saveAutoNQConfig(cfg AutoNQConfig) error {
	if cfg.IntervalDays < 1 {
		cfg.IntervalDays = 7
	}
	if cfg.Mode != "fast" && cfg.Mode != "full" && cfg.Mode != "ip_hw" && cfg.Mode != "net" {
		cfg.Mode = "fast"
	}
	return writeJSONAtomic(filepath.Join(getDataDir(), "nq-schedule.json"), cfg)
}

func riskRank(level string) int {
	switch level {
	case "low":
		return 1
	case "medium":
		return 2
	case "high":
		return 3
	default:
		return 0
	}
}

func isUnlockUsable(status string) bool {
	return status == "native" || status == "unlocked" || status == "dns"
}

func checkNodeQualityDegradation(srv ServerConfig, current NodeQualityRun) {
	autoCfg := loadAutoNQConfig()
	if !autoCfg.AlertOnDegrade {
		return
	}
	alertCfg := loadAlertConfig()
	hasChannel := (alertCfg.Telegram.Enabled && alertCfg.Telegram.BotToken != "" && alertCfg.Telegram.ChatID != "") ||
		(alertCfg.Webhook.Enabled && alertCfg.Webhook.URL != "") ||
		(alertCfg.Bark.Enabled && alertCfg.Bark.URL != "")
	if !hasChannel {
		return
	}

	runs := listNodeQualityRuns(srv.ID)
	var prev *NodeQualityRun
	for i := range runs {
		if runs[i].ID == current.ID || runs[i].Status != "completed" {
			continue
		}
		cp := runs[i]
		prev = &cp
		break
	}
	if prev == nil {
		return
	}

	reasons := []string{}
	curRisk := riskRank(current.Summary.IP.RiskLevel)
	prevRisk := riskRank(prev.Summary.IP.RiskLevel)
	if curRisk > 0 && prevRisk > 0 && curRisk > prevRisk {
		reasons = append(reasons, fmt.Sprintf("IP 风控等级上升：%s → %s", prev.Summary.IP.RiskLevel, current.Summary.IP.RiskLevel))
	}

	if current.Summary.IP.BlacklistHit != nil && prev.Summary.IP.BlacklistHit != nil && *current.Summary.IP.BlacklistHit > *prev.Summary.IP.BlacklistHit {
		reasons = append(reasons, fmt.Sprintf("黑名单命中增加：%d → %d", *prev.Summary.IP.BlacklistHit, *current.Summary.IP.BlacklistHit))
	}

	keyServices := map[string]bool{
		"chatgpt": true, "openai": true, "claude": true, "gemini": true,
		"netflix": true, "youtube": true, "disney+": true, "tiktok": true,
	}
	prevMap := map[string]string{}
	for _, u := range prev.Summary.Unlocks {
		prevMap[strings.ToLower(strings.TrimSpace(u.Service))] = u.Status
	}
	dropped := []string{}
	for _, u := range current.Summary.Unlocks {
		k := strings.ToLower(strings.TrimSpace(u.Service))
		if !keyServices[k] {
			continue
		}
		if ps, ok := prevMap[k]; ok && isUnlockUsable(ps) && u.Status == "blocked" {
			dropped = append(dropped, u.Service)
		}
	}
	if len(dropped) > 0 {
		reasons = append(reasons, "核心解锁失效："+strings.Join(dropped, "、"))
	}

	if len(reasons) == 0 {
		return
	}

	msg := fmt.Sprintf("节点 [%s] NodeQuality 复测发现质量下降：%s", srv.Name, strings.Join(reasons, "；"))
	delivered, _ := deliverAlert(alertCfg, "⚠️ AtlasNode 节点质检降级 · "+srv.Name, msg)
	appendAlertHistory(AlertEvent{
		ID:         fmt.Sprintf("al_%d_%s", time.Now().UnixMilli(), randomHex(2)),
		TS:         time.Now().UTC().Format(time.RFC3339),
		ServerID:   srv.ID,
		ServerName: srv.Name,
		Kind:       "nodequality",
		Message:    msg,
		Delivered:  delivered,
	})
}

func startAutoNodeQualityScheduler() {
	autoNQOnce.Do(func() {
		go func() {
			time.Sleep(2 * time.Minute)
			ticker := time.NewTicker(30 * time.Minute)
			defer ticker.Stop()
			check := func() {
				cfg := loadAutoNQConfig()
				if !cfg.Enabled || cfg.IntervalDays <= 0 {
					return
				}
				due := time.Duration(cfg.IntervalDays) * 24 * time.Hour
				for _, srv := range loadServers() {
					// Re-check enabled in case user turned it off mid-cycle
					if !loadAutoNQConfig().Enabled {
						return
					}
					if !srv.IsProxyEnabled() {
						continue
					}
					if getActiveNodeQualityJob(srv.ID) != nil {
						continue
					}
					latest := getLatestNodeQualityRun(srv.ID)
					needsRun := true
					if latest != nil {
						tsStr := latest.FinishedAt
						if tsStr == "" {
							tsStr = latest.StartedAt
						}
						if t, err := time.Parse(time.RFC3339, tsStr); err == nil && time.Since(t) < due {
							needsRun = false
						}
					}
					if !needsRun {
						continue
					}
					if _, err := startNodeQualityJob(srv, cfg.Mode); err != nil {
						continue
					}
					// Wait sequentially so we only run 1 NodeQuality test across the fleet at a time
					deadline := time.Now().Add(12 * time.Minute)
					for time.Now().Before(deadline) {
						time.Sleep(5 * time.Second)
						if getActiveNodeQualityJob(srv.ID) == nil {
							break
						}
					}
				}
			}
			check()
			for range ticker.C {
				check()
			}
		}()
	})
}

const fetchRemoteResultsPy = `
import json, os, shutil, sys

d = sys.argv[1]
def read_text(name, max_len=160000):
    p = os.path.join(d, name)
    if not os.path.isfile(p): return ''
    with open(p, 'r', encoding='utf-8', errors='replace') as f:
        return f.read(max_len)

def read_json(name):
    txt = read_text(name, 800000)
    if not txt: return None
    try:
        return json.loads(txt)
    except Exception:
        return None

out = {
    'rawJson': {
        'hardware': read_json('hardware_quality.json'),
        'ip': read_json('ip_quality.json'),
        'net': read_json('net_quality.json'),
        'backroute': read_json('backroute_trace.json'),
    },
    'logs': {
        'header': read_text('header_info.log'),
        'hardware': read_text('hardware_quality.log'),
        'ip': read_text('ip_quality.log'),
        'net': read_text('net_quality.log'),
        'backroute': read_text('backroute_trace.log'),
    }
}
shutil.rmtree(d, ignore_errors=True)
print(json.dumps(out))
`

type fetchedNQResults struct {
	RawJSON NodeQualityRawJSON `json:"rawJson"`
	Logs    NodeQualityLogs    `json:"logs"`
}

func fetchAndCleanRemoteResults(srv ServerConfig, saveDir string) (fetchedNQResults, error) {
	res, err := execScript(srv, "python3 - \"$1\" <<'PYEOF'\n"+fetchRemoteResultsPy+"\nPYEOF\n", ExecOpts{
		Args:      []string{saveDir},
		Timeout:   20 * time.Second,
		Sudo:      true,
		MaxBuffer: 16 * 1024 * 1024,
	})
	if err != nil {
		return fetchedNQResults{}, err
	}
	var out fetchedNQResults
	if err := json.Unmarshal([]byte(strings.TrimSpace(res.Stdout)), &out); err != nil {
		return fetchedNQResults{}, err
	}
	return out, nil
}

// ---------- Parser helpers ----------

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func asSlice(v any) []any {
	s, _ := v.([]any)
	return s
}

func nonNull(v any) string {
	if v == nil {
		return ""
	}
	var s string
	switch x := v.(type) {
	case string:
		s = strings.TrimSpace(x)
	case float64:
		if math.Trunc(x) == x {
			s = strconv.FormatInt(int64(x), 10)
		} else {
			s = strconv.FormatFloat(x, 'f', -1, 64)
		}
	case bool:
		if x {
			s = "true"
		} else {
			s = "false"
		}
	default:
		s = strings.TrimSpace(fmt.Sprint(v))
	}
	low := strings.ToLower(s)
	if s == "" || low == "null" || s == "N/A" || s == "无" || s == "NoRecord" {
		return ""
	}
	return s
}

func posIntPtr(v any) *int {
	if f, ok := v.(float64); ok && !math.IsNaN(f) && !math.IsInf(f, 0) && f >= 0 {
		n := int(f)
		return &n
	}
	return nil
}

func boolPtr(b bool) *bool { return &b }

func classifyRiskFromText(text string) string {
	low := strings.ToLower(text)
	if strings.Contains(text, "极低") || strings.Contains(text, "低风险") || text == "低" ||
		strings.Contains(low, "very low") || strings.Contains(low, "low") || strings.Contains(low, "clean") {
		return "low"
	}
	if strings.Contains(text, "中等") || strings.Contains(text, "中风险") || text == "中" ||
		strings.Contains(low, "medium") || strings.Contains(low, "moderate") {
		return "medium"
	}
	if strings.Contains(text, "极高") || strings.Contains(text, "高风险") || text == "高" ||
		strings.Contains(low, "high") || strings.Contains(low, "elevated") || strings.Contains(low, "critical") {
		return "high"
	}
	if m := reNumFloat.FindStringSubmatch(text); m != nil {
		n, _ := strconv.ParseFloat(m[1], 64)
		if strings.Contains(text, "%") {
			if n <= 1 {
				return "low"
			}
			if n <= 10 {
				return "medium"
			}
			return "high"
		}
		if n <= 25 {
			return "low"
		}
		if n <= 60 {
			return "medium"
		}
		return "high"
	}
	return "unknown"
}

func formatRiskDisplay(rawScore, level string) string {
	if strings.Contains(rawScore, "|") || strings.Contains(rawScore, "风险") {
		return rawScore
	}
	label := ""
	switch level {
	case "low":
		if strings.Contains(rawScore, "%") && strings.HasPrefix(rawScore, "0") {
			label = "极低风险"
		} else {
			label = "低风险"
		}
	case "medium":
		label = "中等风险"
	case "high":
		label = "高风险"
	}
	if label != "" {
		return rawScore + " · " + label
	}
	return rawScore
}

func classifyUnlockStatus(statusText, typeText string) string {
	s := strings.ToLower(statusText)
	t := strings.ToLower(typeText)
	if strings.Contains(s, "失败") || strings.Contains(s, "error") || strings.Contains(s, "timeout") {
		return "failed"
	}
	if strings.Contains(s, "屏蔽") || strings.Contains(s, "阻断") || strings.Contains(s, "不支持") || strings.Contains(s, "block") || s == "no" {
		return "blocked"
	}
	if strings.Contains(s, "仅app") || strings.Contains(s, "only app") || strings.Contains(s, "app") {
		return "app_only"
	}
	if strings.Contains(t, "dns") || strings.Contains(s, "dns") {
		return "dns"
	}
	if strings.Contains(t, "原生") || strings.Contains(t, "native") || strings.Contains(s, "原生") {
		return "native"
	}
	if strings.Contains(s, "解锁") || strings.Contains(s, "unlock") || strings.Contains(s, "yes") || strings.Contains(s, "可用") {
		return "unlocked"
	}
	return "unknown"
}

var reBlockEnd = regexp.MustCompile(`={20,}[\s\S]*?(?:报告链接：[^\n]+|感谢使用[^\n]+)`)

func extractCleanBlock(text, marker string) string {
	idx := strings.Index(text, marker)
	if idx < 0 {
		return ""
	}
	start := 0
	if idx > 80 {
		if nl := strings.LastIndex(text[:idx-80], "\n"); nl > 0 {
			start = nl
		}
	}
	rest := text[start:]
	if loc := reBlockEnd.FindStringIndex(rest); loc != nil {
		return rest[:loc[1]]
	}
	if len(rest) > 14_000 {
		return rest[:14_000]
	}
	return rest
}

func extractBetween(text, startMarker, endMarker string) string {
	s := strings.Index(text, startMarker)
	if s < 0 {
		return ""
	}
	rest := text[s:]
	if endMarker != "" {
		if e := strings.Index(rest[len(startMarker):], endMarker); e >= 0 {
			return rest[:len(startMarker)+e]
		}
	}
	return rest
}

var (
	reBTHeader = regexp.MustCompile(`^\s*(\p{Han}{2,4})\s+(电信|联通|移动)\s+(.+)$`)
	reBTGeo    = regexp.MustCompile(`地理路径[：:]\s*([^\t]+?)(?:\s{2,}自治系统路径|$)`)
	reBTASN    = regexp.MustCompile(`自治系统路径[：:]\s*(.+)$`)
	reBTHop    = regexp.MustCompile(`^\s*\d+(?:-\d+)?\s+\d+(?:\.\d+)?ms`)
)

func parseBackrouteTraces(btBlock string) []NodeQualityBackrouteTrace {
	traces := []NodeQualityBackrouteTrace{}
	if btBlock == "" {
		return traces
	}
	var current *NodeQualityBackrouteTrace
	for _, rawLine := range strings.Split(btBlock, "\n") {
		line := strings.TrimRight(rawLine, " \t\r")
		if m := reBTHeader.FindStringSubmatch(line); m != nil {
			if current != nil {
				traces = append(traces, *current)
			}
			current = &NodeQualityBackrouteTrace{
				City:     m[1],
				ISP:      m[2],
				LineType: strings.TrimSpace(m[3]),
				Hops:     []string{},
			}
			continue
		}
		if current == nil {
			continue
		}
		if strings.Contains(line, "地理路径：") || strings.Contains(line, "自治系统路径：") {
			if gm := reBTGeo.FindStringSubmatch(line); gm != nil {
				current.GeoPath = strings.TrimSpace(gm[1])
			}
			if am := reBTASN.FindStringSubmatch(line); am != nil {
				current.ASNPath = strings.TrimSpace(am[1])
			}
			continue
		}
		if reBTHop.MatchString(line) {
			current.Hops = append(current.Hops, strings.TrimSpace(line))
		}
	}
	if current != nil {
		traces = append(traces, *current)
	}
	return traces
}

func formatBytesSimple(bytes float64) string {
	if bytes <= 0 || math.IsNaN(bytes) {
		return "0 B"
	}
	units := []string{"B", "KB", "MB", "GB", "TB"}
	i := int(math.Floor(math.Log(bytes) / math.Log(1024)))
	if i >= len(units) {
		i = len(units) - 1
	}
	return fmt.Sprintf("%.1f %s", bytes/math.Pow(1024, float64(i)), units[i])
}

func reparseNodeQualityRun(run NodeQualityRun, srv ServerConfig) NodeQualityRun {
	cleaned := NodeQualityLogs{
		Header:    cleanReportText(run.Logs.Header),
		Hardware:  cleanReportText(run.Logs.Hardware),
		IP:        cleanReportText(run.Logs.IP),
		Net:       cleanReportText(run.Logs.Net),
		Backroute: cleanReportText(run.Logs.Backroute),
		Combined:  cleanReportText(run.Logs.Combined),
	}
	if cleaned.IP == "" && cleaned.Combined != "" {
		cleaned.IP = extractCleanBlock(cleaned.Combined, "IP质量体检报告")
	}
	if cleaned.Hardware == "" && cleaned.Combined != "" {
		cleaned.Hardware = extractCleanBlock(cleaned.Combined, "硬件质量体检报告")
	}
	if cleaned.Net == "" && cleaned.Combined != "" {
		cleaned.Net = extractCleanBlock(cleaned.Combined, "网络质量体检报告")
	}
	var raw NodeQualityRawJSON
	if run.RawJSON != nil {
		raw = *run.RawJSON
	}
	run.Logs = cleaned
	run.Summary = parseNodeQualityResults(raw, cleaned, srv)
	return run
}

var (
	reIPSvg        = regexp.MustCompile(`(?i)https://Report\.Check\.Place/ip/[A-Za-z0-9_-]+\.svg`)
	reHWSvg        = regexp.MustCompile(`(?i)https://Report\.Check\.Place/hardware/[A-Za-z0-9_-]+\.svg`)
	reNetSvg       = regexp.MustCompile(`(?i)https://Report\.Check\.Place/net/[A-Za-z0-9_-]+\.svg`)
	reScoreLine    = regexp.MustCompile(`^\s*([A-Za-z0-9_-]+)[：:]\s*(.+)$`)
	reBLSummary    = regexp.MustCompile(`有效\s*(\d+)\s+正常\s*(\d+)\s+已标记\s*(\d+)\s+黑名单\s*(\d+)`)
	reFlagCheck    = regexp.MustCompile(`([✔✘])\s*([^\s✔✘]+)`)
	reFio4k        = regexp.MustCompile(`(?i)4k[^\n]*?(\d+(?:\.\d+)?\s*[MGK]B/s)[^\n]*?(\d+(?:\.\d+)?\s*[MGK]B/s)`)
	reFio1m        = regexp.MustCompile(`(?i)1m[^\n]*?(\d+(?:\.\d+)?\s*[MGK]B/s)[^\n]*?(\d+(?:\.\d+)?\s*[MGK]B/s)`)
	reDDSpeed      = regexp.MustCompile(`(?i)(?:DD|顺序读写|Disk Speed)[^0-9\n]*(\d+(?:\.\d+)?\s*[MG]B/s)`)
	reCompactRoute = regexp.MustCompile(`^(北京|上海|广州)(TCP|UDP)[：:]\s*(.+)$`)
	reCompactISP   = regexp.MustCompile(`^(电信|联通|移动)\s+(.+)$`)
)

func matchOne(text, pattern string) string {
	re := regexp.MustCompile(pattern)
	if m := re.FindStringSubmatch(text); len(m) > 1 {
		return strings.TrimSpace(m[1])
	}
	return ""
}

func parseNodeQualityResults(rawJson NodeQualityRawJSON, logs NodeQualityLogs, srv ServerConfig) NodeQualitySummary {
	summary := emptySummary()
	cleanCombined := cleanReportText(logs.Combined)
	ipBlock := cleanReportText(logs.IP)
	if ipBlock == "" {
		ipBlock = extractCleanBlock(cleanCombined, "IP质量体检报告")
	}
	hwBlock := cleanReportText(logs.Hardware)
	if hwBlock == "" {
		hwBlock = extractCleanBlock(cleanCombined, "硬件质量体检报告")
	}
	netBlock := cleanReportText(logs.Net)
	if netBlock == "" {
		netBlock = extractCleanBlock(cleanCombined, "网络质量体检报告")
	}
	btBlock := cleanReportText(logs.Backroute)

	// 1) IP QUALITY
	if ipj := asMap(rawJson.IP); ipj != nil {
		info := asMap(ipj["Info"])
		head := asMap(ipj["Head"])
		headIP := nonNull(head["IP"])
		if headIP != "" && !strings.Contains(headIP, "*") {
			summary.IP.IPv4 = headIP
		} else {
			summary.IP.IPv4 = firstNonEmpty(srv.PublicIP, headIP)
		}
		if rawASN := nonNull(info["ASN"]); rawASN != "" {
			if strings.HasPrefix(rawASN, "AS") {
				summary.IP.ASN = rawASN
			} else {
				summary.IP.ASN = "AS" + rawASN
			}
		}
		summary.IP.Org = nonNull(info["Organization"])

		reg := asMap(info["Region"])
		rc, rn := nonNull(reg["Code"]), nonNull(reg["Name"])
		if rc != "" && rn != "" {
			summary.IP.Country = "[" + rc + "] " + rn
		} else {
			summary.IP.Country = firstNonEmpty(rn, rc)
		}

		cont := asMap(info["Continent"])
		cc, cn := nonNull(cont["Code"]), nonNull(cont["Name"])
		if cc != "" && cn != "" {
			summary.IP.Continent = "[" + cc + "] " + cn
		} else {
			summary.IP.Continent = firstNonEmpty(cn, cc)
		}

		rreg := asMap(info["RegisteredRegion"])
		rrc, rrn := nonNull(rreg["Code"]), nonNull(rreg["Name"])
		if rrc != "" && rrn != "" {
			summary.IP.RegisteredCountry = "[" + rrc + "] " + rrn
		} else {
			summary.IP.RegisteredCountry = firstNonEmpty(rrn, rrc)
		}
		summary.IP.City = nonNull(asMap(info["City"])["Name"])
		summary.IP.Timezone = nonNull(info["TimeZone"])
		summary.IP.MapURL = nonNull(info["Map"])

		if t := nonNull(info["Type"]); t != "" {
			summary.IP.IPType = t
			if strings.Contains(t, "原生") || strings.Contains(strings.ToLower(t), "native") {
				summary.IP.IsNative = boolPtr(true)
			} else if strings.Contains(t, "广播") || strings.Contains(strings.ToLower(t), "broadcast") {
				summary.IP.IsNative = boolPtr(false)
			}
		}

		// Type matrix
		typeObj := asMap(ipj["Type"])
		usage := asMap(typeObj["Usage"])
		company := asMap(typeObj["Company"])
		seenP := map[string]bool{}
		providers := []string{}
		for _, m := range []map[string]any{usage, company} {
			for k := range m {
				if !seenP[k] {
					seenP[k] = true
					providers = append(providers, k)
				}
			}
		}
		for _, p := range providers {
			u, c := nonNull(usage[p]), nonNull(company[p])
			if u != "" || c != "" {
				summary.IP.TypeMatrix = append(summary.IP.TypeMatrix, NodeQualityTypeMatrixRow{
					Provider: p, Usage: u, Company: c,
				})
			}
		}
		if len(summary.IP.TypeMatrix) > 0 {
			summary.IP.UsageType = firstNonEmpty(summary.IP.TypeMatrix[0].Usage, summary.IP.TypeMatrix[0].Company)
		}

		// Risk scores
		nums := []float64{}
		for k, v := range asMap(ipj["Score"]) {
			sv := nonNull(v)
			if sv == "" {
				continue
			}
			lvl := classifyRiskFromText(sv)
			if m := reNumFloat.FindStringSubmatch(sv); m != nil && !strings.Contains(sv, "%") {
				if n, err := strconv.ParseFloat(m[1], 64); err == nil && n <= 100 {
					nums = append(nums, n)
				}
			}
			summary.IP.RiskSources = append(summary.IP.RiskSources, NodeQualityRiskSource{
				Name: k, Score: formatRiskDisplay(sv, lvl), Level: lvl,
			})
		}
		if len(nums) > 0 {
			sum := 0.0
			for _, n := range nums {
				sum += n
			}
			avg := int(math.Round(sum / float64(len(nums))))
			summary.IP.RiskScore = &avg
		}
		if len(summary.IP.RiskSources) > 0 {
			highs, meds := 0, 0
			for _, r := range summary.IP.RiskSources {
				if r.Level == "high" {
					highs++
				} else if r.Level == "medium" {
					meds++
				}
			}
			if highs >= 1 {
				summary.IP.RiskLevel = "high"
			} else if meds >= 2 {
				summary.IP.RiskLevel = "medium"
			} else {
				summary.IP.RiskLevel = "low"
			}
		}

		// Factor matrix (transposed: factor -> provider => provider -> factors)
		if factorObj := asMap(ipj["Factor"]); factorObj != nil {
			factorKeys := []string{"CountryCode", "Proxy", "Tor", "VPN", "Server", "Abuser", "Robot"}
			fmtBool := func(val any) string {
				if b, ok := val.(bool); ok {
					if b {
						return "是"
					}
					return "否"
				}
				if s := nonNull(val); s != "" {
					return s
				}
				return "—"
			}
			providerOrder := []string{}
			seenProv := map[string]bool{}
			for _, fk := range factorKeys {
				for p := range asMap(factorObj[fk]) {
					if !seenProv[p] {
						seenProv[p] = true
						providerOrder = append(providerOrder, p)
					}
				}
			}
			for _, p := range providerOrder {
				summary.IP.RiskFactors = append(summary.IP.RiskFactors, NodeQualityRiskFactorRow{
					Provider: p,
					Country:  nonNull(asMap(factorObj["CountryCode"])[p]),
					Proxy:    fmtBool(asMap(factorObj["Proxy"])[p]),
					Tor:      fmtBool(asMap(factorObj["Tor"])[p]),
					VPN:      fmtBool(asMap(factorObj["VPN"])[p]),
					Server:   fmtBool(asMap(factorObj["Server"])[p]),
					Abuser:   fmtBool(asMap(factorObj["Abuser"])[p]),
					Robot:    fmtBool(asMap(factorObj["Robot"])[p]),
				})
			}
		}

		// Media & AI Unlocks
		displayNames := map[string]string{
			"TikTok": "TikTok", "DisneyPlus": "Disney+", "Netflix": "Netflix",
			"Youtube": "YouTube", "AmazonPrimeVideo": "Amazon PV", "Reddit": "Reddit", "ChatGPT": "ChatGPT",
		}
		mediaOrder := []string{"TikTok", "DisneyPlus", "Netflix", "Youtube", "AmazonPrimeVideo", "Reddit", "ChatGPT"}
		mediaObj := asMap(ipj["Media"])
		visitedMedia := map[string]bool{}
		addMedia := func(k string, v map[string]any) {
			if v == nil {
				return
			}
			st, reg, ut := nonNull(v["Status"]), nonNull(v["Region"]), nonNull(v["Type"])
			if st == "" && reg == "" {
				return
			}
			name := displayNames[k]
			if name == "" {
				name = k
			}
			parts := []string{}
			if st != "" {
				parts = append(parts, st)
			}
			if reg != "" {
				parts = append(parts, "["+reg+"]")
			}
			if ut != "" {
				parts = append(parts, ut)
			}
			summary.Unlocks = append(summary.Unlocks, NodeQualityUnlock{
				Service:    name,
				Status:     classifyUnlockStatus(st, ut),
				StatusText: st,
				Region:     reg,
				UnlockType: ut,
				Detail:     strings.Join(parts, " · "),
			})
		}
		for _, k := range mediaOrder {
			if v := asMap(mediaObj[k]); v != nil {
				visitedMedia[k] = true
				addMedia(k, v)
			}
		}
		for k, val := range mediaObj {
			if !visitedMedia[k] {
				addMedia(k, asMap(val))
			}
		}

		// Mail & DNSBlacklist
		if mail := asMap(ipj["Mail"]); mail != nil {
			if p25, ok := mail["Port25"].(bool); ok {
				if p25 {
					summary.IP.MailPort25 = "开放"
				} else {
					summary.IP.MailPort25 = "阻断"
				}
			}
			reachable := []string{}
			for mk, mv := range mail {
				if mk == "Port25" || mk == "DNSBlacklist" {
					continue
				}
				if b, ok := mv.(bool); ok && b {
					reachable = append(reachable, mk)
				}
			}
			summary.IP.MailReachable = reachable
			if bl := asMap(mail["DNSBlacklist"]); bl != nil {
				summary.IP.BlacklistTotal = posIntPtr(bl["Total"])
				summary.IP.BlacklistClean = posIntPtr(bl["Clean"])
				summary.IP.BlacklistMarked = posIntPtr(bl["Marked"])
				summary.IP.BlacklistHit = posIntPtr(bl["Blacklisted"])
			}
		}
	}

	// IP text fallback
	if ipBlock != "" {
		if summary.IP.IPv4 == "" {
			summary.IP.IPv4 = srv.PublicIP
		}
		if svg := reIPSvg.FindString(ipBlock); svg != "" {
			summary.IP.ReportSvgURL = svg
		}
		if summary.IP.ASN == "" {
			summary.IP.ASN = matchOne(ipBlock, `自治系统号[：:]\s*(AS\d+)`)
		}
		if summary.IP.Org == "" {
			summary.IP.Org = matchOne(ipBlock, `组织[：:]\s*([^\n]+)`)
		}
		if summary.IP.Country == "" {
			summary.IP.Country = matchOne(ipBlock, `使用地[：:]\s*([^\n]+)`)
		}
		if summary.IP.RegisteredCountry == "" {
			summary.IP.RegisteredCountry = matchOne(ipBlock, `注册地[：:]\s*([^\n]+)`)
		}
		if summary.IP.Timezone == "" {
			summary.IP.Timezone = matchOne(ipBlock, `时区[：:]\s*([^\n]+)`)
		}
		if summary.IP.IPType == "" {
			if t := matchOne(ipBlock, `IP类型[：:]\s*([^\n]+)`); t != "" {
				summary.IP.IPType = t
				if strings.Contains(t, "原生") {
					summary.IP.IsNative = boolPtr(true)
				} else if strings.Contains(t, "广播") {
					summary.IP.IsNative = boolPtr(false)
				}
			}
		}
		if len(summary.IP.TypeMatrix) == 0 {
			sec2 := extractBetween(ipBlock, "二、IP类型属性", "三、")
			dbs := strings.Fields(matchOne(sec2, `数据库[：:]\s*([^\n]+)`))
			uses := strings.Fields(matchOne(sec2, `使用类型[：:]\s*([^\n]+)`))
			coms := strings.Fields(matchOne(sec2, `公司类型[：:]\s*([^\n]+)`))
			for i, p := range dbs {
				u, c := "", ""
				if i < len(uses) {
					u = uses[i]
				}
				if i < len(coms) {
					c = coms[i]
				}
				summary.IP.TypeMatrix = append(summary.IP.TypeMatrix, NodeQualityTypeMatrixRow{Provider: p, Usage: u, Company: c})
			}
			if summary.IP.UsageType == "" && len(uses) > 0 {
				summary.IP.UsageType = uses[0]
			}
		}
		if len(summary.IP.RiskSources) == 0 {
			sec3 := extractBetween(ipBlock, "三、风险评分", "四、")
			nums := []float64{}
			for _, line := range strings.Split(sec3, "\n") {
				m := reScoreLine.FindStringSubmatch(line)
				if m == nil || m[1] == "风险等级" {
					continue
				}
				score := strings.TrimSpace(m[2])
				lvl := classifyRiskFromText(score)
				if nm := reNumFloatHead.FindStringSubmatch(score); nm != nil && !strings.Contains(score, "%") {
					if n, err := strconv.ParseFloat(nm[1], 64); err == nil && n <= 100 {
						nums = append(nums, n)
					}
				}
				summary.IP.RiskSources = append(summary.IP.RiskSources, NodeQualityRiskSource{Name: m[1], Score: score, Level: lvl})
			}
			if len(nums) > 0 {
				sum := 0.0
				for _, n := range nums {
					sum += n
				}
				avg := int(math.Round(sum / float64(len(nums))))
				summary.IP.RiskScore = &avg
			}
			if len(summary.IP.RiskSources) > 0 {
				highs, meds := 0, 0
				for _, r := range summary.IP.RiskSources {
					if r.Level == "high" {
						highs++
					} else if r.Level == "medium" {
						meds++
					}
				}
				if highs >= 1 {
					summary.IP.RiskLevel = "high"
				} else if meds >= 2 {
					summary.IP.RiskLevel = "medium"
				} else {
					summary.IP.RiskLevel = "low"
				}
			}
		}
		if len(summary.IP.RiskFactors) == 0 {
			sec4 := extractBetween(ipBlock, "四、风险因子", "五、")
			libs := strings.Fields(matchOne(sec4, `库[：:]\s*([^\n]+)`))
			if len(libs) > 0 {
				at := func(sl []string, i int) string {
					if i < len(sl) {
						return sl[i]
					}
					return ""
				}
				country := strings.Fields(matchOne(sec4, `地区[：:]\s*([^\n]+)`))
				proxy := strings.Fields(matchOne(sec4, `代理[：:]\s*([^\n]+)`))
				tor := strings.Fields(matchOne(sec4, `Tor[：:]\s*([^\n]+)`))
				vpn := strings.Fields(matchOne(sec4, `VPN[：:]\s*([^\n]+)`))
				srvF := strings.Fields(matchOne(sec4, `服务器[：:]\s*([^\n]+)`))
				abuser := strings.Fields(matchOne(sec4, `滥用[：:]\s*([^\n]+)`))
				robot := strings.Fields(matchOne(sec4, `机器人[：:]\s*([^\n]+)`))
				for i, p := range libs {
					summary.IP.RiskFactors = append(summary.IP.RiskFactors, NodeQualityRiskFactorRow{
						Provider: p,
						Country:  strings.Trim(at(country, i), "[]"),
						Proxy:    at(proxy, i),
						Tor:      at(tor, i),
						VPN:      at(vpn, i),
						Server:   at(srvF, i),
						Abuser:   at(abuser, i),
						Robot:    at(robot, i),
					})
				}
			}
		}
		if len(summary.Unlocks) == 0 {
			sec5 := extractBetween(ipBlock, "五、流媒体及AI服务解锁检测", "六、")
			svcs := strings.Fields(matchOne(sec5, `服务商[：:]\s*([^\n]+)`))
			sts := strings.Fields(matchOne(sec5, `状态[：:]\s*([^\n]+)`))
			regs := strings.Fields(matchOne(sec5, `地区[：:]\s*([^\n]+)`))
			types := strings.Fields(matchOne(sec5, `方式[：:]\s*([^\n]+)`))
			rIdx, tIdx := 0, 0
			for i, svc := range svcs {
				st := "未知"
				if i < len(sts) {
					st = sts[i]
				}
				noReg := strings.Contains(st, "屏蔽") || strings.Contains(st, "阻断") || strings.Contains(st, "失败") || strings.Contains(st, "不支持") || strings.EqualFold(st, "no")
				reg, ut := "", ""
				if !noReg && rIdx < len(regs) {
					reg = strings.Trim(regs[rIdx], "[]")
					rIdx++
				}
				if !noReg && tIdx < len(types) {
					ut = types[tIdx]
					tIdx++
				}
				parts := []string{st}
				if reg != "" {
					parts = append(parts, "["+reg+"]")
				}
				if ut != "" {
					parts = append(parts, ut)
				}
				summary.Unlocks = append(summary.Unlocks, NodeQualityUnlock{
					Service:    svc,
					Status:     classifyUnlockStatus(st, ut),
					StatusText: st,
					Region:     reg,
					UnlockType: ut,
					Detail:     strings.Join(parts, " · "),
				})
			}
		}
		if summary.IP.MailPort25 == "" {
			summary.IP.MailPort25 = matchOne(ipBlock, `本地25端口出站[：:]\s*([^\n]+)`)
		}
		if summary.IP.BlacklistTotal == nil {
			if m := reBLSummary.FindStringSubmatch(ipBlock); m != nil {
				t, _ := strconv.Atoi(m[1])
				c, _ := strconv.Atoi(m[2])
				mk, _ := strconv.Atoi(m[3])
				h, _ := strconv.Atoi(m[4])
				summary.IP.BlacklistTotal = &t
				summary.IP.BlacklistClean = &c
				summary.IP.BlacklistMarked = &mk
				summary.IP.BlacklistHit = &h
			}
		}
	}

	// 2) HARDWARE QUALITY
	if hwj := asMap(rawJson.Hardware); hwj != nil {
		osMap := asMap(hwj["OS"])
		cpuMap := asMap(hwj["CPU"])
		if osName := nonNull(osMap["name"]); osName != "" {
			if k := nonNull(osMap["kernel"]); k != "" {
				summary.Hardware.OS = osName + " (" + k + ")"
			} else {
				summary.Hardware.OS = osName
			}
		}
		summary.Hardware.Arch = firstNonEmpty(nonNull(osMap["architecture"]), nonNull(cpuMap["architecture"]))
		if virt := asMap(osMap["virtualization"]); virt != nil {
			if vt := nonNull(virt["type"]); vt != "" {
				vk := nonNull(virt["kind"])
				if vk == "virtual-machine" {
					summary.Hardware.Virtualization = strings.ToUpper(vt) + " 虚拟机"
				} else if vk != "" {
					summary.Hardware.Virtualization = strings.ToUpper(vt) + " (" + vk + ")"
				} else {
					summary.Hardware.Virtualization = strings.ToUpper(vt)
				}
			}
		}
		summary.Hardware.CPUModel = nonNull(cpuMap["model"])
		if topo := asMap(cpuMap["topology"]); topo != nil && nonNull(topo["cores"]) != "" {
			th := firstNonEmpty(nonNull(topo["threads"]), nonNull(topo["cores"]))
			summary.Hardware.Cores = fmt.Sprintf("%s 核心 / %s 线程", nonNull(topo["cores"]), th)
		}
		if freq := asMap(cpuMap["frequency_mhz"]); freq != nil && nonNull(freq["current"]) != "" {
			summary.Hardware.FreqMhz = nonNull(freq["current"]) + " MHz"
		}
		if c := asMap(cpuMap["cache"]); c != nil {
			parts := []string{}
			for _, kv := range [][2]string{{"l1d", "L1d"}, {"l1i", "L1i"}, {"l2", "L2"}, {"l3", "L3"}} {
				if v := nonNull(c[kv[0]]); v != "" {
					parts = append(parts, kv[1]+" "+v)
				}
			}
			summary.Hardware.Cache = strings.Join(parts, ", ")
		}
		if f := asMap(cpuMap["features"]); f != nil {
			asBool := func(v any) bool { b, _ := v.(bool); return b }
			isArm := strings.Contains(strings.ToLower(summary.Hardware.Arch), "arm") || strings.Contains(strings.ToLower(summary.Hardware.Arch), "aarch64")
			hasAvx512 := false
			for _, fl := range asSlice(cpuMap["flags"]) {
				if nonNull(fl) == "avx512f" {
					hasAvx512 = true
					break
				}
			}
			var checks []NodeQualityFeatureCheck
			if isArm {
				checks = []NodeQualityFeatureCheck{
					{Name: "Virtualization", Supported: asBool(f["virtualization"])},
					{Name: "AES", Supported: asBool(f["aes"])},
					{Name: "NEON", Supported: asBool(f["neon"])},
					{Name: "SVE", Supported: asBool(f["sve"])},
					{Name: "Atomics", Supported: asBool(f["atomics"])},
				}
			} else {
				checks = []NodeQualityFeatureCheck{
					{Name: "VT-x/AMD-V", Supported: asBool(f["virtualization"])},
					{Name: "AES-NI", Supported: asBool(f["aes"])},
					{Name: "AVX2", Supported: asBool(f["avx2"])},
					{Name: "AVX-512", Supported: hasAvx512},
					{Name: "BMI1/2", Supported: asBool(f["bmi"])},
					{Name: "EPT/NPT", Supported: asBool(f["ept"])},
				}
			}
			summary.Hardware.FeatureChecks = checks
			for _, ch := range checks {
				if ch.Supported {
					summary.Hardware.Flags = append(summary.Hardware.Flags, ch.Name)
				}
			}
		}
		if bench := asMap(cpuMap["benchmarks"]); bench != nil {
			gb := asMap(bench["geekbench5"])
			sb := asMap(bench["sysbench"])
			if nonNull(gb["single"]) != "" || nonNull(gb["multi"]) != "" {
				if s := nonNull(gb["single"]); s != "" {
					summary.Hardware.CPUSingle = "GB5 " + s
				}
				if m := nonNull(gb["multi"]); m != "" {
					summary.Hardware.CPUMulti = "GB5 " + m
				}
			} else if nonNull(sb["single"]) != "" || nonNull(sb["multi"]) != "" {
				if s := nonNull(sb["single"]); s != "" {
					summary.Hardware.CPUSingle = "Sysbench " + s
				}
				if m := nonNull(sb["multi"]); m != "" {
					summary.Hardware.CPUMulti = "Sysbench " + m
				}
			}
		}
		if gpuDevs := asSlice(asMap(hwj["GPU"])["devices"]); len(gpuDevs) > 0 {
			names := []string{}
			for _, g := range gpuDevs {
				if n := nonNull(asMap(g)["name"]); n != "" {
					names = append(names, n)
				}
			}
			summary.Hardware.GPU = strings.Join(names, ", ")
		}
		memMap := asMap(hwj["Memory"])
		if ms := asMap(memMap["summary"]); ms != nil && nonNull(ms["total"]) != "" {
			summary.Hardware.Memory = fmt.Sprintf("总计 %s（已用 %s / %s%%）", nonNull(ms["total"]), firstNonEmpty(nonNull(ms["used"]), "—"), firstNonEmpty(nonNull(ms["used_percent"]), "—"))
		}
		if sw := asMap(memMap["swap"]); sw != nil && nonNull(sw["total"]) != "" {
			summary.Hardware.Swap = fmt.Sprintf("总计 %s（已用 %s / %s%%）", nonNull(sw["total"]), firstNonEmpty(nonNull(sw["used"]), "—"), firstNonEmpty(nonNull(sw["used_percent"]), "—"))
		}
		if mv := asMap(memMap["virtualization"]); mv != nil {
			b1, _ := mv["balloon"].(bool)
			b2, _ := mv["ksm"].(bool)
			summary.Hardware.Oversell = &NodeQualityOversell{Balloon: b1, KSM: b2}
		}
		if mb := asMap(memMap["benchmarks"]); mb != nil {
			if r := nonNull(mb["read_MBps"]); r != "" {
				summary.Hardware.MemReadMBps = r + " MB/s"
			}
			if w := nonNull(mb["write_MBps"]); w != "" {
				summary.Hardware.MemWriteMBps = w + " MB/s"
			}
		}
		if ds := asMap(asMap(hwj["Disk"])["summary"]); ds != nil {
			if tb, ok := ds["total_bytes"].(float64); ok && tb > 0 {
				ub, _ := ds["used_bytes"].(float64)
				summary.Hardware.Disk = fmt.Sprintf("总计 %s（已用 %s · %s%%）", formatBytesSimple(tb), formatBytesSimple(ub), nonNull(ds["used_percent"]))
			}
		}
		if bios := asMap(asMap(hwj["Motherboard"])["bios"]); bios != nil && nonNull(bios["vendor"]) != "" {
			summary.Hardware.Motherboard = strings.TrimSpace(nonNull(bios["vendor"]) + " " + nonNull(bios["version"]))
		}
		if nics := asSlice(asMap(asMap(hwj["Motherboard"])["devices"])["network"]); len(nics) > 0 {
			ns := []string{}
			for _, x := range nics {
				if s := nonNull(x); s != "" {
					ns = append(ns, s)
				}
			}
			summary.Hardware.NIC = strings.Join(ns, ", ")
		}
	}

	if hwBlock != "" {
		if svg := reHWSvg.FindString(hwBlock); svg != "" {
			summary.Hardware.ReportSvgURL = svg
		}
		if summary.Hardware.Virtualization == "" {
			summary.Hardware.Virtualization = matchOne(hwBlock, `容器/虚拟化[：:]\s*([^\n]+)`)
		}
		if summary.Hardware.Arch == "" {
			summary.Hardware.Arch = matchOne(hwBlock, `架构[：:]\s*([^\n]+)`)
		}
		if summary.Hardware.OS == "" {
			summary.Hardware.OS = matchOne(hwBlock, `操作系统/内核[：:]\s*([^\n]+)`)
		}
		if summary.Hardware.CPUModel == "" {
			summary.Hardware.CPUModel = matchOne(hwBlock, `CPU[：:]\s*([^\n]+)`)
		}
		if summary.Hardware.Cores == "" {
			summary.Hardware.Cores = matchOne(hwBlock, `╚═\s*([^,\n]+核心[^,\n]*,\s*[^,\n]+线程)`)
		}
		if summary.Hardware.FreqMhz == "" {
			summary.Hardware.FreqMhz = matchOne(hwBlock, `(?i)(\d+(?:\.\d+)?\s*MHz)`)
		}
		if summary.Hardware.Cache == "" {
			summary.Hardware.Cache = matchOne(hwBlock, `缓存[：:]\s*([^\n]+)`)
		}
		if len(summary.Hardware.FeatureChecks) == 0 {
			if fl := matchOne(hwBlock, `指令集[：:]\s*([^\n]+)`); fl != "" {
				for _, m := range reFlagCheck.FindAllStringSubmatch(fl, -1) {
					sup := m[1] == "✔"
					summary.Hardware.FeatureChecks = append(summary.Hardware.FeatureChecks, NodeQualityFeatureCheck{Name: m[2], Supported: sup})
					if sup {
						summary.Hardware.Flags = append(summary.Hardware.Flags, m[2])
					}
				}
			}
		}
		if summary.Hardware.GPU == "" {
			summary.Hardware.GPU = matchOne(hwBlock, `显卡[：:]\s*([^\n]+)`)
		}
		if summary.Hardware.Memory == "" {
			summary.Hardware.Memory = matchOne(hwBlock, `内存[：:]\s*([^\n]+)`)
		}
		if summary.Hardware.Swap == "" {
			summary.Hardware.Swap = matchOne(hwBlock, `交换[：:]\s*([^\n]+)`)
		}
		if summary.Hardware.Oversell == nil {
			if ol := matchOne(hwBlock, `超开指标[：:]\s*([^\n]+)`); ol != "" {
				summary.Hardware.Oversell = &NodeQualityOversell{
					Balloon: strings.Contains(ol, "✔ 气球回收") || strings.Contains(ol, "✔气球回收"),
					KSM:     strings.Contains(ol, "✔ KSM") || strings.Contains(ol, "✔KSM"),
				}
			}
		}
		if summary.Hardware.Disk == "" {
			summary.Hardware.Disk = matchOne(hwBlock, `硬盘[：:]\s*([^\n]+)`)
		}
		if summary.Hardware.NIC == "" {
			summary.Hardware.NIC = matchOne(hwBlock, `网卡[：:]\s*([^\n]+)`)
		}
		if m := reFio4k.FindStringSubmatch(hwBlock); m != nil {
			summary.Hardware.Fio4kRead = m[1]
			summary.Hardware.Fio4kWrite = m[2]
		}
		if m := reFio1m.FindStringSubmatch(hwBlock); m != nil {
			summary.Hardware.Fio1mRead = m[1]
			summary.Hardware.Fio1mWrite = m[2]
		}
		if m := reDDSpeed.FindStringSubmatch(hwBlock); m != nil {
			summary.Hardware.DdSpeed = m[1]
		}
	}

	// 3) NETWORK QUALITY & BACKROUTE
	if netj := asMap(rawJson.Net); netj != nil {
		if bgp := asMap(netj["BGP"]); bgp != nil {
			asn := nonNull(bgp["ASN"])
			if asn != "" && !strings.HasPrefix(asn, "AS") {
				asn = "AS" + asn
			}
			upstreams := []string{}
			for _, item := range asSlice(netj["Connectivity"]) {
				cm := asMap(item)
				isUp, _ := cm["IsUpstream"].(bool)
				isT1, _ := cm["IsTier1"].(bool)
				if isUp || isT1 {
					org := nonNull(cm["Org"])
					lbl := "AS" + nonNull(cm["ASN"])
					if org != "" {
						lbl += " " + org
					}
					upstreams = append(upstreams, lbl)
					if len(upstreams) >= 10 {
						break
					}
				}
			}
			summary.Network.BGP = &NodeQualityBGP{
				ASN:            asn,
				Org:            nonNull(bgp["Organization"]),
				Prefix:         posIntPtr(bgp["Prefix"]),
				RIR:            nonNull(bgp["RIR"]),
				ModDate:        nonNull(bgp["ModDate"]),
				Country:        nonNull(bgp["Country"]),
				Address:        nonNull(bgp["Address"]),
				IPActive:       posIntPtr(bgp["IPActive"]),
				IPTotal:        posIntPtr(bgp["IPinTotal"]),
				IXCount:        posIntPtr(bgp["IXCount"]),
				UpstreamsCount: posIntPtr(bgp["UpstreamsCount"]),
				PeersCount:     posIntPtr(bgp["PeersCount"]),
				Upstreams:      upstreams,
			}
		}

		if loc := asMap(netj["Local"]); loc != nil {
			summary.Network.Local = &NodeQualityLocalNet{
				NAT:     firstNonEmpty(nonNull(loc["NATDescribe"]), nonNull(loc["NAT"])),
				Mapping: nonNull(loc["Mapping"]),
				Filter:  nonNull(loc["Filter"]),
				TCPCc:   nonNull(loc["TCPCongestionControl"]),
				Qdisc:   nonNull(loc["QueueDiscipline"]),
				Rmem:    nonNull(loc["TCPReceiveBuffer"]),
				Wmem:    nonNull(loc["TCPSendBuffer"]),
			}
		}

		for _, item := range asSlice(netj["Delay"]) {
			dm := asMap(item)
			shortName := nonNull(dm["Name"])
			ct := nonNull(asMap(dm["CT"])["Average"])
			cu := nonNull(asMap(dm["CU"])["Average"])
			cm := nonNull(asMap(dm["CM"])["Average"])
			if shortName != "" && (ct != "" || cu != "" || cm != "") {
				city := provinceNames[shortName]
				if city == "" {
					city = shortName
				}
				summary.Network.Delays = append(summary.Network.Delays, NodeQualityDelayRow{
					Code: nonNull(dm["Code"]), City: city, CT: ct, CU: cu, CM: cm,
				})
			}
		}

		for _, item := range asSlice(netj["Transfer"]) {
			tm := asMap(item)
			city := nonNull(tm["City"])
			if city == "" {
				continue
			}
			delayMs := nonNull(asMap(tm["Delay"])["Average"])
			ss := nonNull(tm["SendSpeed"])
			rs := nonNull(tm["ReceiveSpeed"])
			if delayMs == "" && ss == "" && rs == "" {
				continue
			}
			row := NodeQualityTransferRow{
				City:               city,
				DelayMs:            delayMs,
				SendRetransmits:    nonNull(tm["SendRetransmits"]),
				ReceiveRetransmits: nonNull(tm["ReceiveRetransmits"]),
			}
			if ss != "" {
				row.SendSpeed = ss + " Mbps"
			}
			if rs != "" {
				row.ReceiveSpeed = rs + " Mbps"
			}
			summary.Network.Transfers = append(summary.Network.Transfers, row)
		}

		for _, item := range asSlice(netj["Speedtest"]) {
			sm := asMap(item)
			city := nonNull(sm["City"])
			if city == "" {
				continue
			}
			row := NodeQualitySpeedtestRow{
				Node:     city,
				Provider: nonNull(sm["Provider"]),
			}
			if u := nonNull(sm["SendSpeed"]); u != "" {
				row.Upload = u + " Mbps"
			}
			if d := nonNull(sm["ReceiveSpeed"]); d != "" {
				row.Download = d + " Mbps"
			}
			if l := nonNull(sm["ReceiveDelay"]); l != "" {
				row.Latency = l + " ms"
			}
			summary.Network.Speedtests = append(summary.Network.Speedtests, row)
		}
	}

	if netBlock != "" {
		if svg := reNetSvg.FindString(netBlock); svg != "" {
			summary.Network.ReportSvgURL = svg
		}
		seenR := map[string]bool{}
		for _, line := range strings.Split(netBlock, "\n") {
			cm := reCompactRoute.FindStringSubmatch(line)
			if cm == nil {
				continue
			}
			city, proto := cm[1], cm[2]
			for _, seg := range strings.Split(cm[3], "||") {
				im := reCompactISP.FindStringSubmatch(strings.TrimSpace(seg))
				if im == nil {
					continue
				}
				key := city + "-" + proto + "-" + im[1]
				if seenR[key] {
					continue
				}
				seenR[key] = true
				summary.Network.Routes = append(summary.Network.Routes, NodeQualityRoute{
					City:     city,
					Proto:    proto,
					ISP:      im[1],
					LineType: strings.TrimSpace(im[2]),
				})
			}
		}
	}

	if btBlock != "" {
		summary.Network.BackrouteTraces = parseBackrouteTraces(btBlock)
	}
	return summary
}

type QuickIPProbe struct {
	IP      string `json:"ip,omitempty"`
	ASN     string `json:"asn,omitempty"`
	Org     string `json:"org,omitempty"`
	Country string `json:"country,omitempty"`
	City    string `json:"city,omitempty"`
}

var reASNOrg = regexp.MustCompile(`^(AS\d+)\s*(.*)$`)

func runQuickIPProbe(srv ServerConfig) QuickIPProbe {
	res, err := execScript(srv, `curl -sL4 --max-time 6 https://ipinfo.io/json 2>/dev/null || curl -sL4 --max-time 6 http://ip-api.com/json 2>/dev/null`, ExecOpts{
		Timeout: 9 * time.Second,
	})
	if err != nil {
		return QuickIPProbe{}
	}
	var data map[string]any
	if json.Unmarshal([]byte(strings.TrimSpace(res.Stdout)), &data) != nil {
		return QuickIPProbe{}
	}
	orgRaw := firstNonEmpty(nonNull(data["org"]), nonNull(data["as"]))
	asn, org := "", orgRaw
	if m := reASNOrg.FindStringSubmatch(orgRaw); m != nil {
		asn = m[1]
		org = m[2]
	}
	if org == "" {
		org = nonNull(data["isp"])
	}
	return QuickIPProbe{
		IP:      firstNonEmpty(nonNull(data["ip"]), nonNull(data["query"])),
		ASN:     asn,
		Org:     org,
		Country: firstNonEmpty(nonNull(data["country"]), nonNull(data["countryCode"])),
		City:    nonNull(data["city"]),
	}
}
