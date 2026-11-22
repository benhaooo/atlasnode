package main

import (
	"testing"
	"time"
)

func TestComputeBillingCycle(t *testing.T) {
	loc := time.Local
	// Reset day 15, current date Nov 22 -> cycle Nov 15 to Dec 15 (30 days)
	now := time.Date(2026, 11, 22, 14, 0, 0, 0, loc)
	start, end, elapsed, total, rem := computeBillingCycle(now, 15)
	if start.Format("2006-01-02") != "2026-11-15" {
		t.Fatalf("expected start 2026-11-15, got %s", start.Format("2006-01-02"))
	}
	if end.Format("2006-01-02") != "2026-12-15" {
		t.Fatalf("expected end 2026-12-15, got %s", end.Format("2006-01-02"))
	}
	if total != 30 || elapsed != 8 || rem != 22 {
		t.Fatalf("expected total=30 elapsed=8 rem=22, got total=%d elapsed=%d rem=%d", total, elapsed, rem)
	}

	// Reset day 25, current date Nov 22 -> cycle Oct 25 to Nov 25 (31 days)
	start2, end2, elapsed2, total2, rem2 := computeBillingCycle(now, 25)
	if start2.Format("2006-01-02") != "2026-10-25" || end2.Format("2006-01-02") != "2026-11-25" {
		t.Fatalf("unexpected cycle: %s -> %s", start2.Format("2006-01-02"), end2.Format("2006-01-02"))
	}
	if total2 != 31 || elapsed2 != 29 || rem2 != 2 {
		t.Fatalf("expected total=31 elapsed=29 rem=2, got total=%d elapsed=%d rem=%d", total2, elapsed2, rem2)
	}
}

func TestComputeBilledBytes(t *testing.T) {
	if got := computeBilledBytes(100, 300, 50, "both"); got != 450 {
		t.Fatalf("both: got %d, want 450", got)
	}
	if got := computeBilledBytes(100, 300, 50, "tx"); got != 350 {
		t.Fatalf("tx: got %d, want 350", got)
	}
	if got := computeBilledBytes(100, 300, 50, "rx"); got != 150 {
		t.Fatalf("rx: got %d, want 150", got)
	}
	if got := computeBilledBytes(100, 300, 50, "max"); got != 350 {
		t.Fatalf("max: got %d, want 350", got)
	}
}

func TestTrafficDailyDeltaAndReboot(t *testing.T) {
	origDataDir := dataDir
	origDB := metricsDB
	defer func() {
		if metricsDB != nil {
			_ = metricsDB.Close()
		}
		metricsDB = origDB
		dataDir = origDataDir
	}()

	tmpDir := t.TempDir()
	dataDir = tmpDir
	metricsDB = nil
	if err := initMetricsDB(); err != nil {
		t.Fatalf("initMetricsDB: %v", err)
	}

	now := time.Now().In(time.Local)
	t1 := now.Add(-3 * time.Minute).UnixMilli()
	t2 := now.Add(-2 * time.Minute).UnixMilli()
	t3 := now.Add(-1 * time.Minute).UnixMilli()

	// Sample 1: seed cursor
	recordTrafficDelta("srv1", LiveMetrics{
		Timestamp:       t1,
		NetRxBps:        1000,
		NetTxBps:        2000,
		NetTotalRxBytes: 10000,
		NetTotalTxBytes: 20000,
	})
	// Sample 2: normal increment (+5000 rx, +8000 tx)
	recordTrafficDelta("srv1", LiveMetrics{
		Timestamp:       t2,
		NetRxBps:        5000,
		NetTxBps:        8000,
		NetTotalRxBytes: 15000,
		NetTotalTxBytes: 28000,
	})
	// Sample 3: simulated reboot counter reset (rx=1000 < 15000, tx=2000 < 28000)
	recordTrafficDelta("srv1", LiveMetrics{
		Timestamp:       t3,
		NetRxBps:        3000,
		NetTxBps:        9500,
		NetTotalRxBytes: 1000,
		NetTotalTxBytes: 2000,
	})

	srv := ServerConfig{
		ID: "srv1",
		TrafficPlan: &TrafficPlan{
			BandwidthMbps:  100,
			MonthlyQuotaGB: 1000,
			BillingMode:    "both",
			ResetDay:       1,
		},
	}
	sum := getServerTrafficSummary(srv)
	if sum.CycleRxBytes != 6000 || sum.CycleTxBytes != 10000 {
		t.Fatalf("expected rx=6000 tx=10000, got rx=%d tx=%d", sum.CycleRxBytes, sum.CycleTxBytes)
	}
	if sum.PeakRxBps != 5000 || sum.PeakTxBps != 9500 {
		t.Fatalf("expected peaks 5000/9500, got %.1f/%.1f", sum.PeakRxBps, sum.PeakTxBps)
	}

	// Expired baseline cycle key should NOT be applied
	srv.TrafficPlan.BaselineGB = 200
	srv.TrafficPlan.BaselineCycleKey = "2020-01-01"
	sumExpired := getServerTrafficSummary(srv)
	if sumExpired.BaselineBytes != 0 {
		t.Fatalf("expected expired baseline to be ignored, got %d", sumExpired.BaselineBytes)
	}

	// Current cycle baseline SHOULD be applied
	srv.TrafficPlan.BaselineCycleKey = sum.CycleStart
	sumActive := getServerTrafficSummary(srv)
	if sumActive.BaselineBytes <= 0 || sumActive.UsedPercent < 19.9 || sumActive.UsedPercent > 20.1 {
		t.Fatalf("expected ~20%% with 200GB/1000GB baseline, got baseline=%d pct=%.1f", sumActive.BaselineBytes, sumActive.UsedPercent)
	}
}
