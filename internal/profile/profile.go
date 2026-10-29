// Package profile persists Redis Sentinel connection profiles to
// ~/.redis-client/profiles.json. The store mirrors the pattern used by the
// sibling Liz tools (infra-diag, liz-checkpoint-tool): a single JSON file,
// upsert-by-UUID, thread-safe.
package profile

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
)

// Default ports/name for a Liz Redis Sentinel deployment.
const (
	DefaultRedisPort    = 5000
	DefaultSentinelPort = 26379
	DefaultMasterName   = "mymaster"
	DefaultDBPort       = 3306
)

// Profile kinds. Profiles saved before MariaDB support have an empty Kind and
// are Redis-Sentinel profiles.
const (
	KindRedis   = "redis"
	KindMariaDB = "mariadb"
)

// Profile is a single connection target. The node list length is arbitrary
// (1..N) — discovery enumerates the real master/replicas at runtime, so the
// same profile shape serves any topology size.
type Profile struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Kind string `json:"kind"` // KindRedis (also "") | KindMariaDB

	Nodes            []string          `json:"nodes"`            // ordered redis node IPs/hosts
	RedisPort        int               `json:"redisPort"`        // default 5000
	SentinelPort     int               `json:"sentinelPort"`     // default 26379
	MasterName       string            `json:"masterName"`       // default "mymaster"
	Password         string            `json:"password"`         // redis requirepass
	SentinelPassword string            `json:"sentinelPassword"` // usually empty
	Aliases          map[string]string `json:"aliases"`          // manual hostname->IP overrides
	ReadOnly         bool              `json:"readOnly"`         // safety switch; default true

	// MariaDB only. Nodes holds the server IPs and Password the DB password.
	DBPort   int    `json:"dbPort"`   // default 3306
	DBUser   string `json:"dbUser"`   // login account
	Database string `json:"database"` // default schema, may be empty

	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// WithDefaults fills in zero-valued ports/master name so callers never have to.
func (p Profile) WithDefaults() Profile {
	if p.RedisPort == 0 {
		p.RedisPort = DefaultRedisPort
	}
	if p.SentinelPort == 0 {
		p.SentinelPort = DefaultSentinelPort
	}
	if p.MasterName == "" {
		p.MasterName = DefaultMasterName
	}
	if p.DBPort == 0 {
		p.DBPort = DefaultDBPort
	}
	return p
}

// IsMariaDB reports whether the profile targets MariaDB rather than Redis.
func (p Profile) IsMariaDB() bool { return p.Kind == KindMariaDB }

type file struct {
	Version  int       `json:"version"`
	Profiles []Profile `json:"profiles"`
}

type Store struct {
	mu   sync.Mutex
	path string
}

// New opens (creating if needed) ~/.redis-client/profiles.json.
func New() (*Store, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("home dir: %w", err)
	}
	dir := filepath.Join(home, ".redis-client")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("mkdir %s: %w", dir, err)
	}
	return &Store{path: filepath.Join(dir, "profiles.json")}, nil
}

func (s *Store) Path() string { return s.path }

func (s *Store) load() (file, error) {
	var f file
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return file{Version: 1}, nil
	}
	if err != nil {
		return f, err
	}
	if len(data) == 0 {
		return file{Version: 1}, nil
	}
	if err := json.Unmarshal(data, &f); err != nil {
		return f, fmt.Errorf("parse %s: %w", s.path, err)
	}
	if f.Version == 0 {
		f.Version = 1
	}
	return f, nil
}

func (s *Store) save(f file) error {
	f.Version = 1
	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	// atomic write: tmp + rename
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func (s *Store) List() ([]Profile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f, err := s.load()
	if err != nil {
		return nil, err
	}
	sort.Slice(f.Profiles, func(i, j int) bool { return f.Profiles[i].Name < f.Profiles[j].Name })
	if f.Profiles == nil {
		f.Profiles = []Profile{}
	}
	return f.Profiles, nil
}

func (s *Store) Get(id string) (Profile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f, err := s.load()
	if err != nil {
		return Profile{}, err
	}
	for _, p := range f.Profiles {
		if p.ID == id {
			return p, nil
		}
	}
	return Profile{}, fmt.Errorf("profile %s not found", id)
}

// Save upserts by ID (assigning a new UUID if empty) and returns the record.
func (s *Store) Save(p Profile) (Profile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p.Name == "" {
		return p, fmt.Errorf("profile name is required")
	}
	if len(p.Nodes) == 0 {
		return p, fmt.Errorf("at least one node is required")
	}
	f, err := s.load()
	if err != nil {
		return p, err
	}
	now := time.Now().UTC()
	if p.ID == "" {
		p.ID = uuid.NewString()
		p.CreatedAt = now
	}
	p.UpdatedAt = now

	found := false
	for i, existing := range f.Profiles {
		if existing.ID == p.ID {
			if p.CreatedAt.IsZero() {
				p.CreatedAt = existing.CreatedAt
			}
			f.Profiles[i] = p
			found = true
			break
		}
	}
	if !found {
		f.Profiles = append(f.Profiles, p)
	}
	if err := s.save(f); err != nil {
		return p, err
	}
	return p, nil
}

func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	f, err := s.load()
	if err != nil {
		return err
	}
	out := f.Profiles[:0]
	for _, p := range f.Profiles {
		if p.ID != id {
			out = append(out, p)
		}
	}
	f.Profiles = out
	return s.save(f)
}
