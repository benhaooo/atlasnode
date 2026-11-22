package main

import (
	"database/sql"
	"math"
	"path/filepath"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

var (
	metricsDB     *sql.DB
	metricsDBPath string
	metricsDBMu   sync.Mutex
	samplerOnce   sync.Once
)

func initMetricsDB() error {
	metricsDBMu.Lock()
	defer metricsDBMu.Unlock()
	if metricsDB != nil {
		return nil
	}
	metricsDBPath = filepath.Join(getDataDir(), "metrics.sqlite")
	db, err := sql.Open("sqlite", metricsDBPath)
	if err != nil {
		return err
	}
	db.SetMaxOpenConns(1) // SQLite single-writer safety
	_, err = db.Exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA synchronous = NORMAL;
		CREATE TABLE IF NOT EXISTS metric_samples (
			server_id TEXT NOT NULL,
			ts INTEGER NOT NULL,
			cpu_pct REAL NOT NULL,
			mem_pct REAL NOT NULL,
			disk_pct REAL NOT NULL,
			load1 REAL NOT NULL,
			rx_bps REAL NOT NULL,
			tx_bps REAL NOT NULL,
			rx_total INTEGER NOT NULL,
			tx_total INTEGER NOT NULL,
			PRIMARY KEY (server_id, ts)
		);
		CREATE INDEX IF NOT EXISTS idx_metric_samples_ts ON metric_samples (ts);
		CREATE TABLE IF NOT EXISTS traffic_daily (
			server_id TEXT NOT NULL,
			day TEXT NOT NULL,
			rx_bytes INTEGER NOT NULL DEFAULT 0,
			tx_bytes INTEGER NOT NULL DEFAULT 0,
			peak_rx_bps REAL NOT NULL DEFAULT 0,
			peak_tx_bps REAL NOT NULL DEFAULT 0,
			PRIMARY KEY (server_id, day)
		);
		CREATE TABLE IF NOT EXISTS traffic_cursor (
			server_id TEXT PRIMARY KEY,
			last_ts INTEGER NOT NULL,
			last_rx INTEGER NOT NULL,
			last_tx INTEGER NOT NULL
		);
	`)
	if err != nil {
		_ = db.Close()
		return err
	}
	backfillTrafficDailyLocked(db)
	metricsDB = db
	return nil
}

func backfillTrafficDailyLocked(db *sql.DB) {
	idRows, err := db.Query(`
		SELECT DISTINCT server_id FROM metric_samples
		WHERE server_id NOT IN (SELECT server_id FROM traffic_cursor)
	`)
	if err != nil {
		return
	}
	var serverIDs []string
	for idRows.Next() {
		var sid string
		if idRows.Scan(&sid) == nil && sid != "" {
			serverIDs = append(serverIDs, sid)
		}
	}
	_ = idRows.Close()

	type dayAgg struct {
		rx, tx         int64
		peakRx, peakTx float64
	}
	for _, sid := range serverIDs {
		rows, err := db.Query(`
			SELECT ts, rx_bps, tx_bps, rx_total, tx_total
			FROM metric_samples
			WHERE server_id = ?
			ORDER BY ts ASC
		`, sid)
		if err != nil {
			continue
		}
		daily := map[string]*dayAgg{}
		var havePrev bool
		var lastTs, lastRx, lastTx int64
		for rows.Next() {
			var ts, rxTotal, txTotal int64
			var rxBps, txBps float64
			if rows.Scan(&ts, &rxBps, &txBps, &rxTotal, &txTotal) != nil {
				continue
			}
			day := time.UnixMilli(ts).In(time.Local).Format("2006-01-02")
			agg := daily[day]
			if agg == nil {
				agg = &dayAgg{}
				daily[day] = agg
			}
			if rxBps > agg.peakRx {
				agg.peakRx = rxBps
			}
			if txBps > agg.peakTx {
				agg.peakTx = txBps
			}
			if havePrev {
				drx := rxTotal - lastRx
				if drx < 0 {
					drx = rxTotal
				}
				dtx := txTotal - lastTx
				if dtx < 0 {
					dtx = txTotal
				}
				agg.rx += drx
				agg.tx += dtx
			}
			havePrev = true
			lastTs, lastRx, lastTx = ts, rxTotal, txTotal
		}
		_ = rows.Close()
		if !havePrev {
			continue
		}
		for day, agg := range daily {
			_, _ = db.Exec(`
				INSERT INTO traffic_daily (server_id, day, rx_bytes, tx_bytes, peak_rx_bps, peak_tx_bps)
				VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT(server_id, day) DO UPDATE SET
					rx_bytes = rx_bytes + excluded.rx_bytes,
					tx_bytes = tx_bytes + excluded.tx_bytes,
					peak_rx_bps = MAX(peak_rx_bps, excluded.peak_rx_bps),
					peak_tx_bps = MAX(peak_tx_bps, excluded.peak_tx_bps)
			`, sid, day, agg.rx, agg.tx, agg.peakRx, agg.peakTx)
		}
		_, _ = db.Exec(`
			INSERT OR REPLACE INTO traffic_cursor (server_id, last_ts, last_rx, last_tx)
			VALUES (?, ?, ?, ?)
		`, sid, lastTs, lastRx, lastTx)
	}
}

func recordTrafficDelta(serverID string, m LiveMetrics) {
	if metricsDB == nil {
		if err := initMetricsDB(); err != nil {
			return
		}
	}
	metricsDBMu.Lock()
	defer metricsDBMu.Unlock()
	if metricsDB == nil || m.Timestamp <= 0 {
		return
	}
	day := time.UnixMilli(m.Timestamp).In(time.Local).Format("2006-01-02")
	var lastTs, lastRx, lastTx int64
	err := metricsDB.QueryRow(`SELECT last_ts, last_rx, last_tx FROM traffic_cursor WHERE server_id = ?`, serverID).
		Scan(&lastTs, &lastRx, &lastTx)
	if err == sql.ErrNoRows {
		_, _ = metricsDB.Exec(`
			INSERT INTO traffic_daily (server_id, day, rx_bytes, tx_bytes, peak_rx_bps, peak_tx_bps)
			VALUES (?, ?, 0, 0, ?, ?)
			ON CONFLICT(server_id, day) DO UPDATE SET
				peak_rx_bps = MAX(peak_rx_bps, excluded.peak_rx_bps),
				peak_tx_bps = MAX(peak_tx_bps, excluded.peak_tx_bps)
		`, serverID, day, m.NetRxBps, m.NetTxBps)
		_, _ = metricsDB.Exec(`
			INSERT OR REPLACE INTO traffic_cursor (server_id, last_ts, last_rx, last_tx)
			VALUES (?, ?, ?, ?)
		`, serverID, m.Timestamp, m.NetTotalRxBytes, m.NetTotalTxBytes)
		return
	}
	if err != nil || m.Timestamp <= lastTs {
		return
	}
	drx := m.NetTotalRxBytes - lastRx
	if drx < 0 {
		drx = m.NetTotalRxBytes
	}
	dtx := m.NetTotalTxBytes - lastTx
	if dtx < 0 {
		dtx = m.NetTotalTxBytes
	}
	_, _ = metricsDB.Exec(`
		INSERT INTO traffic_daily (server_id, day, rx_bytes, tx_bytes, peak_rx_bps, peak_tx_bps)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(server_id, day) DO UPDATE SET
			rx_bytes = rx_bytes + excluded.rx_bytes,
			tx_bytes = tx_bytes + excluded.tx_bytes,
			peak_rx_bps = MAX(peak_rx_bps, excluded.peak_rx_bps),
			peak_tx_bps = MAX(peak_tx_bps, excluded.peak_tx_bps)
	`, serverID, day, drx, dtx, m.NetRxBps, m.NetTxBps)
	_, _ = metricsDB.Exec(`
		UPDATE traffic_cursor SET last_ts = ?, last_rx = ?, last_tx = ? WHERE server_id = ?
	`, m.Timestamp, m.NetTotalRxBytes, m.NetTotalTxBytes, serverID)
}

func insertMetricSample(serverID string, m LiveMetrics) {
	if metricsDB == nil {
		if err := initMetricsDB(); err != nil {
			return
		}
	}
	_, _ = metricsDB.Exec(`
		INSERT OR REPLACE INTO metric_samples
			(server_id, ts, cpu_pct, mem_pct, disk_pct, load1, rx_bps, tx_bps, rx_total, tx_total)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`,
		serverID,
		m.Timestamp,
		m.CPUPercent,
		m.MemPercent,
		m.DiskRootPercent,
		m.LoadAvg[0],
		m.NetRxBps,
		m.NetTxBps,
		m.NetTotalRxBytes,
		m.NetTotalTxBytes,
	)
	recordTrafficDelta(serverID, m)
}

func pruneOldDailyTraffic(retentionDays int) {
	if metricsDB == nil {
		return
	}
	cutoffDay := time.Now().In(time.Local).AddDate(0, 0, -retentionDays).Format("2006-01-02")
	_, _ = metricsDB.Exec(`DELETE FROM traffic_daily WHERE day < ?`, cutoffDay)
}

func normalizeTrafficPlan(p *TrafficPlan) TrafficPlan {
	out := TrafficPlan{
		BillingMode: "both",
		ResetDay:    1,
	}
	if p == nil {
		return out
	}
	if p.BandwidthMbps > 0 {
		out.BandwidthMbps = p.BandwidthMbps
	}
	if p.MonthlyQuotaGB > 0 {
		out.MonthlyQuotaGB = p.MonthlyQuotaGB
	}
	switch p.BillingMode {
	case "both", "tx", "rx", "max":
		out.BillingMode = p.BillingMode
	}
	if p.ResetDay >= 1 && p.ResetDay <= 28 {
		out.ResetDay = p.ResetDay
	}
	if p.BaselineGB > 0 {
		out.BaselineGB = p.BaselineGB
	}
	out.BaselineCycleKey = p.BaselineCycleKey
	return out
}

func computeBillingCycle(now time.Time, resetDay int) (start, end time.Time, daysElapsed, daysTotal, daysRemaining int) {
	local := now.In(time.Local)
	if resetDay < 1 || resetDay > 28 {
		resetDay = 1
	}
	y, m, d := local.Date()
	if d >= resetDay {
		start = time.Date(y, m, resetDay, 0, 0, 0, 0, time.Local)
		end = start.AddDate(0, 1, 0)
	} else {
		end = time.Date(y, m, resetDay, 0, 0, 0, 0, time.Local)
		start = end.AddDate(0, -1, 0)
	}
	today := time.Date(y, m, d, 0, 0, 0, 0, time.Local)
	daysTotal = int(math.Round(end.Sub(start).Hours() / 24))
	if daysTotal < 28 {
		daysTotal = 30
	}
	daysElapsed = int(math.Round(today.Sub(start).Hours()/24)) + 1
	if daysElapsed < 1 {
		daysElapsed = 1
	}
	daysRemaining = daysTotal - daysElapsed
	if daysRemaining < 0 {
		daysRemaining = 0
	}
	return
}

func computeBilledBytes(rx, tx, baseline int64, mode string) int64 {
	var tracked int64
	switch mode {
	case "tx":
		tracked = tx
	case "rx":
		tracked = rx
	case "max":
		if rx > tx {
			tracked = rx
		} else {
			tracked = tx
		}
	default:
		tracked = rx + tx
	}
	return tracked + baseline
}

const bytesPerGB = float64(1024 * 1024 * 1024)

func getServerTrafficSummary(srv ServerConfig) *TrafficSummary {
	if metricsDB == nil {
		_ = initMetricsDB()
	}
	plan := normalizeTrafficPlan(srv.TrafficPlan)
	now := time.Now().In(time.Local)
	start, end, daysElapsed, daysTotal, daysRemaining := computeBillingCycle(now, plan.ResetDay)
	cycleStartStr := start.Format("2006-01-02")
	cycleEndStr := end.Format("2006-01-02")
	todayStr := now.Format("2006-01-02")

	dayMap := map[string]DailyTrafficPoint{}
	var firstTrackedDay string
	if metricsDB != nil {
		rows, err := metricsDB.Query(`
			SELECT day, rx_bytes, tx_bytes, peak_rx_bps, peak_tx_bps
			FROM traffic_daily
			WHERE server_id = ? AND day >= ? AND day < ?
			ORDER BY day ASC
		`, srv.ID, cycleStartStr, cycleEndStr)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var pt DailyTrafficPoint
				if rows.Scan(&pt.Day, &pt.RxBytes, &pt.TxBytes, &pt.PeakRxBps, &pt.PeakTxBps) == nil {
					if firstTrackedDay == "" {
						firstTrackedDay = pt.Day
					}
					dayMap[pt.Day] = pt
				}
			}
		}
	}

	var cycleRx, cycleTx, todayRx, todayTx int64
	var peakRx, peakTx float64
	dailySeries := make([]DailyTrafficPoint, 0, daysElapsed)
	for cur := start; !cur.After(now); cur = cur.AddDate(0, 0, 1) {
		key := cur.Format("2006-01-02")
		pt, ok := dayMap[key]
		if !ok {
			pt = DailyTrafficPoint{Day: key}
		}
		cycleRx += pt.RxBytes
		cycleTx += pt.TxBytes
		if pt.PeakRxBps > peakRx {
			peakRx = pt.PeakRxBps
		}
		if pt.PeakTxBps > peakTx {
			peakTx = pt.PeakTxBps
		}
		if key == todayStr {
			todayRx = pt.RxBytes
			todayTx = pt.TxBytes
		}
		dailySeries = append(dailySeries, pt)
	}

	var baselineBytes int64
	if plan.BaselineGB > 0 && (plan.BaselineCycleKey == "" || plan.BaselineCycleKey == cycleStartStr) {
		baselineBytes = int64(math.Round(plan.BaselineGB * bytesPerGB))
	}

	billedBytes := computeBilledBytes(cycleRx, cycleTx, baselineBytes, plan.BillingMode)
	var quotaBytes int64
	var usedPct float64
	if plan.MonthlyQuotaGB > 0 {
		quotaBytes = int64(math.Round(plan.MonthlyQuotaGB * bytesPerGB))
		if quotaBytes > 0 {
			usedPct = round1(float64(billedBytes) / float64(quotaBytes) * 100.0)
		}
	}

	// Estimate end-of-cycle projected usage carefully (handles mid-cycle onboarding without distortion)
	fracToday := float64(now.Hour()*60+now.Minute()) / 1440.0
	var projectedBytes int64
	if baselineBytes > 0 {
		elapsedFrac := float64(daysElapsed-1) + fracToday
		if elapsedFrac < 0.5 {
			elapsedFrac = 0.5
		}
		projectedBytes = int64(math.Round(float64(billedBytes) / elapsedFrac * float64(daysTotal)))
	} else if firstTrackedDay != "" {
		firstT, err := time.ParseInLocation("2006-01-02", firstTrackedDay, time.Local)
		if err != nil || firstT.Before(start) {
			firstT = start
		}
		todayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.Local)
		obsDays := math.Round(todayStart.Sub(firstT).Hours()/24) + fracToday
		if obsDays < 0.5 {
			obsDays = 0.5
		}
		remFrac := float64(daysRemaining) + (1.0 - fracToday)
		dailyRate := float64(billedBytes) / obsDays
		projectedBytes = billedBytes + int64(math.Round(dailyRate*remFrac))
	}

	return &TrafficSummary{
		CycleStart:     cycleStartStr,
		CycleEnd:       cycleEndStr,
		DaysElapsed:    daysElapsed,
		DaysTotal:      daysTotal,
		DaysRemaining:  daysRemaining,
		TodayRxBytes:   todayRx,
		TodayTxBytes:   todayTx,
		CycleRxBytes:   cycleRx,
		CycleTxBytes:   cycleTx,
		BaselineBytes:  baselineBytes,
		BilledBytes:    billedBytes,
		QuotaBytes:     quotaBytes,
		UsedPercent:    usedPct,
		ProjectedBytes: projectedBytes,
		PeakRxBps:      round1(peakRx),
		PeakTxBps:      round1(peakTx),
		BandwidthMbps:  plan.BandwidthMbps,
		BillingMode:    plan.BillingMode,
		ResetDay:       plan.ResetDay,
		DailySeries:    dailySeries,
	}
}

func pruneOldSamples(retentionDays int) {
	if metricsDB == nil {
		return
	}
	cutoff := time.Now().Add(-time.Duration(retentionDays) * 24 * time.Hour).UnixMilli()
	_, _ = metricsDB.Exec(`DELETE FROM metric_samples WHERE ts < ?`, cutoff)
}

func round1(v float64) float64 {
	return math.Round(v*10) / 10
}

func round2(v float64) float64 {
	return math.Round(v*100) / 100
}

func queryMetricHistory(serverID, rng string) MetricHistoryResult {
	if metricsDB == nil {
		_ = initMetricsDB()
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
	type sampleRow struct {
		ts      int64
		cpuPct  float64
		memPct  float64
		diskPct float64
		load1   float64
		rxBps   float64
		txBps   float64
		rxTotal int64
		txTotal int64
	}
	rows := []sampleRow{}
	if metricsDB != nil {
		q, err := metricsDB.Query(`
			SELECT ts, cpu_pct, mem_pct, disk_pct, load1, rx_bps, tx_bps, rx_total, tx_total
			FROM metric_samples
			WHERE server_id = ? AND ts >= ?
			ORDER BY ts ASC
		`, serverID, since)
		if err == nil {
			defer q.Close()
			for q.Next() {
				var r sampleRow
				if q.Scan(&r.ts, &r.cpuPct, &r.memPct, &r.diskPct, &r.load1, &r.rxBps, &r.txBps, &r.rxTotal, &r.txTotal) == nil {
					rows = append(rows, r)
				}
			}
		}
	}

	var rxBytes, txBytes int64
	for i := 1; i < len(rows); i++ {
		drx := rows[i].rxTotal - rows[i-1].rxTotal
		dtx := rows[i].txTotal - rows[i-1].txTotal
		if drx >= 0 {
			rxBytes += drx
		} else {
			rxBytes += rows[i].rxTotal
		}
		if dtx >= 0 {
			txBytes += dtx
		} else {
			txBytes += rows[i].txTotal
		}
	}

	const maxPoints = 90
	points := make([]MetricHistoryPoint, 0, min(len(rows), maxPoints))
	if len(rows) <= maxPoints {
		for _, r := range rows {
			points = append(points, MetricHistoryPoint{
				TS:          r.ts,
				CPUPercent:  round1(r.cpuPct),
				MemPercent:  round1(r.memPct),
				DiskPercent: round1(r.diskPct),
				Load1:       round2(r.load1),
				NetRxBps:    int64(math.Round(r.rxBps)),
				NetTxBps:    int64(math.Round(r.txBps)),
			})
		}
	} else {
		bucketSize := (len(rows) + maxPoints - 1) / maxPoints
		for i := 0; i < len(rows); i += bucketSize {
			end := i + bucketSize
			if end > len(rows) {
				end = len(rows)
			}
			slice := rows[i:end]
			n := float64(len(slice))
			var sCPU, sMem, sDisk, sLoad, sRx, sTx float64
			for _, x := range slice {
				sCPU += x.cpuPct
				sMem += x.memPct
				sDisk += x.diskPct
				sLoad += x.load1
				sRx += x.rxBps
				sTx += x.txBps
			}
			points = append(points, MetricHistoryPoint{
				TS:          slice[len(slice)/2].ts,
				CPUPercent:  round1(sCPU / n),
				MemPercent:  round1(sMem / n),
				DiskPercent: round1(sDisk / n),
				Load1:       round2(sLoad / n),
				NetRxBps:    int64(math.Round(sRx / n)),
				NetTxBps:    int64(math.Round(sTx / n)),
			})
		}
	}

	return MetricHistoryResult{
		Range:       rng,
		Points:      points,
		Traffic:     MetricTraffic{RxBytes: rxBytes, TxBytes: txBytes},
		SampleCount: len(rows),
	}
}

type DBStats struct {
	TotalSamples int    `json:"totalSamples"`
	DBPath       string `json:"dbPath"`
}

func getDBStats() DBStats {
	if metricsDB == nil {
		_ = initMetricsDB()
	}
	cnt := 0
	if metricsDB != nil {
		_ = metricsDB.QueryRow(`SELECT COUNT(*) FROM metric_samples`).Scan(&cnt)
	}
	return DBStats{TotalSamples: cnt, DBPath: metricsDBPath}
}

func startBackgroundSampler(interval time.Duration) {
	samplerOnce.Do(func() {
		_ = initMetricsDB()
		tick := func() {
			servers := loadServers()
			var wg sync.WaitGroup
			for _, srv := range servers {
				wg.Add(1)
				go func(s ServerConfig) {
					defer wg.Done()
					m, err := collectSingleMetrics(s)
					if err != nil {
						evaluateServerAlerts(s, nil, err.Error())
						return
					}
					insertMetricSample(s.ID, m)
					evaluateServerAlerts(s, &m, "")
				}(srv)
			}
			wg.Wait()
		}

		go func() {
			time.Sleep(4 * time.Second)
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
					pruneOldSamples(7)
					pruneOldDailyTraffic(400)
				}
			}
		}()
	})
}
