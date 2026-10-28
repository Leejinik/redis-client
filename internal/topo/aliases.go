package topo

import (
	"fmt"
	"net"
)

// PositionalAliases maps server_N hostnames to the IP at index N-1.
// The convention `server_1`, `server_2`, ... is used across the Liz stack
// (Redis Sentinel master replies, INFO replication, etc.). Returning an
// in-memory map lets us rewrite hostnames on the fly without touching the
// operator's /etc/hosts. (Lifted from infra-diag.)
func PositionalAliases(nodes []string) map[string]string {
	m := make(map[string]string, len(nodes))
	for i, ip := range nodes {
		m[fmt.Sprintf("server_%d", i+1)] = ip
	}
	return m
}

// MergedAliases layers the alias sources: positional (server_N guess) <
// learned (what each node says it announces itself as) < user-supplied.
func MergedAliases(nodes []string, learned, user map[string]string) map[string]string {
	m := PositionalAliases(nodes)
	for _, src := range []map[string]string{learned, user} {
		for k, v := range src {
			if k != "" && v != "" {
				m[k] = v
			}
		}
	}
	return m
}

// unresolvedHost returns the host part of addr when it is still a name (not an
// IP) after alias rewriting, i.e. something the client PC cannot dial.
func unresolvedHost(addr string) (string, bool) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}
	if host == "" || net.ParseIP(host) != nil {
		return "", false
	}
	return host, true
}

// rewriteHost rewrites the host part of an "host:port" address through the
// alias map, so a Sentinel reply like `server_3:5000` becomes `172.17.64.26:5000`.
// (Lifted from infra-diag.)
func rewriteHost(addr string, aliases map[string]string) string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return addr
	}
	if ip, ok := aliases[host]; ok {
		return net.JoinHostPort(ip, port)
	}
	return addr
}
