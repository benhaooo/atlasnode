package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/scrypt"
)

const (
	cookieName   = "atlasnode_session"
	sessionTTLMs = int64(30 * 24 * 60 * 60 * 1000)
)

type rateLimitEntry struct {
	attempts int
	resetAt  int64
}

var (
	loginLimitMu sync.Mutex
	loginLimits  = map[string]rateLimitEntry{}
)

// Exact Node.js crypto.scryptSync(password, salt, 64) parameters: N=16384, r=8, p=1, keyLen=64
func hashPassword(password, salt string) string {
	if salt == "" {
		salt = randomHex(16)
	}
	dk, _ := scrypt.Key([]byte(password), []byte(salt), 16384, 8, 1, 64)
	return salt + ":" + hex.EncodeToString(dk)
}

func verifyPassword(password, stored string) bool {
	parts := strings.SplitN(stored, ":", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return false
	}
	storedBytes, err := hex.DecodeString(parts[1])
	if err != nil {
		return false
	}
	dk, err := scrypt.Key([]byte(password), []byte(parts[0]), 16384, 8, 1, len(storedBytes))
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(dk, storedBytes) == 1
}

func ensureAuthInitialized() string {
	if loadAuth() != nil {
		return ""
	}
	pass := os.Getenv("ATLASNODE_PASSWORD")
	if pass == "" {
		b := make([]byte, 12)
		_, _ = rand.Read(b)
		pass = base64.RawURLEncoding.EncodeToString(b)
	}
	_ = saveAuth(AuthStore{
		PasswordHash:  hashPassword(pass, ""),
		SessionSecret: randomHex(32),
		UpdatedAt:     time.Now().UTC().Format(time.RFC3339),
	})
	return pass
}

func signToken(payload, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return payload + "." + sig
}

func verifyToken(token, secret string) bool {
	dot := strings.LastIndex(token, ".")
	if dot <= 0 {
		return false
	}
	payload := token[:dot]
	sig := token[dot+1:]

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	expected := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))

	if subtle.ConstantTimeCompare([]byte(sig), []byte(expected)) != 1 {
		return false
	}
	raw, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return false
	}
	var parsed struct {
		Exp int64 `json:"exp"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return false
	}
	return parsed.Exp > time.Now().UnixMilli()
}

func isRequestAuthenticated(r *http.Request) bool {
	auth := loadAuth()
	if auth == nil {
		return false
	}
	token := ""
	if c, err := r.Cookie(cookieName); err == nil {
		if decoded, err2 := url.QueryUnescape(c.Value); err2 == nil {
			token = decoded
		} else {
			token = c.Value
		}
	}
	if token == "" {
		token = r.Header.Get("X-Atlas-Token")
	}
	if token == "" {
		return false
	}
	return verifyToken(token, auth.SessionSecret)
}

func requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !isRequestAuthenticated(r) {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "Unauthorized"})
			return
		}
		next(w, r)
	}
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil && host != "" {
		return host
	}
	return r.RemoteAddr
}

func handleLogin(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	now := time.Now().UnixMilli()

	loginLimitMu.Lock()
	lim := loginLimits[ip]
	if lim.resetAt > now && lim.attempts >= 10 {
		loginLimitMu.Unlock()
		writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "尝试次数过多，请 5 分钟后再试"})
		return
	}
	loginLimitMu.Unlock()

	var body struct {
		Password string `json:"password"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	auth := loadAuth()
	if auth == nil || !verifyPassword(body.Password, auth.PasswordHash) {
		loginLimitMu.Lock()
		cur := loginLimits[ip]
		if cur.resetAt > now {
			cur.attempts++
		} else {
			cur = rateLimitEntry{attempts: 1, resetAt: now + 5*60*1000}
		}
		loginLimits[ip] = cur
		loginLimitMu.Unlock()
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "访问密钥不正确"})
		return
	}

	loginLimitMu.Lock()
	delete(loginLimits, ip)
	loginLimitMu.Unlock()

	payloadBytes, _ := json.Marshal(map[string]int64{
		"iat": now,
		"exp": now + sessionTTLMs,
	})
	payload := base64.RawURLEncoding.EncodeToString(payloadBytes)
	token := signToken(payload, auth.SessionSecret)

	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    url.QueryEscape(token),
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(sessionTTLMs / 1000),
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func handleLogout(w http.ResponseWriter, _ *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func changePassword(currentPassword, newPassword string) (bool, string) {
	auth := loadAuth()
	if auth == nil {
		return false, "Auth not initialized"
	}
	if !verifyPassword(currentPassword, auth.PasswordHash) {
		return false, "当前密钥不正确"
	}
	if len(newPassword) < 6 {
		return false, "新密钥长度至少 6 位"
	}
	_ = saveAuth(AuthStore{
		PasswordHash:  hashPassword(newPassword, ""),
		SessionSecret: auth.SessionSecret,
		UpdatedAt:     time.Now().UTC().Format(time.RFC3339),
	})
	return true, ""
}
