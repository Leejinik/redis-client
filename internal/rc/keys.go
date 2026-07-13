package rc

import (
	"context"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// KeyInfo is one row in the key browser.
type KeyInfo struct {
	Key  string `json:"key"`
	Type string `json:"type"`
}

// ScanResult is one page of a SCAN. Cursor==0 means iteration is complete.
type ScanResult struct {
	Cursor uint64    `json:"cursor"`
	Keys   []KeyInfo `json:"keys"`
}

// scanPageSize is the internal SCAN COUNT hint per round. SCAN applies MATCH
// *after* pulling this many keys from the hash buckets, so a specific key in a
// ~112k keyspace almost never lands in a single 300-key window — hence we loop.
const scanPageSize = 1000

// scanBudget caps how long one ScanKeys call spends accumulating matches before
// yielding a resume cursor to the caller (keeps us well under the ctx timeout).
const scanBudget = 6 * time.Second

// scanMaxRounds is a hard backstop against a runaway loop on a pathological
// keyspace (≈1M keys examined per call at scanPageSize).
const scanMaxRounds = 1000

// hasGlob reports whether s carries any redis glob metacharacter. A pattern
// without one is a literal key and can be resolved with a single TYPE.
func hasGlob(s string) bool { return strings.ContainsAny(s, `*?[]\`) }

// ScanKeys pages the keyspace with SCAN (never KEYS — the master holds ~112k
// keys) and pipelines a TYPE for each key so the UI can badge/route them.
//
// Two properties the naive one-SCAN-per-call version lacked:
//   - Exact key: a literal match (no glob) short-circuits to a single TYPE, so
//     looking up "device:6927" is O(1) instead of a full-keyspace scan.
//   - No empty pages mid-scan: for a glob it keeps running SCAN internally until
//     it has `count` matched keys, or the cursor wraps to 0 (iteration done), or
//     it runs out of time budget. So the caller never sees "0 keys but cursor!=0"
//     while matches still exist further in — which is what made a sparse pattern
//     look like a miss and stranded the infinite-scroll loader.
func (c *Conn) ScanKeys(ctx context.Context, cursor uint64, match string, count int64) (ScanResult, error) {
	cli, err := c.client()
	if err != nil {
		return ScanResult{}, err
	}
	if count <= 0 {
		count = 300
	}
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	// Exact-key fast path (only on a fresh scan — a continuation is mid-glob).
	if cursor == 0 && match != "" && !hasGlob(match) {
		t, err := cli.Type(cctx, match).Result()
		if err != nil {
			return ScanResult{}, err
		}
		if t == "" || t == "none" {
			return ScanResult{Cursor: 0, Keys: []KeyInfo{}}, nil
		}
		return ScanResult{Cursor: 0, Keys: []KeyInfo{{Key: match, Type: t}}}, nil
	}

	if match == "" {
		match = "*"
	}

	// Accumulate matches across as many SCAN rounds as needed.
	var keys []string
	next := cursor
	deadline := time.Now().Add(scanBudget)
	for round := 0; round < scanMaxRounds; round++ {
		var batch []string
		batch, next, err = cli.Scan(cctx, next, match, scanPageSize).Result()
		if err != nil {
			return ScanResult{}, err
		}
		keys = append(keys, batch...)
		if next == 0 { // iteration complete
			break
		}
		if int64(len(keys)) >= count { // enough for this page
			break
		}
		if time.Now().After(deadline) { // yield; caller resumes at `next`
			break
		}
	}

	infos := make([]KeyInfo, len(keys))
	if len(keys) > 0 {
		pipe := cli.Pipeline()
		cmds := make([]*redis.StatusCmd, len(keys))
		for i, k := range keys {
			cmds[i] = pipe.Type(cctx, k)
		}
		_, _ = pipe.Exec(cctx)
		for i, k := range keys {
			t, _ := cmds[i].Result()
			infos[i] = KeyInfo{Key: k, Type: t}
		}
	}
	return ScanResult{Cursor: next, Keys: infos}, nil
}

// KeyMeta is the detail header shown when a key is opened.
type KeyMeta struct {
	Key       string `json:"key"`
	Type      string `json:"type"`
	Exists    bool   `json:"exists"`
	TTLSecond int64  `json:"ttlSeconds"` // -1 no expire, -2 missing
	Encoding  string `json:"encoding"`
	SizeBytes int64  `json:"sizeBytes"` // MEMORY USAGE (0 if unavailable)
	Length    int64  `json:"length"`    // strlen/hlen/llen/scard/zcard
}

func (c *Conn) KeyMeta(ctx context.Context, key string) (KeyMeta, error) {
	cli, err := c.client()
	if err != nil {
		return KeyMeta{}, err
	}
	cctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()

	typ, err := cli.Type(cctx, key).Result()
	if err != nil {
		return KeyMeta{}, err
	}
	m := KeyMeta{Key: key, Type: typ, Exists: typ != "none"}
	if !m.Exists {
		m.TTLSecond = -2
		return m, nil
	}
	m.TTLSecond, _ = cli.Do(cctx, "TTL", key).Int64()
	m.Encoding, _ = cli.ObjectEncoding(cctx, key).Result()
	m.SizeBytes, _ = cli.Do(cctx, "MEMORY", "USAGE", key).Int64()
	switch typ {
	case "string":
		m.Length, _ = cli.StrLen(cctx, key).Result()
	case "hash":
		m.Length, _ = cli.HLen(cctx, key).Result()
	case "list":
		m.Length, _ = cli.LLen(cctx, key).Result()
	case "set":
		m.Length, _ = cli.SCard(cctx, key).Result()
	case "zset":
		m.Length, _ = cli.ZCard(cctx, key).Result()
	}
	return m, nil
}
