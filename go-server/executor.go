package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

func sshKeyPath() string {
	if env := os.Getenv("ATLASNODE_SSH_KEY"); env != "" {
		return env
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".ssh", "id_ed25519_atlasnode")
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

func getManagerPublicKey() string {
	b, err := os.ReadFile(sshKeyPath() + ".pub")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

var (
	signerMu     sync.Mutex
	cachedSigner ssh.Signer
)

func loadSSHSigner() (ssh.Signer, error) {
	signerMu.Lock()
	defer signerMu.Unlock()
	if cachedSigner != nil {
		return cachedSigner, nil
	}
	keyBytes, err := os.ReadFile(sshKeyPath())
	if err != nil {
		return nil, err
	}
	signer, err := ssh.ParsePrivateKey(keyBytes)
	if err != nil {
		return nil, err
	}
	cachedSigner = signer
	return signer, nil
}

type poolEntry struct {
	key        string
	client     *ssh.Client
	jumpConn   net.Conn
	lastUsedAt time.Time
	stopKeep   chan struct{}
	sftpMu     sync.Mutex
	sftpClient *sftp.Client
	mu         sync.Mutex
}

func (e *poolEntry) touch() {
	e.mu.Lock()
	e.lastUsedAt = time.Now()
	e.mu.Unlock()
}

func (e *poolEntry) closeAll() {
	e.mu.Lock()
	if e.stopKeep != nil {
		select {
		case <-e.stopKeep:
		default:
			close(e.stopKeep)
		}
	}
	e.mu.Unlock()

	e.sftpMu.Lock()
	if e.sftpClient != nil {
		_ = e.sftpClient.Close()
		e.sftpClient = nil
	}
	e.sftpMu.Unlock()

	if e.client != nil {
		_ = e.client.Close()
	}
	if e.jumpConn != nil {
		_ = e.jumpConn.Close()
	}
}

type poolInflight struct {
	wg    sync.WaitGroup
	entry *poolEntry
	err   error
}

var (
	sshPoolMu       sync.Mutex
	sshPool         = map[string]*poolEntry{}
	sshConnecting   = map[string]*poolInflight{}
	poolReaperOnce  sync.Once
)

func startPoolReaper() {
	poolReaperOnce.Do(func() {
		go func() {
			ticker := time.NewTicker(60 * time.Second)
			defer ticker.Stop()
			for range ticker.C {
				cutoff := time.Now().Add(-10 * time.Minute)
				var evict []*poolEntry
				sshPoolMu.Lock()
				for k, e := range sshPool {
					e.mu.Lock()
					lu := e.lastUsedAt
					e.mu.Unlock()
					if lu.Before(cutoff) {
						delete(sshPool, k)
						evict = append(evict, e)
					}
				}
				sshPoolMu.Unlock()
				for _, e := range evict {
					e.closeAll()
				}
			}
		}()
	})
}

func connectionKey(srv ServerConfig) string {
	port := srv.Port
	if port <= 0 {
		port = 22
	}
	j := ""
	if srv.JumpHost != nil && srv.JumpHost.Host != "" {
		jp := srv.JumpHost.Port
		if jp <= 0 {
			jp = 22
		}
		j = fmt.Sprintf("%s@%s:%d", srv.JumpHost.Username, srv.JumpHost.Host, jp)
	}
	return fmt.Sprintf("%s@%s:%d|via:%s", srv.Username, srv.Host, port, j)
}

func evictPoolKey(key string) {
	sshPoolMu.Lock()
	e := sshPool[key]
	delete(sshPool, key)
	sshPoolMu.Unlock()
	if e != nil {
		e.closeAll()
	}
}

func startKeepalive(key string, entry *poolEntry) {
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		missed := 0
		for {
			select {
			case <-entry.stopKeep:
				return
			case <-ticker.C:
				_, _, err := entry.client.SendRequest("keepalive@openssh.com", true, nil)
				if err != nil {
					missed++
					if missed >= 3 {
						evictPoolKey(key)
						return
					}
				} else {
					missed = 0
				}
			}
		}
	}()
	go func() {
		_ = entry.client.Wait()
		sshPoolMu.Lock()
		if sshPool[key] == entry {
			delete(sshPool, key)
		}
		sshPoolMu.Unlock()
		entry.closeAll()
	}()
}

func connectDirect(host string, port int, username string) (*poolEntry, error) {
	startPoolReaper()
	if port <= 0 {
		port = 22
	}
	key := fmt.Sprintf("%s@%s:%d|via:", username, host, port)

	sshPoolMu.Lock()
	if existing, ok := sshPool[key]; ok {
		existing.touch()
		sshPoolMu.Unlock()
		return existing, nil
	}
	if inf, ok := sshConnecting[key]; ok {
		sshPoolMu.Unlock()
		inf.wg.Wait()
		return inf.entry, inf.err
	}
	inf := &poolInflight{}
	inf.wg.Add(1)
	sshConnecting[key] = inf
	sshPoolMu.Unlock()

	var entry *poolEntry
	var err error
	defer func() {
		sshPoolMu.Lock()
		if err == nil && entry != nil {
			sshPool[key] = entry
		}
		delete(sshConnecting, key)
		sshPoolMu.Unlock()
		inf.entry = entry
		inf.err = err
		inf.wg.Done()
	}()

	signer, err := loadSSHSigner()
	if err != nil {
		return nil, fmt.Errorf("读取 SSH 私钥失败: %w", err)
	}
	cfg := &ssh.ClientConfig{
		User:            username,
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         10 * time.Second,
	}
	addr := net.JoinHostPort(host, fmt.Sprintf("%d", port))
	client, err := ssh.Dial("tcp", addr, cfg)
	if err != nil {
		return nil, err
	}
	entry = &poolEntry{
		key:        key,
		client:     client,
		lastUsedAt: time.Now(),
		stopKeep:   make(chan struct{}),
	}
	startKeepalive(key, entry)
	return entry, nil
}

func acquireClient(srv ServerConfig) (*poolEntry, error) {
	startPoolReaper()
	key := connectionKey(srv)
	port := srv.Port
	if port <= 0 {
		port = 22
	}

	sshPoolMu.Lock()
	if existing, ok := sshPool[key]; ok {
		existing.touch()
		sshPoolMu.Unlock()
		return existing, nil
	}
	sshPoolMu.Unlock()

	if srv.JumpHost == nil || srv.JumpHost.Host == "" {
		return connectDirect(srv.Host, port, srv.Username)
	}

	sshPoolMu.Lock()
	if existing, ok := sshPool[key]; ok {
		existing.touch()
		sshPoolMu.Unlock()
		return existing, nil
	}
	if inf, ok := sshConnecting[key]; ok {
		sshPoolMu.Unlock()
		inf.wg.Wait()
		return inf.entry, inf.err
	}
	inf := &poolInflight{}
	inf.wg.Add(1)
	sshConnecting[key] = inf
	sshPoolMu.Unlock()

	var entry *poolEntry
	var err error
	defer func() {
		sshPoolMu.Lock()
		if err == nil && entry != nil {
			sshPool[key] = entry
		}
		delete(sshConnecting, key)
		sshPoolMu.Unlock()
		inf.entry = entry
		inf.err = err
		inf.wg.Done()
	}()

	jp := srv.JumpHost.Port
	if jp <= 0 {
		jp = 22
	}
	jumpEntry, err := connectDirect(srv.JumpHost.Host, jp, srv.JumpHost.Username)
	if err != nil {
		return nil, fmt.Errorf("跳板机连接失败: %w", err)
	}
	targetAddr := net.JoinHostPort(srv.Host, fmt.Sprintf("%d", port))
	nconn, err := jumpEntry.client.Dial("tcp", targetAddr)
	if err != nil {
		return nil, fmt.Errorf("经由跳板机连接目标失败: %w", err)
	}
	signer, err := loadSSHSigner()
	if err != nil {
		_ = nconn.Close()
		return nil, err
	}
	cfg := &ssh.ClientConfig{
		User:            srv.Username,
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         10 * time.Second,
	}
	cconn, chans, reqs, err := ssh.NewClientConn(nconn, targetAddr, cfg)
	if err != nil {
		_ = nconn.Close()
		return nil, err
	}
	client := ssh.NewClient(cconn, chans, reqs)
	entry = &poolEntry{
		key:        key,
		client:     client,
		jumpConn:   nconn,
		lastUsedAt: time.Now(),
		stopKeep:   make(chan struct{}),
	}
	startKeepalive(key, entry)
	return entry, nil
}

func acquireSftp(srv ServerConfig) (*sftp.Client, error) {
	entry, err := acquireClient(srv)
	if err != nil {
		return nil, err
	}
	entry.sftpMu.Lock()
	defer entry.sftpMu.Unlock()
	if entry.sftpClient != nil {
		return entry.sftpClient, nil
	}
	sc, err := sftp.NewClient(entry.client)
	if err != nil {
		return nil, err
	}
	entry.sftpClient = sc
	return sc, nil
}

type PoolConnStat struct {
	Key     string `json:"key"`
	IdleSec int    `json:"idleSec"`
}

type PoolStats struct {
	ActiveConnections int            `json:"activeConnections"`
	Connections       []PoolConnStat `json:"connections"`
}

func getPoolStats() PoolStats {
	now := time.Now()
	sshPoolMu.Lock()
	defer sshPoolMu.Unlock()
	conns := make([]PoolConnStat, 0, len(sshPool))
	for _, e := range sshPool {
		e.mu.Lock()
		idle := int(now.Sub(e.lastUsedAt).Seconds())
		e.mu.Unlock()
		conns = append(conns, PoolConnStat{Key: e.key, IdleSec: idle})
	}
	return PoolStats{
		ActiveConnections: len(conns),
		Connections:       conns,
	}
}

type ExecOpts struct {
	Args      []string
	Timeout   time.Duration
	MaxBuffer int
	Sudo      bool
}

type ExecResult struct {
	Stdout string
	Stderr string
	Code   int
}

type ExecBufResult struct {
	Stdout []byte
	Stderr string
	Code   int
}

func buildRunnerCmd(opts ExecOpts, srv ServerConfig) string {
	quoted := make([]string, 0, len(opts.Args))
	for _, a := range opts.Args {
		quoted = append(quoted, shellQuote(a))
	}
	extra := strings.Join(quoted, " ")
	if opts.Sudo && srv.UseSudo {
		return "sudo -n bash -s -- " + extra
	}
	return "bash -s -- " + extra
}

type limitedBuffer struct {
	buf bytes.Buffer
	max int
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	if l.max <= 0 || l.buf.Len() < l.max {
		remain := len(p)
		if l.max > 0 && l.buf.Len()+remain > l.max {
			remain = l.max - l.buf.Len()
		}
		l.buf.Write(p[:remain])
	}
	return len(p), nil
}

func execScript(srv ServerConfig, script string, opts ExecOpts) (ExecResult, error) {
	if opts.Timeout == 0 {
		opts.Timeout = 20 * time.Second
	}
	if opts.MaxBuffer == 0 {
		opts.MaxBuffer = 8 * 1024 * 1024
	}
	r, err := execScriptBuffer(srv, script, opts)
	return ExecResult{
		Stdout: string(r.Stdout),
		Stderr: r.Stderr,
		Code:   r.Code,
	}, err
}

func execScriptBuffer(srv ServerConfig, script string, opts ExecOpts) (ExecBufResult, error) {
	if opts.Timeout == 0 {
		opts.Timeout = 30 * time.Second
	}
	if opts.MaxBuffer == 0 {
		opts.MaxBuffer = 50 * 1024 * 1024
	}
	runner := buildRunnerCmd(opts, srv)
	if srv.Mode == "local" {
		return execLocalBuffer(runner, script, opts.Timeout, opts.MaxBuffer)
	}
	return execSSHBuffer(srv, runner, script, opts.Timeout, opts.MaxBuffer, false)
}

func execLocalBuffer(runner, script string, timeout time.Duration, maxBuffer int) (ExecBufResult, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "bash", "-c", runner)
	cmd.Stdin = strings.NewReader(script)
	outBuf := &limitedBuffer{max: maxBuffer}
	errBuf := &limitedBuffer{max: 512 * 1024}
	cmd.Stdout = outBuf
	cmd.Stderr = errBuf

	err := cmd.Run()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return ExecBufResult{}, fmt.Errorf("命令执行超时 (%ds)", int(timeout.Seconds()))
	}
	code := 0
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			code = exitErr.ExitCode()
		} else {
			return ExecBufResult{}, err
		}
	}
	return ExecBufResult{
		Stdout: outBuf.buf.Bytes(),
		Stderr: errBuf.buf.String(),
		Code:   code,
	}, nil
}

func execSSHBuffer(srv ServerConfig, runner, script string, timeout time.Duration, maxBuffer int, retried bool) (ExecBufResult, error) {
	entry, err := acquireClient(srv)
	if err != nil {
		return ExecBufResult{}, err
	}
	entry.touch()

	sess, err := entry.client.NewSession()
	if err != nil {
		if !retried {
			evictPoolKey(entry.key)
			return execSSHBuffer(srv, runner, script, timeout, maxBuffer, true)
		}
		return ExecBufResult{}, err
	}
	defer sess.Close()

	sess.Stdin = strings.NewReader(script)
	outBuf := &limitedBuffer{max: maxBuffer}
	errBuf := &limitedBuffer{max: 512 * 1024}
	sess.Stdout = outBuf
	sess.Stderr = errBuf

	done := make(chan error, 1)
	go func() {
		done <- sess.Run(runner)
	}()

	select {
	case <-time.After(timeout):
		_ = sess.Signal(ssh.SIGTERM)
		_ = sess.Close()
		return ExecBufResult{}, fmt.Errorf("SSH 命令执行超时 (%ds)", int(timeout.Seconds()))
	case runErr := <-done:
		code := 0
		if runErr != nil {
			var exitErr *ssh.ExitError
			if errors.As(runErr, &exitErr) {
				code = exitErr.ExitStatus()
			} else {
				if !retried && isConnErr(runErr) {
					evictPoolKey(entry.key)
					return execSSHBuffer(srv, runner, script, timeout, maxBuffer, true)
				}
				return ExecBufResult{}, runErr
			}
		}
		return ExecBufResult{
			Stdout: outBuf.buf.Bytes(),
			Stderr: errBuf.buf.String(),
			Code:   code,
		}, nil
	}
}

func isConnErr(err error) bool {
	if err == nil {
		return false
	}
	s := strings.ToLower(err.Error())
	return strings.Contains(s, "eof") ||
		strings.Contains(s, "closed") ||
		strings.Contains(s, "reset") ||
		strings.Contains(s, "broken pipe") ||
		strings.Contains(s, "not connected")
}

// StreamProcess provides unified streaming stdout/stderr + Kill + Wait for local & SSH commands.
type StreamProcess struct {
	Stdout io.ReadCloser
	Stderr io.ReadCloser
	killFn func()
	waitFn func() int
}

func (sp *StreamProcess) Kill() {
	if sp.killFn != nil {
		sp.killFn()
	}
}

func (sp *StreamProcess) Wait() int {
	if sp.waitFn != nil {
		return sp.waitFn()
	}
	return 0
}

func spawnScriptStream(srv ServerConfig, script string, opts ExecOpts) (*StreamProcess, error) {
	runner := buildRunnerCmd(opts, srv)
	if srv.Mode == "local" {
		cmd := exec.Command("bash", "-c", runner)
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		cmd.Stdin = strings.NewReader(script)
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			return nil, err
		}
		stderr, err := cmd.StderrPipe()
		if err != nil {
			return nil, err
		}
		if err := cmd.Start(); err != nil {
			return nil, err
		}
		var killOnce sync.Once
		return &StreamProcess{
			Stdout: stdout,
			Stderr: stderr,
			killFn: func() {
				killOnce.Do(func() {
					if cmd.Process != nil {
						_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
						go func() {
							time.Sleep(1500 * time.Millisecond)
							_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
						}()
					}
				})
			},
			waitFn: func() int {
				err := cmd.Wait()
				if err == nil {
					return 0
				}
				var exitErr *exec.ExitError
				if errors.As(err, &exitErr) {
					return exitErr.ExitCode()
				}
				return 1
			},
		}, nil
	}

	entry, err := acquireClient(srv)
	if err != nil {
		return nil, err
	}
	entry.touch()

	sess, err := entry.client.NewSession()
	if err != nil {
		evictPoolKey(entry.key)
		entry, err = acquireClient(srv)
		if err != nil {
			return nil, err
		}
		sess, err = entry.client.NewSession()
		if err != nil {
			return nil, err
		}
	}

	outR, outW := io.Pipe()
	errR, errW := io.Pipe()
	sess.Stdin = strings.NewReader(script)
	sess.Stdout = outW
	sess.Stderr = errW

	if err := sess.Start(runner); err != nil {
		_ = sess.Close()
		_ = outR.Close()
		_ = outW.Close()
		_ = errR.Close()
		_ = errW.Close()
		return nil, err
	}

	waitCh := make(chan int, 1)
	go func() {
		err := sess.Wait()
		_ = outW.Close()
		_ = errW.Close()
		_ = sess.Close()
		code := 0
		if err != nil {
			var exitErr *ssh.ExitError
			if errors.As(err, &exitErr) {
				code = exitErr.ExitStatus()
			} else {
				code = 1
			}
		}
		waitCh <- code
	}()

	var killOnce sync.Once
	return &StreamProcess{
		Stdout: outR,
		Stderr: errR,
		killFn: func() {
			killOnce.Do(func() {
				_ = sess.Signal(ssh.SIGTERM)
				_ = sess.Close()
			})
		},
		waitFn: func() int {
			return <-waitCh
		},
	}, nil
}

type SshPtySession struct {
	Session *ssh.Session
	Stdin   io.WriteCloser
	Stdout  io.Reader
	Stderr  io.Reader
}

func openSshPty(srv ServerConfig, cols, rows int, command string) (*SshPtySession, error) {
	entry, err := acquireClient(srv)
	if err != nil {
		return nil, err
	}
	entry.touch()

	sess, err := entry.client.NewSession()
	if err != nil {
		evictPoolKey(entry.key)
		entry, err = acquireClient(srv)
		if err != nil {
			return nil, err
		}
		sess, err = entry.client.NewSession()
		if err != nil {
			return nil, err
		}
	}

	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}
	if err := sess.RequestPty("xterm-256color", rows, cols, modes); err != nil {
		_ = sess.Close()
		return nil, err
	}
	stdin, err := sess.StdinPipe()
	if err != nil {
		_ = sess.Close()
		return nil, err
	}
	stdout, err := sess.StdoutPipe()
	if err != nil {
		_ = sess.Close()
		return nil, err
	}
	stderr, err := sess.StderrPipe()
	if err != nil {
		_ = sess.Close()
		return nil, err
	}

	if command != "" {
		err = sess.Start(command)
	} else {
		err = sess.Shell()
	}
	if err != nil {
		_ = sess.Close()
		return nil, err
	}
	return &SshPtySession{
		Session: sess,
		Stdin:   stdin,
		Stdout:  stdout,
		Stderr:  stderr,
	}, nil
}

func openDownloadStream(srv ServerConfig, remotePath string) (io.ReadCloser, error) {
	if srv.Mode == "local" {
		return os.Open(remotePath)
	}
	sc, err := acquireSftp(srv)
	if err == nil {
		if f, err2 := sc.Open(remotePath); err2 == nil {
			return f, nil
		}
	}
	// Sudo fallback for root-only files on sudo users
	res, err := execScriptBuffer(srv, `cat "$1"`, ExecOpts{
		Args:    []string{remotePath},
		Sudo:    true,
		Timeout: 45 * time.Second,
	})
	if err != nil {
		return nil, err
	}
	if res.Code != 0 {
		msg := strings.TrimSpace(res.Stderr)
		if msg == "" {
			msg = "下载失败"
		}
		return nil, errors.New(msg)
	}
	return io.NopCloser(bytes.NewReader(res.Stdout)), nil
}

func writeRemoteStream(srv ServerConfig, remotePath string, input io.Reader) error {
	if srv.Mode == "local" {
		if err := os.MkdirAll(filepath.Dir(remotePath), 0o755); err != nil {
			return err
		}
		f, err := os.Create(remotePath)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = io.Copy(f, input)
		return err
	}

	data, err := io.ReadAll(io.LimitReader(input, 60*1024*1024))
	if err != nil {
		return err
	}

	if sc, err := acquireSftp(srv); err == nil {
		if f, err2 := sc.Create(remotePath); err2 == nil {
			_, werr := f.Write(data)
			cerr := f.Close()
			if werr == nil && cerr == nil {
				return nil
			}
		}
	}

	// Sudo fallback via raw SSH stdin (zero base64 overhead)
	entry, err := acquireClient(srv)
	if err != nil {
		return err
	}
	sess, err := entry.client.NewSession()
	if err != nil {
		return err
	}
	defer sess.Close()
	cmd := "cat > " + shellQuote(remotePath)
	if srv.UseSudo {
		cmd = "sudo -n tee " + shellQuote(remotePath) + " >/dev/null"
	}
	sess.Stdin = bytes.NewReader(data)
	var errBuf bytes.Buffer
	sess.Stderr = &errBuf
	if err := sess.Run(cmd); err != nil {
		msg := strings.TrimSpace(errBuf.String())
		if msg == "" {
			msg = err.Error()
		}
		return errors.New(msg)
	}
	return nil
}
