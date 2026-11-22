package main

import (
	"sync/atomic"
	"testing"
	"time"
)

func TestTtlCacheStaleWhileRevalidate(t *testing.T) {
	c := NewTtlCache[int](40 * time.Millisecond)
	var calls atomic.Int32
	loader := func() (int, error) {
		n := int(calls.Add(1))
		time.Sleep(15 * time.Millisecond)
		return n, nil
	}

	// Cold miss -> synchronous load (val=1)
	v1, _, stale1, err := c.GetStaleOrLoad("k", false, 500*time.Millisecond, loader)
	if err != nil || v1 != 1 || stale1 {
		t.Fatalf("cold load: got v=%d stale=%v err=%v", v1, stale1, err)
	}

	// Fresh hit -> immediate return without calling loader
	v2, _, stale2, err := c.GetStaleOrLoad("k", false, 500*time.Millisecond, loader)
	if err != nil || v2 != 1 || stale2 || calls.Load() != 1 {
		t.Fatalf("fresh hit: got v=%d stale=%v calls=%d", v2, stale2, calls.Load())
	}

	// Wait past TTL -> stale hit returns immediately with v=1 and triggers 1 background refresh
	time.Sleep(55 * time.Millisecond)
	t0 := time.Now()
	v3, _, stale3, err := c.GetStaleOrLoad("k", false, 500*time.Millisecond, loader)
	elapsed := time.Since(t0)
	if err != nil || v3 != 1 || !stale3 || elapsed > 10*time.Millisecond {
		t.Fatalf("stale hit: got v=%d stale=%v elapsed=%v", v3, stale3, elapsed)
	}

	// Wait for background refresh to finish -> next read gets fresh v=2
	time.Sleep(40 * time.Millisecond)
	v4, _, stale4, err := c.GetStaleOrLoad("k", false, 500*time.Millisecond, loader)
	if err != nil || v4 != 2 || stale4 {
		t.Fatalf("post-revalidate: got v=%d stale=%v", v4, stale4)
	}

	// fresh=true bypasses cache
	v5, _, stale5, err := c.GetStaleOrLoad("k", true, 500*time.Millisecond, loader)
	if err != nil || v5 != 3 || stale5 {
		t.Fatalf("forced fresh: got v=%d stale=%v", v5, stale5)
	}
}
