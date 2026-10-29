// Package rc is the Redis data-access layer: it owns per-profile connections,
// follows failover (the master client is rebuilt whenever discovery reports a
// new master), and exposes type-aware read/guarded-write operations to app.go.
//
// Addressing is fully hostname-free: topo.Discover resolves the master to an IP
// (via positional aliases) before we ever dial, so go-redis only ever sees IPs.
// Reads and writes both go to the master by default — this keeps SCAN cursors
// stable and gives read-your-writes; the discovered replicas are surfaced for
// the topology view.
package rc

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"redis-client/internal/profile"
	"redis-client/internal/topo"
)

// Emitter forwards backend events to the Wails frontend.
type Emitter func(event string, data interface{})

const watchInterval = 3 * time.Second

// Conn is a live connection to one profile's Redis Sentinel cluster.
type Conn struct {
	mu         sync.RWMutex
	profile    profile.Profile
	cfg        topo.Config
	topo       topo.Topology
	master     *redis.Client
	masterAddr string
	cancel     context.CancelFunc
}

func newRedisClient(addr, password string) *redis.Client {
	return redis.NewClient(&redis.Options{
		Addr:         addr,
		Password:     password,
		Protocol:     2, // RESP2: HGETALL stays an ordered flat array (device interface order)
		DialTimeout:  3 * time.Second,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 5 * time.Second,
		PoolSize:     4,
	})
}

// applyTopology swaps in a new master client only when the master address
// actually changed, so steady-state polling doesn't churn connection pools.
func (c *Conn) applyTopology(t topo.Topology) {
	c.mu.Lock()
	defer c.mu.Unlock()
	addr := t.MasterAddr()
	if addr != c.masterAddr {
		if c.master != nil {
			_ = c.master.Close()
			c.master = nil
		}
		if addr != "" {
			c.master = newRedisClient(addr, c.cfg.Password)
		}
		c.masterAddr = addr
	}
	c.topo = t
}

func (c *Conn) client() (*redis.Client, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.master == nil {
		return nil, fmt.Errorf("no master available (topology unresolved)")
	}
	return c.master, nil
}

// Topology returns the last discovered topology snapshot.
func (c *Conn) Topology() topo.Topology {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.topo
}

// ReadOnly reports whether writes are disabled for this connection.
func (c *Conn) ReadOnly() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.profile.ReadOnly
}

func (c *Conn) close() {
	if c.cancel != nil {
		c.cancel()
	}
	c.mu.Lock()
	if c.master != nil {
		_ = c.master.Close()
		c.master = nil
	}
	c.mu.Unlock()
}

// Manager owns all live connections keyed by profile ID.
type Manager struct {
	mu    sync.Mutex
	conns map[string]*Conn
	emit  Emitter
}

func NewManager(emit Emitter) *Manager {
	if emit == nil {
		emit = func(string, interface{}) {}
	}
	return &Manager{conns: map[string]*Conn{}, emit: emit}
}

func configFromProfile(p profile.Profile) topo.Config {
	p = p.WithDefaults()
	return topo.Config{
		Nodes:            p.Nodes,
		RedisPort:        p.RedisPort,
		SentinelPort:     p.SentinelPort,
		MasterName:       p.MasterName,
		Password:         p.Password,
		SentinelPassword: p.SentinelPassword,
		Aliases:          p.Aliases,
		Timeout:          2 * time.Second,
	}
}

// Connect performs an initial discovery (so failure is reported synchronously),
// then starts a background watcher that follows failover and streams topology
// updates to the frontend.
func (m *Manager) Connect(ctx context.Context, p profile.Profile) (topo.Topology, error) {
	p = p.WithDefaults()
	cfg := configFromProfile(p)

	t := topo.Discover(ctx, cfg)
	if t.Master == nil {
		msg := "마스터를 찾지 못했습니다"
		if len(t.Warnings) > 0 {
			msg = strings.Join(t.Warnings, "; ")
		}
		return t, fmt.Errorf("connect failed: %s", msg)
	}

	wctx, cancel := context.WithCancel(context.Background())
	conn := &Conn{profile: p, cfg: cfg, cancel: cancel}
	conn.applyTopology(t)

	m.mu.Lock()
	if old := m.conns[p.ID]; old != nil {
		old.close()
	}
	m.conns[p.ID] = conn
	m.mu.Unlock()

	m.emit("topology", topoEvent(p.ID, t))

	go topo.Watch(wctx, cfg, watchInterval, func(nt topo.Topology) {
		conn.applyTopology(nt)
		m.emit("topology", topoEvent(p.ID, nt))
	})

	return t, nil
}

// Disconnect stops the watcher and closes the connection for a profile.
func (m *Manager) Disconnect(id string) {
	m.mu.Lock()
	conn := m.conns[id]
	delete(m.conns, id)
	m.mu.Unlock()
	if conn != nil {
		conn.close()
	}
}

// CloseAll is called on app shutdown.
func (m *Manager) CloseAll() {
	m.mu.Lock()
	conns := make([]*Conn, 0, len(m.conns))
	for _, c := range m.conns {
		conns = append(conns, c)
	}
	m.conns = map[string]*Conn{}
	m.mu.Unlock()
	for _, c := range conns {
		c.close()
	}
}

// Conn returns the live connection for a profile, or an error if not connected.
func (m *Manager) Conn(id string) (*Conn, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c := m.conns[id]
	if c == nil {
		return nil, fmt.Errorf("not connected (profile %s)", id)
	}
	return c, nil
}

// IsConnected reports whether a profile currently has a live connection.
func (m *Manager) IsConnected(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.conns[id] != nil
}

func topoEvent(id string, t topo.Topology) map[string]interface{} {
	return map[string]interface{}{"profileId": id, "topology": t}
}
