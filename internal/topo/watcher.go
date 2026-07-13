package topo

import (
	"context"
	"time"
)

// Watch runs Discover immediately and then every `interval` until ctx is
// cancelled, delivering each Topology to onUpdate. Polling (rather than only
// Sentinel pub/sub) keeps failover detection robust even if a sentinel drops:
// every tick re-resolves the master from scratch, so a +switch-master is picked
// up within one interval and the UI/clients follow.
func Watch(ctx context.Context, cfg Config, interval time.Duration, onUpdate func(Topology)) {
	if interval <= 0 {
		interval = 3 * time.Second
	}
	onUpdate(Discover(ctx, cfg))
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			onUpdate(Discover(ctx, cfg))
		}
	}
}
