package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"redis-client/internal/profile"
	"redis-client/internal/rc"
	"redis-client/internal/topo"
	"redis-client/internal/updater"
)

// App is the root struct bound to Wails. Every exported method is callable from
// the React frontend via the generated bindings.
type App struct {
	ctx      context.Context
	profiles *profile.Store
	mgr      *rc.Manager
	updater  *updater.Updater

	// version is set from main() after NewApp(); the updater is built lazily on
	// startup once we know the value.
	version string
}

func NewApp() *App { return &App{} }

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	store, err := profile.New()
	if err != nil {
		fmt.Println("profile store init failed:", err)
	}
	a.profiles = store
	a.mgr = rc.NewManager(a.emit)

	if a.version == "" {
		a.version = "dev"
	}
	home, _ := os.UserHomeDir()
	cfgDir := filepath.Join(home, ".redis-client")
	a.updater = updater.New(updater.Config{
		Owner:          "Leejinik",
		Repo:           "redis-client",
		AssetName:      "redis-client.exe",
		CurrentVersion: a.version,
		ConfigDir:      cfgDir,
	})
	if exe, err := os.Executable(); err == nil {
		a.updater.CleanupLeftovers(exe)
	}
}

func (a *App) shutdown(ctx context.Context) {
	if a.mgr != nil {
		a.mgr.CloseAll()
	}
}

func (a *App) emit(event string, data interface{}) {
	if a.ctx != nil {
		wruntime.EventsEmit(a.ctx, event, data)
	}
}

// ---- Profile management ----

func (a *App) ListProfiles() ([]profile.Profile, error) {
	if a.profiles == nil {
		return nil, fmt.Errorf("profile store not initialized")
	}
	return a.profiles.List()
}

func (a *App) GetProfile(id string) (profile.Profile, error) {
	if a.profiles == nil {
		return profile.Profile{}, fmt.Errorf("profile store not initialized")
	}
	return a.profiles.Get(id)
}

func (a *App) SaveProfile(p profile.Profile) (profile.Profile, error) {
	if a.profiles == nil {
		return p, fmt.Errorf("profile store not initialized")
	}
	saved, err := a.profiles.Save(p)
	if err != nil {
		return saved, err
	}
	// drop any live connection so the next Connect uses the updated config
	if saved.ID != "" && a.mgr != nil {
		a.mgr.Disconnect(saved.ID)
	}
	return saved, nil
}

func (a *App) DeleteProfile(id string) error {
	if a.profiles == nil {
		return fmt.Errorf("profile store not initialized")
	}
	if a.mgr != nil {
		a.mgr.Disconnect(id)
	}
	return a.profiles.Delete(id)
}

// ---- Connection ----

// Connect resolves the master (and starts the failover watcher) for a profile,
// returning the initial topology.
func (a *App) Connect(profileID string) (topo.Topology, error) {
	p, err := a.profiles.Get(profileID)
	if err != nil {
		return topo.Topology{}, err
	}
	return a.mgr.Connect(a.ctx, p)
}

func (a *App) Disconnect(profileID string) {
	if a.mgr != nil {
		a.mgr.Disconnect(profileID)
	}
}

func (a *App) IsConnected(profileID string) bool {
	return a.mgr != nil && a.mgr.IsConnected(profileID)
}

func (a *App) GetTopology(profileID string) (topo.Topology, error) {
	conn, err := a.mgr.Conn(profileID)
	if err != nil {
		return topo.Topology{}, err
	}
	return conn.Topology(), nil
}

// ---- Reads ----

func (a *App) ScanKeys(profileID string, cursor uint64, match string, count int64) (rc.ScanResult, error) {
	conn, err := a.mgr.Conn(profileID)
	if err != nil {
		return rc.ScanResult{}, err
	}
	return conn.ScanKeys(a.ctx, cursor, match, count)
}

func (a *App) KeyMeta(profileID, key string) (rc.KeyMeta, error) {
	conn, err := a.mgr.Conn(profileID)
	if err != nil {
		return rc.KeyMeta{}, err
	}
	return conn.KeyMeta(a.ctx, key)
}

func (a *App) ReadValue(profileID, key string) (rc.ValueResult, error) {
	conn, err := a.mgr.Conn(profileID)
	if err != nil {
		return rc.ValueResult{}, err
	}
	return conn.ReadValue(a.ctx, key)
}

func (a *App) MGetRange(profileID, prefix string, from, to int64) ([]rc.RangeItem, error) {
	conn, err := a.mgr.Conn(profileID)
	if err != nil {
		return nil, err
	}
	return conn.MGetRange(a.ctx, prefix, from, to)
}

func (a *App) MGet(profileID string, keys []string) ([]rc.RangeItem, error) {
	conn, err := a.mgr.Conn(profileID)
	if err != nil {
		return nil, err
	}
	return conn.MGet(a.ctx, keys)
}

// ---- Writes (guarded) ----

func (a *App) Write(profileID string, ops []rc.WriteOp) ([]rc.WriteResult, error) {
	conn, err := a.mgr.Conn(profileID)
	if err != nil {
		return nil, err
	}
	return conn.Write(a.ctx, ops)
}

// --- Auto-update --------------------------------------------------------

// GetCurrentVersion returns the build-time version (or "dev" for local builds).
func (a *App) GetCurrentVersion() string {
	if a.updater == nil {
		return a.version
	}
	return a.updater.CurrentVersion()
}

// CheckForUpdate queries GitHub Releases for a newer build. Pure check — it
// does NOT record an auto-apply attempt.
func (a *App) CheckForUpdate() (updater.UpdateInfo, error) {
	if a.updater == nil {
		return updater.UpdateInfo{CurrentVersion: a.version}, nil
	}
	return a.updater.Check(a.ctx)
}

// ApplyUpdate downloads the new exe, stashes the release notes, swaps the
// binary in place, and quits the app — the relaunched (new) binary shows the
// release notes once on startup. This is the manual/unguarded path.
func (a *App) ApplyUpdate(info updater.UpdateInfo) error {
	if a.updater == nil {
		return errors.New("updater not initialised")
	}
	if err := a.updater.Apply(a.ctx, info); err != nil {
		return err
	}
	// Hand off. Quit in a goroutine so this call can return cleanly to the
	// frontend before the runtime shuts down.
	go wruntime.Quit(a.ctx)
	return nil
}

// GetPendingReleaseNotes returns release notes stashed by the previous version
// right before it triggered the update, iff they belong to the current binary
// version. Returns nil when there's nothing to show.
func (a *App) GetPendingReleaseNotes() *updater.PendingNotes {
	if a.updater == nil {
		return nil
	}
	notes, ok, _ := a.updater.LoadPendingNotes()
	if !ok {
		return nil
	}
	return &notes
}

// MarkReleaseNotesSeen deletes the stashed notes file so it won't pop again.
func (a *App) MarkReleaseNotesSeen() error {
	if a.updater == nil {
		return nil
	}
	return a.updater.ClearPendingNotes()
}

// AutoUpdate is the GUARDED silent startup path. It checks, then only applies
// if the loop guard green-lights (ShouldAutoApply caps repeated non-converging
// attempts at maxAutoTries). On a blocked/available update it returns
// Blocked=true so the frontend can show a manual "new version" badge.
func (a *App) AutoUpdate() updater.AutoUpdateResult {
	if a.updater == nil {
		return updater.AutoUpdateResult{}
	}
	info, err := a.updater.Check(a.ctx)
	if err != nil || !info.Available {
		return updater.AutoUpdateResult{Info: info}
	}
	if !a.updater.ShouldAutoApply(info) {
		return updater.AutoUpdateResult{Blocked: true, Info: info}
	}
	if err := a.updater.Apply(a.ctx, info); err != nil {
		return updater.AutoUpdateResult{Blocked: true, Info: info}
	}
	go wruntime.Quit(a.ctx)
	return updater.AutoUpdateResult{Applying: true, Info: info}
}
