package main

import (
	"sync"
	"time"
)

type cacheEntry[T any] struct {
	value     T
	expiresAt time.Time
}

type inflightCall[T any] struct {
	wg  sync.WaitGroup
	val T
	err error
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
	now := time.Now()
	c.mu.Lock()
	if !fresh {
		if hit, ok := c.store[key]; ok && hit.expiresAt.After(now) {
			c.mu.Unlock()
			return hit.value, nil
		}
		if call, ok := c.inflight[key]; ok {
			c.mu.Unlock()
			call.wg.Wait()
			return call.val, call.err
		}
	}

	call := &inflightCall[T]{}
	call.wg.Add(1)
	c.inflight[key] = call
	c.mu.Unlock()

	val, err := loader()

	c.mu.Lock()
	if err == nil {
		c.store[key] = cacheEntry[T]{
			value:     val,
			expiresAt: time.Now().Add(c.defaultTTL),
		}
	}
	if c.inflight[key] == call {
		delete(c.inflight, key)
	}
	c.mu.Unlock()

	call.val = val
	call.err = err
	call.wg.Done()
	return val, err
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
