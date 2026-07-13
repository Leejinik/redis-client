package rc

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"
)

// WriteOp is a single guarded mutation. Op is one of: set, hset, mset, del,
// expire. Fields carries field->value (hset) or key->value (mset).
type WriteOp struct {
	Op         string            `json:"op"`
	Key        string            `json:"key"`
	Value      string            `json:"value"`
	Fields     map[string]string `json:"fields"`
	TTLSeconds int64             `json:"ttlSeconds"`
}

// WriteResult is the per-op outcome returned to the UI.
type WriteResult struct {
	Op     string `json:"op"`
	Key    string `json:"key"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail,omitempty"`
	Err    string `json:"err,omitempty"`
}

// Write applies a batch of mutations to the master. It refuses when the
// connection is in read-only mode, and only allows an explicit allow-list of
// ops (no FLUSHALL/FLUSHDB/KEYS/etc.). Each op is applied independently so one
// failure doesn't abort the rest; the caller shows a confirmation dialog first.
func (c *Conn) Write(ctx context.Context, ops []WriteOp) ([]WriteResult, error) {
	if c.ReadOnly() {
		return nil, fmt.Errorf("connection is read-only; turn off read-only mode to write")
	}
	cli, err := c.client()
	if err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()

	results := make([]WriteResult, 0, len(ops))
	for _, op := range ops {
		r := WriteResult{Op: op.Op, Key: op.Key}
		switch strings.ToLower(strings.TrimSpace(op.Op)) {
		case "set":
			if op.Key == "" {
				r.Err = "key required"
				break
			}
			var ttl time.Duration
			if op.TTLSeconds > 0 {
				ttl = time.Duration(op.TTLSeconds) * time.Second
			}
			if err := cli.Set(cctx, op.Key, op.Value, ttl).Err(); err != nil {
				r.Err = err.Error()
			} else {
				r.OK = true
				r.Detail = "SET " + op.Key
			}

		case "hset":
			if op.Key == "" || len(op.Fields) == 0 {
				r.Err = "key and at least one field required"
				break
			}
			args := make([]interface{}, 0, len(op.Fields)*2)
			for _, f := range sortedKeys(op.Fields) {
				args = append(args, f, op.Fields[f])
			}
			if err := cli.HSet(cctx, op.Key, args...).Err(); err != nil {
				r.Err = err.Error()
			} else {
				r.OK = true
				r.Detail = fmt.Sprintf("HSET %s (%d fields)", op.Key, len(op.Fields))
			}

		case "mset":
			if len(op.Fields) == 0 {
				r.Err = "at least one key/value required"
				break
			}
			args := make([]interface{}, 0, len(op.Fields)*2)
			for _, k := range sortedKeys(op.Fields) {
				args = append(args, k, op.Fields[k])
			}
			if err := cli.MSet(cctx, args...).Err(); err != nil {
				r.Err = err.Error()
			} else {
				r.OK = true
				r.Detail = fmt.Sprintf("MSET (%d keys)", len(op.Fields))
			}

		case "del":
			if op.Key == "" {
				r.Err = "key required"
				break
			}
			n, err := cli.Del(cctx, op.Key).Result()
			if err != nil {
				r.Err = err.Error()
			} else {
				r.OK = true
				r.Detail = fmt.Sprintf("DEL %s (%d removed)", op.Key, n)
			}

		case "expire":
			if op.Key == "" {
				r.Err = "key required"
				break
			}
			ok, err := cli.Expire(cctx, op.Key, time.Duration(op.TTLSeconds)*time.Second).Result()
			if err != nil {
				r.Err = err.Error()
			} else {
				r.OK = ok
				r.Detail = fmt.Sprintf("EXPIRE %s %ds (applied=%t)", op.Key, op.TTLSeconds, ok)
			}

		default:
			r.Err = "unsupported op: " + op.Op
		}
		results = append(results, r)
	}
	return results, nil
}

func sortedKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
