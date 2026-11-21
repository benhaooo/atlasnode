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
	`)
	if err != nil {
		_ = db.Close()
		return err
	}
	metricsDB = db
	return nil
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
				}
			}
		}()
	})
}
