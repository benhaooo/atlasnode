package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var (
	alertMu      sync.Mutex
	lastFiredMap = map[string]int64{}
)

func defaultAlertConfig() AlertConfig {
	return AlertConfig{
		Enabled:         false,
		CooldownMinutes: 60,
		Thresholds: AlertThresholds{
			DiskPercent:  88,
			CPUPercent:   92,
			MemPercent:   92,
			OfflineAlert: true,
		},
	}
}

func loadAlertConfig() AlertConfig {
	cfg := defaultAlertConfig()
	readJSON(filepath.Join(getDataDir(), "alerts.json"), &cfg)
	return cfg
}

func saveAlertConfig(cfg AlertConfig) error {
	return writeJSONAtomic(filepath.Join(getDataDir(), "alerts.json"), cfg)
}

func loadAlertHistory() []AlertEvent {
	var list []AlertEvent
	if !readJSON(filepath.Join(getDataDir(), "alert-history.json"), &list) || list == nil {
		return []AlertEvent{}
	}
	return list
}

func appendAlertHistory(ev AlertEvent) {
	alertMu.Lock()
	defer alertMu.Unlock()
	list := loadAlertHistory()
	list = append([]AlertEvent{ev}, list...)
	if len(list) > 80 {
		list = list[:80]
	}
	_ = writeJSONAtomic(filepath.Join(getDataDir(), "alert-history.json"), list)
}

func deliverAlert(cfg AlertConfig, title, body string) (bool, []string) {
	client := &http.Client{Timeout: 8 * time.Second}
	details := []string{}
	anyDelivered := false

	if cfg.Telegram.Enabled && cfg.Telegram.BotToken != "" && cfg.Telegram.ChatID != "" {
		payload, _ := json.Marshal(map[string]string{
			"chat_id": cfg.Telegram.ChatID,
			"text":    title + "\n" + body,
		})
		resp, err := client.Post(
			fmt.Sprintf("https://api.telegram.org/bot%s/sendMessage", cfg.Telegram.BotToken),
			"application/json",
			bytes.NewReader(payload),
		)
		if err != nil {
			details = append(details, "Telegram: "+err.Error())
		} else {
			_ = resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				anyDelivered = true
				details = append(details, "Telegram: 发送成功")
			} else {
				details = append(details, fmt.Sprintf("Telegram: HTTP %d", resp.StatusCode))
			}
		}
	}

	if cfg.Webhook.Enabled && cfg.Webhook.URL != "" {
		payload, _ := json.Marshal(map[string]any{
			"msg_type": "text",
			"content":  map[string]string{"text": title + "\n" + body},
			"title":    title,
			"text":     title + "\n" + body,
		})
		resp, err := client.Post(cfg.Webhook.URL, "application/json", bytes.NewReader(payload))
		if err != nil {
			details = append(details, "Webhook: "+err.Error())
		} else {
			_ = resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				anyDelivered = true
				details = append(details, "Webhook: 发送成功")
			} else {
				details = append(details, fmt.Sprintf("Webhook: HTTP %d", resp.StatusCode))
			}
		}
	}

	if cfg.Bark.Enabled && cfg.Bark.URL != "" {
		base := strings.TrimRight(cfg.Bark.URL, "/")
		endpoint := fmt.Sprintf("%s/%s/%s", base, url.PathEscape(title), url.PathEscape(body))
		resp, err := client.Get(endpoint)
		if err != nil {
			details = append(details, "Bark: "+err.Error())
		} else {
			_ = resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				anyDelivered = true
				details = append(details, "Bark: 发送成功")
			} else {
				details = append(details, fmt.Sprintf("Bark: HTTP %d", resp.StatusCode))
			}
		}
	}

	return anyDelivered, details
}

func sendTestAlert(cfg AlertConfig) (bool, []string) {
	ok, details := deliverAlert(
		cfg,
		"AtlasNode 测试通知",
		fmt.Sprintf("服务器中枢告警通道连通测试成功 (%s)", time.Now().Format("2006-01-02 15:04:05")),
	)
	if len(details) == 0 {
		details = []string{"请先启用至少一个通知渠道"}
	}
	return ok, details
}

func evaluateServerAlerts(srv ServerConfig, metrics *LiveMetrics, offlineErr string) {
	cfg := loadAlertConfig()
	if !cfg.Enabled {
		return
	}

	cooldownMin := cfg.CooldownMinutes
	if cooldownMin < 5 {
		cooldownMin = 5
	}
	cooldownMs := int64(cooldownMin) * 60 * 1000
	now := time.Now().UnixMilli()

	type cand struct {
		kind string
		msg  string
	}
	var candidates []cand

	if metrics == nil {
		if cfg.Thresholds.OfflineAlert {
			if offlineErr == "" {
				offlineErr = "SSH 超时"
			}
			candidates = append(candidates, cand{
				kind: "offline",
				msg:  fmt.Sprintf("节点 [%s] 无法连接：%s", srv.Name, offlineErr),
			})
		}
	} else {
		if cfg.Thresholds.DiskPercent > 0 && metrics.DiskRootPercent >= cfg.Thresholds.DiskPercent {
			candidates = append(candidates, cand{
				kind: "disk",
				msg:  fmt.Sprintf("节点 [%s] 根分区使用率已达 %.1f%%（阈值 %.0f%%）", srv.Name, metrics.DiskRootPercent, cfg.Thresholds.DiskPercent),
			})
		}
		if cfg.Thresholds.CPUPercent > 0 && metrics.CPUPercent >= cfg.Thresholds.CPUPercent {
			candidates = append(candidates, cand{
				kind: "cpu",
				msg:  fmt.Sprintf("节点 [%s] CPU 持续高负载 %.1f%%（Load %.2f）", srv.Name, metrics.CPUPercent, metrics.LoadAvg[0]),
			})
		}
		if cfg.Thresholds.MemPercent > 0 && metrics.MemPercent >= cfg.Thresholds.MemPercent {
			candidates = append(candidates, cand{
				kind: "mem",
				msg:  fmt.Sprintf("节点 [%s] 内存占用已达 %.1f%%", srv.Name, metrics.MemPercent),
			})
		}
	}

	for _, item := range candidates {
		key := srv.ID + ":" + item.kind
		alertMu.Lock()
		last := lastFiredMap[key]
		if now-last < cooldownMs {
			alertMu.Unlock()
			continue
		}
		lastFiredMap[key] = now
		alertMu.Unlock()

		delivered, _ := deliverAlert(cfg, "⚠️ AtlasNode 告警 · "+srv.Name, item.msg)
		appendAlertHistory(AlertEvent{
			ID:         fmt.Sprintf("al_%d_%s", now, randomHex(2)),
			TS:         time.Now().UTC().Format(time.RFC3339),
			ServerID:   srv.ID,
			ServerName: srv.Name,
			Kind:       item.kind,
			Message:    item.msg,
			Delivered:  delivered,
		})
	}
}
