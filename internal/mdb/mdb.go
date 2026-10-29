// Package mdb owns per-profile MariaDB connections. For now it only connects
// and reports what it reached (server, version, Galera state); query features
// build on Manager.DB later.
//
// A profile lists one or more server IPs; Connect tries them in order and keeps
// the first that answers, so a dead node (or the VIP during failover) doesn't
// block the connection.
package mdb

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-sql-driver/mysql"

	"redis-client/internal/profile"
)

// Galera is the cluster state of the node we connected to. Nil when the server
// isn't a Galera node.
type Galera struct {
	ClusterName   string `json:"clusterName"`
	ClusterSize   int    `json:"clusterSize"`
	ClusterStatus string `json:"clusterStatus"` // Primary | non-Primary | Disconnected
	LocalState    string `json:"localState"`    // Synced | Donor/Desynced | Joining ...
	Ready         bool   `json:"ready"`
	NodeName      string `json:"nodeName"`
}

// Info describes the live connection, shown in the banner and the DB panel.
type Info struct {
	Addr        string   `json:"addr"` // host:port actually connected
	Version     string   `json:"version"`
	Hostname    string   `json:"hostname"` // @@hostname of the server
	User        string   `json:"user"`     // CURRENT_USER(), i.e. the matched account
	Database    string   `json:"database"`
	ReadOnly    bool     `json:"readOnly"`       // session locked read-only by the profile
	ServerRO    bool     `json:"serverReadOnly"` // @@read_only on the server itself
	Galera      *Galera  `json:"galera,omitempty"`
	Skipped     []string `json:"skipped,omitempty"` // "addr: error" for nodes tried before Addr
	ConnectedAt int64    `json:"connectedAt"`       // unix ms
}

const (
	dialTimeout = 3 * time.Second
	pingTimeout = 5 * time.Second
)

type conn struct {
	db   *sql.DB
	info Info
}

// Manager owns all live MariaDB connections keyed by profile ID.
type Manager struct {
	mu    sync.Mutex
	conns map[string]*conn
}

func NewManager() *Manager { return &Manager{conns: map[string]*conn{}} }

func dsn(p profile.Profile, addr string) string {
	c := mysql.NewConfig()
	c.User = p.DBUser
	c.Passwd = p.Password
	c.Net = "tcp"
	c.Addr = addr
	c.DBName = p.Database
	c.Timeout = dialTimeout
	c.ReadTimeout = 30 * time.Second
	c.WriteTimeout = 30 * time.Second
	c.AllowNativePasswords = true
	if p.ReadOnly {
		// every pooled connection starts read-only, so a later feature can't
		// write by accident while the profile's safety switch is on
		c.Params = map[string]string{"tx_read_only": "1"}
	}
	return c.FormatDSN()
}

// Connect opens (or reopens) the profile's connection, trying each node in
// order until one answers.
func (m *Manager) Connect(ctx context.Context, p profile.Profile) (Info, error) {
	p = p.WithDefaults()
	m.Disconnect(p.ID)
	if len(p.Nodes) == 0 {
		return Info{}, errors.New("서버 IP 가 없습니다")
	}
	var skipped []string
	for _, node := range p.Nodes {
		addr := net.JoinHostPort(node, strconv.Itoa(p.DBPort))
		db, err := sql.Open("mysql", dsn(p, addr))
		if err == nil {
			pctx, cancel := context.WithTimeout(ctx, pingTimeout)
			err = db.PingContext(pctx)
			cancel()
		}
		if err != nil {
			if db != nil {
				_ = db.Close()
			}
			skipped = append(skipped, addr+": "+err.Error())
			continue
		}
		db.SetMaxOpenConns(4)
		db.SetMaxIdleConns(2)
		db.SetConnMaxLifetime(5 * time.Minute)
		info, err := describe(ctx, db)
		if err != nil {
			_ = db.Close()
			skipped = append(skipped, addr+": "+err.Error())
			continue
		}
		info.Addr = addr
		info.ReadOnly = p.ReadOnly
		info.Skipped = skipped
		info.ConnectedAt = time.Now().UnixMilli()
		m.mu.Lock()
		m.conns[p.ID] = &conn{db: db, info: info}
		m.mu.Unlock()
		return info, nil
	}
	return Info{}, errors.New(strings.Join(skipped, "\n"))
}

// describe reads what the banner shows about the server we reached.
func describe(ctx context.Context, db *sql.DB) (Info, error) {
	qctx, cancel := context.WithTimeout(ctx, pingTimeout)
	defer cancel()
	var info Info
	var dbName sql.NullString
	var ro int
	err := db.QueryRowContext(qctx, "SELECT VERSION(), @@hostname, CURRENT_USER(), DATABASE(), @@read_only").
		Scan(&info.Version, &info.Hostname, &info.User, &dbName, &ro)
	if err != nil {
		return info, err
	}
	info.Database = dbName.String
	info.ServerRO = ro != 0

	// Galera status; a plain server simply has no wsrep_* rows
	rows, err := db.QueryContext(qctx, "SHOW GLOBAL STATUS WHERE Variable_name IN "+
		"('wsrep_cluster_size','wsrep_cluster_status','wsrep_local_state_comment','wsrep_ready')")
	if err != nil {
		return info, nil
	}
	defer rows.Close()
	st := map[string]string{}
	for rows.Next() {
		var k, v string
		if rows.Scan(&k, &v) == nil {
			st[strings.ToLower(k)] = v
		}
	}
	if len(st) == 0 || st["wsrep_cluster_size"] == "" || st["wsrep_cluster_size"] == "0" {
		return info, nil
	}
	g := &Galera{
		ClusterStatus: st["wsrep_cluster_status"],
		LocalState:    st["wsrep_local_state_comment"],
		Ready:         strings.EqualFold(st["wsrep_ready"], "ON"),
	}
	g.ClusterSize, _ = strconv.Atoi(st["wsrep_cluster_size"])
	var name, node sql.NullString
	if db.QueryRowContext(qctx, "SELECT @@wsrep_cluster_name, @@wsrep_node_name").Scan(&name, &node) == nil {
		g.ClusterName, g.NodeName = name.String, node.String
	}
	info.Galera = g
	return info, nil
}

// Disconnect closes the profile's connection if any.
func (m *Manager) Disconnect(id string) {
	m.mu.Lock()
	c := m.conns[id]
	delete(m.conns, id)
	m.mu.Unlock()
	if c != nil {
		_ = c.db.Close()
	}
}

func (m *Manager) IsConnected(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.conns[id] != nil
}

// Info returns the snapshot taken at connect time.
func (m *Manager) Info(id string) (Info, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c := m.conns[id]
	if c == nil {
		return Info{}, fmt.Errorf("연결되어 있지 않습니다")
	}
	return c.info, nil
}

// DB is the pool for query features built on top of the connection.
func (m *Manager) DB(id string) (*sql.DB, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c := m.conns[id]
	if c == nil {
		return nil, fmt.Errorf("연결되어 있지 않습니다")
	}
	return c.db, nil
}

func (m *Manager) CloseAll() {
	m.mu.Lock()
	all := m.conns
	m.conns = map[string]*conn{}
	m.mu.Unlock()
	for _, c := range all {
		_ = c.db.Close()
	}
}
