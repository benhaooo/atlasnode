package main

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

var (
	wsUpgrader = websocket.Upgrader{
		ReadBufferSize:  4096,
		WriteBufferSize: 4096,
		CheckOrigin:     func(r *http.Request) bool { return true },
	}
	reContainerName = regexp.MustCompile(`^[a-zA-Z0-9_.-]{2,80}$`)
)

type safeWS struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func (s *safeWS) sendJSON(v any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.conn.WriteJSON(v)
}

func (s *safeWS) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.conn.Close()
}

func clampInt(val, def, minV, maxV int) int {
	if val <= 0 {
		val = def
	}
	if val < minV {
		return minV
	}
	if val > maxV {
		return maxV
	}
	return val
}

func handleTerminalWS(w http.ResponseWriter, r *http.Request) {
	if !isRequestAuthenticated(r) {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	sws := &safeWS{conn: conn}

	q := r.URL.Query()
	serverID := q.Get("serverId")
	container := strings.TrimSpace(q.Get("container"))
	colsRaw, _ := strconv.Atoi(q.Get("cols"))
	rowsRaw, _ := strconv.Atoi(q.Get("rows"))
	cols := clampInt(colsRaw, 100, 20, 300)
	rows := clampInt(rowsRaw, 30, 10, 120)

	srv := getServerByID(serverID)
	if srv == nil {
		sws.sendJSON(map[string]any{"type": "error", "message": "服务器不存在"})
		sws.close()
		return
	}
	if container != "" && !reContainerName.MatchString(container) {
		sws.sendJSON(map[string]any{"type": "error", "message": "非法的容器标识"})
		sws.close()
		return
	}

	if srv.Mode == "local" {
		handleLocalPTY(sws, container, cols, rows)
		return
	}
	handleRemotePTY(sws, *srv, container, cols, rows)
}

func handleLocalPTY(sws *safeWS, container string, cols, rows int) {
	var cmd *exec.Cmd
	if container != "" {
		cmd = exec.Command("docker", "exec", "-it", container, "sh", "-c", "command -v bash >/dev/null 2>&1 && exec bash || exec sh")
	} else {
		cmd = exec.Command("/bin/bash", "-l")
	}
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{
		Rows: uint16(rows),
		Cols: uint16(cols),
	})
	if err != nil {
		sws.sendJSON(map[string]any{"type": "error", "message": err.Error()})
		sws.close()
		return
	}

	// Read PTY -> WS
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				sws.sendJSON(map[string]any{"type": "output", "data": string(buf[:n])})
			}
			if err != nil {
				break
			}
		}
		code := 0
		if err := cmd.Wait(); err != nil {
			if ee, ok := err.(*exec.ExitError); ok {
				code = ee.ExitCode()
			}
		}
		sws.sendJSON(map[string]any{"type": "exit", "code": code})
		sws.close()
	}()

	// Read WS -> PTY
	for {
		_, raw, err := sws.conn.ReadMessage()
		if err != nil {
			break
		}
		var msg struct {
			Type string `json:"type"`
			Data string `json:"data"`
			Cols int    `json:"cols"`
			Rows int    `json:"rows"`
		}
		if json.Unmarshal(raw, &msg) != nil {
			continue
		}
		switch msg.Type {
		case "input":
			if msg.Data != "" {
				_, _ = ptmx.Write([]byte(msg.Data))
			}
		case "resize":
			c := clampInt(msg.Cols, 100, 20, 300)
			rr := clampInt(msg.Rows, 30, 10, 120)
			_ = pty.Setsize(ptmx, &pty.Winsize{Rows: uint16(rr), Cols: uint16(c)})
		}
	}

	_ = ptmx.Close()
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}

func handleRemotePTY(sws *safeWS, srv ServerConfig, container string, cols, rows int) {
	remoteCmd := ""
	if container != "" {
		prefix := ""
		if srv.UseSudo {
			prefix = "sudo -n "
		}
		remoteCmd = prefix + "docker exec -it " + shellQuote(container) + " sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'"
	}

	ptySess, err := openSshPty(srv, cols, rows, remoteCmd)
	if err != nil {
		sws.sendJSON(map[string]any{"type": "error", "message": err.Error()})
		sws.close()
		return
	}

	pump := func(r io.Reader) {
		buf := make([]byte, 4096)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				sws.sendJSON(map[string]any{"type": "output", "data": string(buf[:n])})
			}
			if err != nil {
				return
			}
		}
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); pump(ptySess.Stdout) }()
	go func() { defer wg.Done(); pump(ptySess.Stderr) }()
	go func() {
		_ = ptySess.Session.Wait()
		wg.Wait()
		sws.sendJSON(map[string]any{"type": "exit", "code": 0})
		sws.close()
	}()

	for {
		_, raw, err := sws.conn.ReadMessage()
		if err != nil {
			break
		}
		var msg struct {
			Type string `json:"type"`
			Data string `json:"data"`
			Cols int    `json:"cols"`
			Rows int    `json:"rows"`
		}
		if json.Unmarshal(raw, &msg) != nil {
			continue
		}
		switch msg.Type {
		case "input":
			if msg.Data != "" {
				_, _ = ptySess.Stdin.Write([]byte(msg.Data))
			}
		case "resize":
			c := clampInt(msg.Cols, 100, 20, 300)
			rr := clampInt(msg.Rows, 30, 10, 120)
			_ = ptySess.Session.WindowChange(rr, c)
		}
	}

	_ = ptySess.Stdin.Close()
	_ = ptySess.Session.Close()
}
