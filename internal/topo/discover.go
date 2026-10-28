// Package topo discovers the current Redis master, its replicas, and the
// Sentinels of a Liz Redis-Sentinel deployment. It is count-agnostic: the
// caller supplies a node list of any length and discovery enumerates whatever
// master/replicas/sentinels actually exist at runtime.
//
// The #1 correctness concern is that Sentinel and INFO report addresses by
// hostname (`server_1`), never IP, and those hostnames do not resolve off the
// servers. We solve this two ways that reinforce each other:
//   - an alias map rewrites any hostname to an IP at dial time (see
//     aliases.go): names each node says it announces itself as (learned), the
//     positional server_N -> nodes[N-1] guess, and user overrides, and
//   - direct INFO-replication probing of the supplied node IPs classifies
//     master/replica by role without depending on hostname resolution at all.
package topo

import (
	"context"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

type Role string

const (
	RoleMaster  Role = "master"
	RoleReplica Role = "replica"
	RoleUnknown Role = "unknown"
)

// Config is derived from a profile.Profile.
type Config struct {
	Nodes            []string
	RedisPort        int
	SentinelPort     int
	MasterName       string
	Password         string
	SentinelPassword string
	Aliases          map[string]string
	Timeout          time.Duration // per-operation dial/command timeout
}

func (c Config) withDefaults() Config {
	if c.RedisPort == 0 {
		c.RedisPort = 5000
	}
	if c.SentinelPort == 0 {
		c.SentinelPort = 26379
	}
	if c.MasterName == "" {
		c.MasterName = "mymaster"
	}
	if c.Timeout == 0 {
		c.Timeout = 2 * time.Second
	}
	return c
}

// RedisNode is a discovered redis-server instance (master or replica).
type RedisNode struct {
	Addr        string `json:"addr"`        // resolved IP:port used for dialing
	AnnouncedAs string `json:"announcedAs"` // hostname as Sentinel/INFO reported it (e.g. server_2)
	Role        Role   `json:"role"`
	Up          bool   `json:"up"`
	OffsetBytes int64  `json:"offsetBytes"`
	LagSeconds  int64  `json:"lagSeconds"` // replicas only, from master INFO
	LinkOK      bool   `json:"linkOk"`     // replicas only: master link status
	Detail      string `json:"detail,omitempty"`
}

// SentinelNode is a sentinel instance we know about.
type SentinelNode struct {
	Addr string `json:"addr"`
	Up   bool   `json:"up"`
}

// Topology is the full picture handed to the UI.
type Topology struct {
	MasterName   string         `json:"masterName"`
	Master       *RedisNode     `json:"master"`
	Replicas     []RedisNode    `json:"replicas"`
	Sentinels    []SentinelNode `json:"sentinels"`
	Quorum       int            `json:"quorum"`
	Source       string         `json:"source"` // "sentinel" | "direct-probe" | "sentinel+probe"
	Warnings     []string       `json:"warnings,omitempty"`
	DiscoveredAt int64          `json:"discoveredAt"` // unix ms
}

// MasterAddr is a convenience for callers that just need the write endpoint.
func (t Topology) MasterAddr() string {
	if t.Master != nil {
		return t.Master.Addr
	}
	return ""
}

// ReplicaAddrs returns dialable addresses of replicas that report up.
func (t Topology) ReplicaAddrs() []string {
	var out []string
	for _, r := range t.Replicas {
		if r.Up && r.Addr != "" {
			out = append(out, r.Addr)
		}
	}
	return out
}

// Discover runs the full discovery flow and always returns a Topology (never
// nil); on total failure Master is nil and Warnings explains why.
func Discover(ctx context.Context, cfg Config) Topology {
	cfg = cfg.withDefaults()
	aliases := MergedAliases(cfg.Nodes, learnAnnounced(ctx, cfg), cfg.Aliases)
	t := Topology{MasterName: cfg.MasterName, DiscoveredAt: time.Now().UnixMilli()}

	// --- 1. Sentinel pass: ping each node's sentinel, and from the first
	// reachable one pull master addr, quorum, and the sentinel roster. ---
	sentinelSeen := map[string]bool{}
	var sentinelMaster string // rewritten to IP
	discovered := false
	for _, node := range cfg.Nodes {
		saddr := net.JoinHostPort(node, strconv.Itoa(cfg.SentinelPort))
		if sentinelSeen[saddr] {
			continue
		}
		sentinelSeen[saddr] = true
		up := ping(ctx, saddr, cfg.SentinelPassword, cfg.Timeout)
		t.Sentinels = append(t.Sentinels, SentinelNode{Addr: saddr, Up: up})
		if up && !discovered {
			if m, q, others, ok := sentinelDiscover(ctx, saddr, cfg, aliases); ok {
				sentinelMaster = m
				t.Quorum = q
				discovered = true
				// merge sentinel-reported peers (may live on hosts not in Nodes)
				for _, o := range others {
					if !sentinelSeen[o] {
						sentinelSeen[o] = true
						_, unresolved := unresolvedHost(o) // a bare name can't be dialed from here
						t.Sentinels = append(t.Sentinels, SentinelNode{
							Addr: o, Up: !unresolved && ping(ctx, o, cfg.SentinelPassword, cfg.Timeout),
						})
					}
				}
			}
		}
	}

	// --- 2. Direct probe: INFO replication on every node:redisPort. This is
	// the authoritative, hostname-free source for who is master. ---
	probeMaster, probeReplicas, probeWarn := probeAll(ctx, cfg, aliases)
	t.Warnings = append(t.Warnings, probeWarn...)

	// --- 3. Reconcile. Prefer a probe-confirmed master; fall back to the
	// sentinel-reported master (verified via INFO). ---
	switch {
	case probeMaster != nil:
		t.Master = probeMaster
		t.Replicas = probeReplicas
		if sentinelMaster != "" && sameHostPort(sentinelMaster, probeMaster.Addr) {
			t.Source = "sentinel+probe"
		} else if discovered {
			t.Source = "sentinel+probe"
			if sentinelMaster != "" && !sameHostPort(sentinelMaster, probeMaster.Addr) {
				t.Warnings = append(t.Warnings,
					"sentinel reports master "+sentinelMaster+" but INFO says master is "+probeMaster.Addr+" (failover in progress?)")
			}
		} else {
			t.Source = "direct-probe"
		}
	case sentinelMaster != "":
		// No node in the list self-reports as master; trust sentinel and verify.
		if node, reps, ok := verifyMaster(ctx, sentinelMaster, cfg, aliases); ok {
			t.Master = node
			t.Replicas = reps
			t.Source = "sentinel"
		} else {
			if host, ok := unresolvedHost(sentinelMaster); ok {
				t.Warnings = append(t.Warnings, fmt.Sprintf(
					"Sentinel 이 마스터를 %q 라는 이름으로 알려 줬는데 IP 를 몰라 확인하지 못했습니다 — 노드 목록에 그 서버 IP 를 넣거나 별칭에 %s=<IP> 를 넣으세요",
					host, host))
			} else {
				t.Warnings = append(t.Warnings, "sentinel master "+sentinelMaster+" did not verify as role:master")
			}
		}
	default:
		t.Warnings = append(t.Warnings, "no master found: no reachable sentinel and no node reports role:master")
	}

	t.Warnings = append(t.Warnings, unresolvedWarnings(t)...)
	return t
}

// unresolvedWarnings lists names that are still not IPs after alias rewriting.
// Those entries cannot be dialed from this PC, so they show as separate (and
// usually down) nodes — the user needs to know why and how to fix it.
func unresolvedWarnings(t Topology) []string {
	var addrs []string
	if t.Master != nil {
		addrs = append(addrs, t.Master.Addr)
	}
	for _, r := range t.Replicas {
		addrs = append(addrs, r.Addr)
	}
	for _, s := range t.Sentinels {
		addrs = append(addrs, s.Addr)
	}
	seen := map[string]bool{}
	var names []string
	for _, a := range addrs {
		if host, ok := unresolvedHost(a); ok && !seen[host] {
			seen[host] = true
			names = append(names, host)
		}
	}
	if len(names) == 0 {
		return nil
	}
	return []string{fmt.Sprintf(
		"이름 %s 을(를) IP 로 바꾸지 못해 별도 노드로 표시됩니다 — 프로필 별칭에 이름=IP 를 넣으세요",
		strings.Join(names, ", "))}
}

// learnAnnounced asks every node which name it announces itself under — redis
// `replica-announce-ip` and sentinel `announce-ip` — and maps that name to the
// node's IP. Liz installs announce names like `server01` that the positional
// server_N guess does not cover, and asking the node does not depend on the
// order of the profile's node list. Nodes that are down or refuse CONFIG are
// simply skipped.
func learnAnnounced(ctx context.Context, cfg Config) map[string]string {
	type hit struct{ name, ip string }
	hits := make(chan hit, 2*len(cfg.Nodes))
	var wg sync.WaitGroup
	ask := func(node, addr, password string, args ...interface{}) {
		defer wg.Done()
		cli := newClient(addr, password)
		defer cli.Close()
		res, err := do(ctx, cli, cfg.Timeout, args...)
		if err != nil {
			return
		}
		if kv := toStrings(res); len(kv) == 2 && kv[1] != "" && net.ParseIP(kv[1]) == nil {
			hits <- hit{name: kv[1], ip: node}
		}
	}
	for _, node := range cfg.Nodes {
		wg.Add(2)
		go ask(node, net.JoinHostPort(node, strconv.Itoa(cfg.RedisPort)), cfg.Password,
			"CONFIG", "GET", "replica-announce-ip")
		go ask(node, net.JoinHostPort(node, strconv.Itoa(cfg.SentinelPort)), cfg.SentinelPassword,
			"SENTINEL", "CONFIG", "GET", "announce-ip")
	}
	wg.Wait()
	close(hits)
	m := map[string]string{}
	for h := range hits {
		m[h.name] = h.ip
	}
	return m
}

// sentinelDiscover queries one reachable sentinel for the master address,
// quorum, and the addresses of the other sentinels. Returned master addr is
// already rewritten to an IP.
func sentinelDiscover(ctx context.Context, saddr string, cfg Config, aliases map[string]string) (master string, quorum int, others []string, ok bool) {
	cli := newClient(saddr, cfg.SentinelPassword)
	defer cli.Close()

	res, err := do(ctx, cli, cfg.Timeout, "SENTINEL", "get-master-addr-by-name", cfg.MasterName)
	if err != nil {
		return "", 0, nil, false
	}
	pair := toStrings(res)
	if len(pair) == 2 {
		master = rewriteHost(net.JoinHostPort(pair[0], pair[1]), aliases)
		ok = true
	}

	// quorum from SENTINEL master <name>
	if mres, err := do(ctx, cli, cfg.Timeout, "SENTINEL", "master", cfg.MasterName); err == nil {
		if q, e := strconv.Atoi(kvMap(mres)["quorum"]); e == nil {
			quorum = q
		}
	}

	// other sentinels
	if sres, err := do(ctx, cli, cfg.Timeout, "SENTINEL", "sentinels", cfg.MasterName); err == nil {
		for _, m := range toMapList(sres) {
			if ip, port := m["ip"], m["port"]; ip != "" && port != "" {
				others = append(others, rewriteHost(net.JoinHostPort(ip, port), aliases))
			}
		}
	}
	return master, quorum, others, ok
}

// probeAll runs INFO replication against every node:redisPort and classifies
// master/replicas. The master's INFO gives authoritative replica offset/lag.
func probeAll(ctx context.Context, cfg Config, aliases map[string]string) (master *RedisNode, replicas []RedisNode, warnings []string) {
	type nodeInfo struct {
		addr string
		info replInfo
		up   bool
	}
	var infos []nodeInfo
	for _, node := range cfg.Nodes {
		addr := net.JoinHostPort(node, strconv.Itoa(cfg.RedisPort))
		info, up, err := infoReplication(ctx, addr, cfg.Password, cfg.Timeout)
		if err != nil && !up {
			// unreachable / refused: note but keep going
			warnings = append(warnings, "redis "+addr+": "+shortErr(err))
		}
		infos = append(infos, nodeInfo{addr: addr, info: info, up: up})
	}

	for _, ni := range infos {
		if ni.up && ni.info.role == "master" {
			master = &RedisNode{Addr: ni.addr, Role: RoleMaster, Up: true, OffsetBytes: ni.info.masterReplOffset}
			// replicas from the master's slaveN lines (authoritative lag/offset)
			for _, s := range ni.info.slaves {
				addr := rewriteHost(net.JoinHostPort(s.ip, s.port), aliases)
				replicas = append(replicas, RedisNode{
					Addr:        addr,
					AnnouncedAs: s.ip,
					Role:        RoleReplica,
					Up:          s.state == "online",
					OffsetBytes: s.offset,
					LagSeconds:  s.lag,
					LinkOK:      s.state == "online",
				})
			}
			break
		}
	}
	if master == nil {
		return nil, nil, warnings
	}
	// If a node self-reports replica but wasn't in the master's slave list
	// (e.g. announce mismatch), surface it too.
	known := map[string]bool{}
	for _, r := range replicas {
		known[hostPortKey(r.Addr)] = true
	}
	for _, ni := range infos {
		if ni.up && ni.info.role == "slave" && !known[hostPortKey(ni.addr)] {
			replicas = append(replicas, RedisNode{
				Addr: ni.addr, Role: RoleReplica, Up: true,
				LinkOK: ni.info.masterLinkUp, Detail: "self-reported replica",
			})
		}
	}
	return master, replicas, warnings
}

// verifyMaster connects to a sentinel-reported master addr and confirms
// role:master via INFO, returning the node + its replicas.
func verifyMaster(ctx context.Context, addr string, cfg Config, aliases map[string]string) (*RedisNode, []RedisNode, bool) {
	if _, unresolved := unresolvedHost(addr); unresolved {
		return nil, nil, false // would only wait out a DNS/dial timeout
	}
	info, up, err := infoReplication(ctx, addr, cfg.Password, cfg.Timeout)
	if err != nil || !up || info.role != "master" {
		return nil, nil, false
	}
	master := &RedisNode{Addr: addr, Role: RoleMaster, Up: true, OffsetBytes: info.masterReplOffset}
	var replicas []RedisNode
	for _, s := range info.slaves {
		replicas = append(replicas, RedisNode{
			Addr:        rewriteHost(net.JoinHostPort(s.ip, s.port), aliases),
			AnnouncedAs: s.ip,
			Role:        RoleReplica,
			Up:          s.state == "online",
			OffsetBytes: s.offset,
			LagSeconds:  s.lag,
			LinkOK:      s.state == "online",
		})
	}
	return master, replicas, true
}

// ---- INFO replication parsing ----

type slaveInfo struct {
	ip     string
	port   string
	state  string
	offset int64
	lag    int64
}

type replInfo struct {
	role             string
	masterReplOffset int64
	masterLinkUp     bool
	slaves           []slaveInfo
}

// newClient builds a RESP2 client. RESP2 keeps SENTINEL/HGETALL replies as flat
// arrays (RESP3 turns several of them into maps), which is what our parsers and
// the ordered device-hash reader expect.
func newClient(addr, password string) *redis.Client {
	return redis.NewClient(&redis.Options{Addr: addr, Password: password, Protocol: 2})
}

func infoReplication(ctx context.Context, addr, password string, timeout time.Duration) (replInfo, bool, error) {
	cli := newClient(addr, password)
	defer cli.Close()
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	s, err := cli.Info(cctx, "replication").Result()
	if err != nil {
		return replInfo{}, false, err
	}
	return parseReplInfo(s), true, nil
}

func parseReplInfo(s string) replInfo {
	var ri replInfo
	for _, ln := range strings.Split(s, "\n") {
		ln = strings.TrimRight(ln, "\r")
		if ln == "" || strings.HasPrefix(ln, "#") {
			continue
		}
		key, val, ok := strings.Cut(ln, ":")
		if !ok {
			continue
		}
		switch {
		case key == "role":
			ri.role = val
		case key == "master_repl_offset":
			ri.masterReplOffset, _ = strconv.ParseInt(val, 10, 64)
		case key == "master_link_status":
			ri.masterLinkUp = val == "up"
		case strings.HasPrefix(key, "slave") && strings.Contains(val, "ip="):
			ri.slaves = append(ri.slaves, parseSlaveLine(val))
		}
	}
	return ri
}

// parseSlaveLine parses "ip=server_2,port=5000,state=online,offset=123,lag=1".
func parseSlaveLine(val string) slaveInfo {
	var si slaveInfo
	for _, kv := range strings.Split(val, ",") {
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			continue
		}
		switch k {
		case "ip":
			si.ip = v
		case "port":
			si.port = v
		case "state":
			si.state = v
		case "offset":
			si.offset, _ = strconv.ParseInt(v, 10, 64)
		case "lag":
			si.lag, _ = strconv.ParseInt(v, 10, 64)
		}
	}
	return si
}

// ---- small helpers ----

func ping(ctx context.Context, addr, password string, timeout time.Duration) bool {
	cli := newClient(addr, password)
	defer cli.Close()
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	return cli.Ping(cctx).Err() == nil
}

func do(ctx context.Context, cli *redis.Client, timeout time.Duration, args ...interface{}) (interface{}, error) {
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	return cli.Do(cctx, args...).Result()
}

// toStrings flattens a RESP array reply into a []string.
func toStrings(v interface{}) []string {
	arr, ok := v.([]interface{})
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, e := range arr {
		out = append(out, toString(e))
	}
	return out
}

// kvMap turns a flat [k,v,k,v,...] reply into a map.
func kvMap(v interface{}) map[string]string {
	fields := toStrings(v)
	m := make(map[string]string, len(fields)/2)
	for i := 0; i+1 < len(fields); i += 2 {
		m[fields[i]] = fields[i+1]
	}
	return m
}

// toMapList turns a reply of [[k,v,...],[k,v,...]] into []map.
func toMapList(v interface{}) []map[string]string {
	arr, ok := v.([]interface{})
	if !ok {
		return nil
	}
	out := make([]map[string]string, 0, len(arr))
	for _, e := range arr {
		out = append(out, kvMap(e))
	}
	return out
}

func toString(e interface{}) string {
	switch x := e.(type) {
	case string:
		return x
	case []byte:
		return string(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case nil:
		return ""
	default:
		return fmt.Sprintf("%v", x)
	}
}

func hostPortKey(addr string) string {
	h, p, err := net.SplitHostPort(addr)
	if err != nil {
		return addr
	}
	return h + ":" + p
}

func sameHostPort(a, b string) bool { return hostPortKey(a) == hostPortKey(b) }

func shortErr(err error) string {
	if err == nil {
		return ""
	}
	s := err.Error()
	if len(s) > 120 {
		return s[:120]
	}
	return s
}
