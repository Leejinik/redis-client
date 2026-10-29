package rc

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// CheckpointSep is the field separator inside Liz `checkpoint:*` string values:
// U+2551 BOX DRAWINGS DOUBLE VERTICAL (UTF-8 E2 95 91).
const CheckpointSep = "║"

// KV is an ordered field/value pair (used for hashes, zsets, and decoded views).
// Label carries an optional decoded meaning (e.g. a status-code name) shown as
// an extra column in the Liz-decoded device view.
type KV struct {
	Field string `json:"field"`
	Value string `json:"value"`
	Label string `json:"label,omitempty"`
}

// interfaceStatusNames maps the status code (0~10) used by both
// `interface.<name>.status` and device `rep_status` to its enum name.
// Source: status-codes.md. (repStatus 0~8 is an intermediate calc value that
// is never persisted, so we only decode the stored status code here.)
var interfaceStatusNames = map[string]string{
	"0":  "NOT_VERIFIED",
	"1":  "DISCONNECTED",
	"2":  "CONNECTED",
	"3":  "RECONNECTING",
	"4":  "PROTOCOL_ERROR",
	"5":  "CONNECTING",
	"6":  "OFFLINE",
	"7":  "STOPPED_POINT_NOT_DEFINED",
	"8":  "STOPPED_MONITOR_STOPPED",
	"9":  "STOPPED_DISABLED",
	"10": "RESPONSE_DELAY",
}

// statusLabeled attaches the status-code name to a field when it is a status
// code (interface `status` or device `rep_status`).
func statusLabeled(kv KV, isStatus bool) KV {
	if isStatus {
		if n := interfaceStatusNames[strings.TrimSpace(kv.Value)]; n != "" {
			kv.Label = n
		}
	}
	return kv
}

// Group is a labeled set of fields (used to split a device hash into "core" and
// per-interface sub-tables).
type Group struct {
	Name   string `json:"name"`
	Fields []KV   `json:"fields"`
}

// Decoded is a Liz-schema-aware interpretation of a raw value. Kind is
// "checkpoint", "checkpoint_uptime", or "device"; empty Decoded means the key
// isn't a recognized Liz schema and only the raw view applies.
type Decoded struct {
	Kind   string  `json:"kind"`
	Fields []KV    `json:"fields,omitempty"` // flat labeled fields (checkpoint)
	Groups []Group `json:"groups,omitempty"` // grouped fields (device)
	Note   string  `json:"note,omitempty"`
}

// DecodeString decodes a `checkpoint:*` value:
//
//	checkpoint:<id>                -> id ║ formatted ║ ts_ms ║ raw
//	checkpoint:<id>:current_uptime -> id ║ ts_ms ║ raw
//
// Returns nil if the key/value isn't a recognized checkpoint string.
func DecodeString(key, val string) *Decoded {
	if !strings.HasPrefix(key, "checkpoint:") || !strings.Contains(val, CheckpointSep) {
		return nil
	}
	parts := strings.Split(val, CheckpointSep)
	uptime := strings.HasSuffix(key, ":current_uptime")
	d := &Decoded{Kind: "checkpoint"}
	if uptime {
		d.Kind = "checkpoint_uptime"
	}
	switch {
	case uptime && len(parts) == 3:
		d.Fields = []KV{{Field: "id", Value: parts[0]}, {Field: "timestamp", Value: humanMs(parts[1])}, {Field: "raw", Value: parts[2]}}
	case !uptime && len(parts) == 4:
		d.Fields = []KV{{Field: "id", Value: parts[0]}, {Field: "formatted", Value: parts[1]}, {Field: "timestamp", Value: humanMs(parts[2])}, {Field: "raw", Value: parts[3]}}
	case len(parts) == 3:
		d.Fields = []KV{{Field: "id", Value: parts[0]}, {Field: "timestamp", Value: humanMs(parts[1])}, {Field: "raw", Value: parts[2]}}
	default:
		for i, p := range parts {
			d.Fields = append(d.Fields, KV{Field: fmt.Sprintf("field_%d", i), Value: p})
		}
		d.Note = fmt.Sprintf("unexpected field count (%d)", len(parts))
	}
	return d
}

// DecodeHash groups a `device:*` hash into a "core" table plus one table per
// interface (fields like `interface.0.status` -> group "interface 0"). Fields
// keep their full stored name so what the user reads is what HSET must use.
// Returns nil for non-device hashes.
func DecodeHash(key string, kvs []KV) *Decoded {
	if !strings.HasPrefix(key, "device:") {
		return nil
	}
	d := &Decoded{Kind: "device"}
	core := Group{Name: "core"}
	ifaces := map[string]*Group{}
	var order []string
	for _, kv := range kvs {
		if strings.HasPrefix(kv.Field, "interface.") {
			rest := kv.Field[len("interface."):]
			if idx, sub, ok := strings.Cut(rest, "."); ok {
				name := "interface " + idx
				g := ifaces[name]
				if g == nil {
					g = &Group{Name: name}
					ifaces[name] = g
					order = append(order, name)
				}
				g.Fields = append(g.Fields, statusLabeled(kv, sub == "status"))
				continue
			}
		}
		core.Fields = append(core.Fields, statusLabeled(kv, kv.Field == "rep_status"))
	}
	d.Groups = append(d.Groups, core)
	for _, name := range order {
		d.Groups = append(d.Groups, *ifaces[name])
	}
	return d
}

// humanMs renders an epoch-milliseconds string as a human timestamp, keeping
// the raw value in parentheses. Non-numeric input is returned unchanged.
func humanMs(s string) string {
	n, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil {
		return s
	}
	return time.UnixMilli(n).Local().Format("2006-01-02 15:04:05.000") + " (" + s + ")"
}
