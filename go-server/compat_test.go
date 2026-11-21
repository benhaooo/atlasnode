package main

import (
	"testing"
)

func TestPasswordAndTokenCompat(t *testing.T) {
	// Verify scrypt hashing & verification round-trip
	h := hashPassword("example-test-password-123", "0123456789abcdef0123456789abcdef")
	if !verifyPassword("example-test-password-123", h) {
		t.Fatalf("expected password to verify")
	}
	if verifyPassword("wrong-pass", h) {
		t.Fatalf("expected wrong password to fail")
	}

	// Verify HMAC token round-trip
	secret := "test-secret-hex"
	payload := "eyJpYXQiOjE3MDAwMDAwMDAsImV4cCI6OTk5OTk5OTk5OTk5OX0"
	tok := signToken(payload, secret)
	if !verifyToken(tok, secret) {
		t.Fatalf("expected valid token to verify")
	}
	if verifyToken(tok+"x", secret) {
		t.Fatalf("expected tampered token to fail")
	}
}

func TestNftAndBackrouteParsing(t *testing.T) {
	rawNft := `table inet cloud_agent {
	chain input {
		type filter hook input priority 0; policy accept;
		tcp dport 22 accept # handle 5
		tcp dport 9800 accept comment "AtlasNode" # handle 12
		iifname "ens17" drop # handle 20
	}
}`
	rules, target := parseNftRulesFromText(rawNft)
	if target == nil || target.Table != "inet cloud_agent" || target.Chain != "input" {
		t.Fatalf("unexpected nft target: %+v", target)
	}
	if len(rules) != 3 {
		t.Fatalf("expected 3 rules, got %d", len(rules))
	}
	if rules[1].Ports != "9800" || rules[1].Comment != "AtlasNode" || rules[1].Handle != 12 {
		t.Fatalf("unexpected rule[1]: %+v", rules[1])
	}

	bt := `广东 电信 电信CN2GIA [优质线路]
地理路径：中国香港 -> 中国广东广州   自治系统路径：AS4809 -> AS4134
1  2.3ms  10.0.0.1`
	traces := parseBackrouteTraces(bt)
	if len(traces) != 1 || traces[0].City != "广东" || traces[0].ISP != "电信" || len(traces[0].Hops) != 1 {
		t.Fatalf("unexpected traces: %+v", traces)
	}
}
