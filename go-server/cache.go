package main

import (
	"sync"
	"time"
)

type cacheEntry[T any] struct {
	value     T
	updatedAt time.Time
	expiresAt time.Time
}

type inflightCall[T any] struct {
	wg        sync.WaitGroup
	val       T
	updatedAt time.Time
	err       error
}

type TtlCache[T any] struct {
	mu         sync.Mutex
	defaultTTL time.Duration
	store      map[string]cacheEntry[T]
	inflight   map[string]*inflightCall[T]
}

func NewTtlCache[T any](ttl time.Duration) *TtlCache[T] {
	return &TtlCache[T]{
		defaultTTL: ttl,
		store:      make(map[string]cacheEntry[T]),
		inflight:   make(map[string]*inflightCall[T]),
	}
}

func (c *TtlCache[T]) GetOrLoad(key string, fresh bool, loader func() (T, error)) (T, error) {
	val, _, _, err := c.GetStaleOrLoad(key, fresh, 0, loader)
	return val, err
}

// GetStaleOrLoad implements TTL caching with optional Stale-While-Revalidate (maxStale > 0).
// - Fresh hit (< TTL): returns cached value immediately (stale=false).
// - Stale hit (TTL <= age < TTL+maxStale): returns cached value immediately (stale=true)
//   and triggers a single deduplicated background refresh.
// - Cold miss or fresh=true: awaits loader synchronously and refreshes cache.
func (c *TtlCache[T]) GetStaleOrLoad(
	key string,
	fresh bool,
	maxStale time.Duration,
	loader func() (T, error),
) (T, time.Time, bool, error) {
	now := time.Now()
	c.mu.Lock()
	if !fresh {
		if hit, ok := c.store[key]; ok {
			if hit.expiresAt.After(now) {
				c.mu.Unlock()
				return hit.value, hit.updatedAt, false, nil
			}
			if maxStale > 0 && hit.expiresAt.Add(maxStale).After(now) {
				// Return stale immediately and kick off one background refresh if none running
				if _, running := c.inflight[key]; !running {
					call := &inflightCall[T]{}
					call.wg.Add(1)
					c.inflight[key] = call
					go c.runLoader(key, call, loader)
				}
				c.mu.Unlock()
				return hit.value, hit.updatedAt, true, nil
			}
		}
		if call, ok := c.inflight[key]; ok {
			c.mu.Unlock()
			call.wg.Wait()
			return call.val, call.updatedAt, false, call.err
		}
	}

	call := &inflightCall[T]{}
	call.wg.Add(1)
	c.inflight[key] = call
	c.mu.Unlock()

	c.runLoader(key, call, loader)
	return call.val, call.updatedAt, false, call.err
}

func (c *TtlCache[T]) runLoader(key string, call *inflightCall[T], loader func() (T, error)) {
	val, err := loader()
	doneAt := time.Now()

	c.mu.Lock()
	if err == nil {
		c.store[key] = cacheEntry[T]{
			value:     val,
			updatedAt: doneAt,
			expiresAt: doneAt.Add(c.defaultTTL),
		}
	}
	if c.inflight[key] == call {
		delete(c.inflight, key)
	}
	c.mu.Unlock()

	call.val = val
	call.updatedAt = doneAt
	call.err = err
	call.wg.Done()
}

func (c *TtlCache[T]) Invalidate(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if key == "" {
		clear(c.store)
	} else {
		delete(c.store, key)
	}
}
