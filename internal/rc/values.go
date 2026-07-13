package rc

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	maxElems = 1000 // per-collection read cap (hash/list/set/zset)
	maxRange = 5000 // max keys per MGET range
)

// ValueResult is a type-aware read of a single key, with an optional Liz decode.
type ValueResult struct {
	Key       string   `json:"key"`
	Type      string   `json:"type"`
	Exists    bool     `json:"exists"`
	TTLSecond int64    `json:"ttlSeconds"`
	String    string   `json:"string,omitempty"`
	Hash      []KV     `json:"hash,omitempty"`
	List      []string `json:"list,omitempty"`
	Set       []string `json:"set,omitempty"`
	ZSet      []KV     `json:"zset,omitempty"`
	Truncated bool     `json:"truncated,omitempty"`
	Decoded   *Decoded `json:"decoded,omitempty"`
}

// ReadValue dispatches on the key's type and reads it with the correct command,
// capping large collections and attaching a Liz decode when applicable.
func (c *Conn) ReadValue(ctx context.Context, key string) (ValueResult, error) {
	cli, err := c.client()
	if err != nil {
		return ValueResult{}, err
	}
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	typ, err := cli.Type(cctx, key).Result()
	if err != nil {
		return ValueResult{}, err
	}
	res := ValueResult{Key: key, Type: typ, Exists: typ != "none"}
	if !res.Exists {
		res.TTLSecond = -2
		return res, nil
	}
	res.TTLSecond, _ = cli.Do(cctx, "TTL", key).Int64()

	switch typ {
	case "string":
		v, err := cli.Get(cctx, key).Result()
		if err != nil {
			return res, err
		}
		res.String = v
		res.Decoded = DecodeString(key, v)

	case "hash":
		kvs, trunc, err := readHash(cctx, cli, key)
		if err != nil {
			return res, err
		}
		res.Hash = kvs
		res.Truncated = trunc
		res.Decoded = DecodeHash(key, kvs)

	case "list":
		vals, err := cli.LRange(cctx, key, 0, maxElems-1).Result()
		if err != nil {
			return res, err
		}
		res.List = vals
		res.Truncated = int64(len(vals)) >= maxElems

	case "set":
		vals, err := cli.SRandMemberN(cctx, key, maxElems).Result()
		if err != nil {
			// fall back to SMEMBERS for older servers
			vals, err = cli.SMembers(cctx, key).Result()
			if err != nil {
				return res, err
			}
		}
		res.Set = vals
		res.Truncated = int64(len(vals)) >= maxElems

	case "zset":
		zs, err := cli.ZRangeWithScores(cctx, key, 0, maxElems-1).Result()
		if err != nil {
			return res, err
		}
		for _, z := range zs {
			res.ZSet = append(res.ZSet, KV{Field: fmt.Sprintf("%v", z.Member), Value: strconv.FormatFloat(z.Score, 'f', -1, 64)})
		}
		res.Truncated = int64(len(zs)) >= maxElems
	}
	return res, nil
}

// readHash returns hash fields in storage order (preserving device interface
// ordering) via raw HGETALL, capping very large hashes with HSCAN.
func readHash(ctx context.Context, cli *redis.Client, key string) ([]KV, bool, error) {
	hlen, _ := cli.HLen(ctx, key).Result()
	if hlen > maxElems {
		// large hash: sample the first maxElems fields with HSCAN
		var kvs []KV
		var cursor uint64
		for len(kvs) < maxElems {
			pairs, next, err := cli.HScan(ctx, key, cursor, "*", 200).Result()
			if err != nil {
				return kvs, true, err
			}
			for i := 0; i+1 < len(pairs); i += 2 {
				kvs = append(kvs, KV{Field: pairs[i], Value: pairs[i+1]})
			}
			cursor = next
			if cursor == 0 {
				break
			}
		}
		return kvs, int64(len(kvs)) < hlen, nil
	}
	// small hash: HGETALL via raw Do to keep insertion order
	raw, err := cli.Do(ctx, "HGETALL", key).Slice()
	if err != nil {
		return nil, false, err
	}
	kvs := make([]KV, 0, len(raw)/2)
	for i := 0; i+1 < len(raw); i += 2 {
		kvs = append(kvs, KV{Field: fmt.Sprintf("%v", raw[i]), Value: fmt.Sprintf("%v", raw[i+1])})
	}
	return kvs, false, nil
}

// RangeItem is one entry of an MGET range/selection read.
type RangeItem struct {
	Key     string   `json:"key"`
	Exists  bool     `json:"exists"`
	Value   string   `json:"value"`
	Decoded *Decoded `json:"decoded,omitempty"`
}

// MGetRange reads `<prefix><from>` .. `<prefix><to>` in one MGET (e.g.
// checkpoint: 76160..76180). This is the "id X부터 Y까지 한번에 get".
func (c *Conn) MGetRange(ctx context.Context, prefix string, from, to int64) ([]RangeItem, error) {
	if to < from {
		from, to = to, from
	}
	if to-from+1 > maxRange {
		return nil, fmt.Errorf("range too large: %d keys (max %d)", to-from+1, maxRange)
	}
	keys := make([]string, 0, to-from+1)
	for i := from; i <= to; i++ {
		keys = append(keys, prefix+strconv.FormatInt(i, 10))
	}
	return c.MGet(ctx, keys)
}

// MGet reads an arbitrary set of keys in one MGET, decoding each value when it
// matches a Liz checkpoint schema.
func (c *Conn) MGet(ctx context.Context, keys []string) ([]RangeItem, error) {
	cli, err := c.client()
	if err != nil {
		return nil, err
	}
	if len(keys) == 0 {
		return []RangeItem{}, nil
	}
	if len(keys) > maxRange {
		return nil, fmt.Errorf("too many keys: %d (max %d)", len(keys), maxRange)
	}
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	vals, err := cli.MGet(cctx, keys...).Result()
	if err != nil {
		return nil, err
	}
	out := make([]RangeItem, len(keys))
	for i, k := range keys {
		item := RangeItem{Key: k}
		if i < len(vals) && vals[i] != nil {
			item.Exists = true
			item.Value = fmt.Sprintf("%v", vals[i])
			item.Decoded = DecodeString(k, item.Value)
		}
		out[i] = item
	}
	return out, nil
}
