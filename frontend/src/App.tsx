import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import {
  ListProfiles,
  SaveProfile,
  DeleteProfile,
  Connect,
  Disconnect,
  IsConnected,
  GetTopology,
  ScanKeys,
  KeyMeta,
  ReadValue,
  MGetRange,
  Write,
  AutoUpdate,
  CheckForUpdate,
  ApplyUpdate,
  GetPendingReleaseNotes,
  MarkReleaseNotesSeen,
  ShowUpdateModeNoticeOnce,
} from "../wailsjs/go/main/App";
import { updater } from "../wailsjs/go/models";
import { EventsOn } from "../wailsjs/runtime";

// autoApplyFired guards the mount-once startup update flow against React 18
// StrictMode's double-invoke; it lives at module scope so it survives remounts.
let autoApplyFired = false;

// ---- types (mirror the Go JSON shapes) ----
interface Profile {
  id: string;
  name: string;
  nodes: string[];
  redisPort: number;
  sentinelPort: number;
  masterName: string;
  password: string;
  sentinelPassword: string;
  aliases: Record<string, string>;
  readOnly: boolean;
  createdAt?: string;
  updatedAt?: string;
}

const blankProfile = (): Profile => ({
  id: "",
  name: "",
  nodes: [],
  redisPort: 5000,
  sentinelPort: 26379,
  masterName: "mymaster",
  password: "",
  sentinelPassword: "",
  aliases: {},
  readOnly: true,
});

type Any = any;

function typeClass(t: string): string {
  return "type-" + (t || "none");
}

// severity color for a decoded status-code name (status-codes.md)
function statusColor(name: string): string {
  switch (name) {
    case "CONNECTED":
      return "st-ok";
    case "NOT_VERIFIED":
      return "st-idle";
    case "RECONNECTING":
    case "CONNECTING":
    case "RESPONSE_DELAY":
      return "st-warn";
    default:
      return "st-bad"; // DISCONNECTED, PROTOCOL_ERROR, OFFLINE, STOPPED_*
  }
}

function fmtBytes(n: number): string {
  if (!n) return "-";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

function fmtTTL(s: number): string {
  if (s === -1) return "no expire";
  if (s === -2) return "missing";
  return s + "s";
}

export default function App() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selId, setSelId] = useState<string>("");
  const [form, setForm] = useState<Profile | null>(null);

  const [connected, setConnected] = useState(false);
  const [topo, setTopo] = useState<Any>(null);
  const [connErr, setConnErr] = useState("");
  const [busy, setBusy] = useState(false);

  // auto-update
  const [updateInfo, setUpdateInfo] = useState<updater.UpdateInfo | null>(null); // manual badge
  const [applyingMsg, setApplyingMsg] = useState("");
  const [releaseNotes, setReleaseNotes] = useState<{ version: string; notes: string } | null>(null);

  // key browser
  const [match, setMatch] = useState("");
  const [keys, setKeys] = useState<Any[]>([]);
  const [cursor, setCursor] = useState(0);
  const [scanDone, setScanDone] = useState(false);
  const [scanning, setScanning] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const scanGen = useRef(0); // bumped on every scan; stale async results are dropped
  const scanBusy = useRef(false); // single-flight lock for auto-continuations

  // right pane
  const [tab, setTab] = useState<"value" | "range" | "write">("value");
  const [selKey, setSelKey] = useState("");
  const [meta, setMeta] = useState<Any>(null);
  const [value, setValue] = useState<Any>(null);
  const [showDecoded, setShowDecoded] = useState(true);
  const [valErr, setValErr] = useState("");

  // range
  const [rPrefix, setRPrefix] = useState("checkpoint:");
  const [rFrom, setRFrom] = useState("76160");
  const [rTo, setRTo] = useState("76180");
  const [rItems, setRItems] = useState<Any[]>([]);
  const [rErr, setRErr] = useState("");
  const [rPivot, setRPivot] = useState(false); // 전치(행↔열) 토글 — Tab 또는 버튼

  // write
  const [wOp, setWOp] = useState("set");
  const [wKey, setWKey] = useState("");
  const [wValue, setWValue] = useState("");
  const [wTtl, setWTtl] = useState("0");
  const [wFields, setWFields] = useState("");
  const [wResults, setWResults] = useState<Any[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [wErr, setWErr] = useState("");

  const selProfile = useMemo(
    () => profiles.find((p) => p.id === selId) || null,
    [profiles, selId]
  );

  // ---- load + events ----
  async function loadProfiles() {
    const list = (await ListProfiles()) as Any;
    setProfiles((list ?? []) as Profile[]);
  }

  // keep a ref of selId so the topology event handler sees the latest value
  const selIdRef = useMemo(() => ({ current: selId }), []);
  useEffect(() => {
    selIdRef.current = selId;
  }, [selId, selIdRef]);

  useEffect(() => {
    loadProfiles();
    const off = EventsOn("topology", (data: Any) => {
      if (data && data.profileId === selIdRef.current) {
        setTopo(data.topology);
        setConnected(!!(data.topology && data.topology.master));
      }
    });
    return () => off();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- auto-update (mount-once) ----
  useEffect(() => {
    if (autoApplyFired) return;
    autoApplyFired = true;
    (async () => {
      // One-time notice: auto-update changed to notify-only due to the corporate
      // EDR policy. Fire-and-forget (native dialog, self-guarded to show once).
      ShowUpdateModeNoticeOnce().catch(() => { /* ignore */ });
      // 1) pop release notes stashed by the previous version, if any.
      try {
        const notes = await GetPendingReleaseNotes();
        if (notes?.version) {
          setReleaseNotes({ version: notes.version, notes: notes.notes ?? "" });
        }
      } catch {
        /* no-op */
      }
      // 2) notify-only update check: if a newer build exists, show a manual
      //    "download" badge. We never self-replace the running exe — endpoint
      //    security (EDR) quarantines self-updating binaries.
      try {
        const r = await AutoUpdate();
        if (r?.info?.available) setUpdateInfo(r.info);
      } catch {
        /* offline / no repo yet — no-op */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function applyManualUpdate() {
    if (!updateInfo) return;
    setApplyingMsg("브라우저에서 다운로드 페이지를 엽니다… " + (updateInfo.latestVersion ?? ""));
    try {
      await ApplyUpdate(updateInfo); // opens the GitHub release page (no self-replace)
      window.setTimeout(() => setApplyingMsg(""), 3000);
    } catch (e: Any) {
      setApplyingMsg("");
      setConnErr("다운로드 페이지 열기 실패: " + String(e));
    }
  }

  async function dismissReleaseNotes() {
    setReleaseNotes(null);
    try {
      await MarkReleaseNotesSeen();
    } catch {
      /* no-op */
    }
  }

  async function selectProfile(id: string) {
    setSelId(id);
    setForm(null);
    setKeys([]);
    setCursor(0);
    setScanDone(false);
    scanGen.current++; // invalidate any in-flight scan from the previous profile
    scanBusy.current = false;
    setSelKey("");
    setValue(null);
    setMeta(null);
    setConnErr("");
    try {
      const isc = (await IsConnected(id)) as Any;
      setConnected(!!isc);
      if (isc) {
        const t = (await GetTopology(id)) as Any;
        setTopo(t);
      } else {
        setTopo(null);
      }
    } catch {
      setConnected(false);
      setTopo(null);
    }
  }

  async function connect() {
    if (!selId) return;
    setBusy(true);
    setConnErr("");
    try {
      const t = (await Connect(selId)) as Any;
      setTopo(t);
      setConnected(true);
    } catch (e: Any) {
      setConnErr(String(e));
      setConnected(false);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!selId) return;
    await Disconnect(selId);
    setConnected(false);
    setTopo(null);
  }

  // ---- profile form ----
  function startNew() {
    setForm(blankProfile());
  }
  function startEdit(p: Profile) {
    setForm({ ...p, aliases: { ...(p.aliases || {}) } });
  }
  async function saveProfile(p: Profile) {
    setBusy(true);
    try {
      const saved = (await SaveProfile(p as Any)) as Any;
      await loadProfiles();
      setForm(null);
      if (saved && saved.id) setSelId(saved.id);
    } catch (e: Any) {
      alert("저장 실패: " + e);
    } finally {
      setBusy(false);
    }
  }
  async function removeProfile(p: Profile) {
    if (!confirm(`프로필 "${p.name}" 삭제할까요?`)) return;
    await DeleteProfile(p.id);
    if (selId === p.id) setSelId("");
    await loadProfiles();
  }

  // ---- key browser ----
  // fresh=true starts a new query at cursor 0; fresh=false is an auto-continuation
  // fired by scroll/viewport-fill and is single-flighted so rapid scroll events
  // don't stack. The backend already loops SCAN internally until it has a page of
  // matches (or the keyspace ends), so a page never comes back empty mid-scan.
  async function scan(fresh: boolean) {
    if (!connected) return;
    if (!fresh && (scanDone || scanBusy.current)) return;

    const gen = ++scanGen.current;
    const base = fresh ? [] : keys;
    const cur = fresh ? 0 : cursor;
    scanBusy.current = true;
    setScanning(true);
    try {
      const res = (await ScanKeys(selId, cur, match, 300)) as Any;
      if (gen !== scanGen.current) return; // superseded by a newer scan
      const newKeys = (res.keys ?? []) as Any[];
      setKeys([...base, ...newKeys]);
      setCursor(res.cursor);
      setScanDone(res.cursor === 0);
    } catch (e: Any) {
      if (gen === scanGen.current) setValErr(String(e));
    } finally {
      if (gen === scanGen.current) {
        scanBusy.current = false;
        setScanning(false);
      }
    }
  }

  // Auto-continue until the list actually overflows its container, so a short
  // first page (or a sparse pattern) still becomes scrollable — otherwise the
  // infinite-scroll trigger below would never fire (nothing to scroll).
  useEffect(() => {
    if (!connected || scanning || scanDone) return;
    const el = listRef.current;
    if (el && el.scrollHeight <= el.clientHeight + 4) scan(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, scanDone, scanning, connected]);

  function onListScroll() {
    const el = listRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) scan(false);
  }

  async function openKey(key: string) {
    setSelKey(key);
    setTab("value");
    setValErr("");
    setValue(null);
    setMeta(null);
    try {
      const [m, v] = await Promise.all([
        KeyMeta(selId, key) as Any,
        ReadValue(selId, key) as Any,
      ]);
      setMeta(m);
      setValue(v);
    } catch (e: Any) {
      setValErr(String(e));
    }
  }

  async function runRange() {
    setRErr("");
    setRItems([]);
    try {
      const items = (await MGetRange(
        selId,
        rPrefix,
        parseInt(rFrom || "0", 10),
        parseInt(rTo || "0", 10)
      )) as Any;
      setRItems((items ?? []) as Any[]);
    } catch (e: Any) {
      setRErr(String(e));
    }
  }

  // ---- write ----
  function parseFields(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    text.split("\n").forEach((line) => {
      const t = line.trim();
      if (!t) return;
      const idx = t.indexOf("=");
      if (idx < 0) return;
      out[t.slice(0, idx).trim()] = t.slice(idx + 1);
    });
    return out;
  }

  function buildOps(): Any[] {
    const ttl = parseInt(wTtl || "0", 10) || 0;
    if (wOp === "set")
      return [{ op: "set", key: wKey, value: wValue, ttlSeconds: ttl, fields: {} }];
    if (wOp === "expire")
      return [{ op: "expire", key: wKey, value: "", ttlSeconds: ttl, fields: {} }];
    if (wOp === "del")
      return [{ op: "del", key: wKey, value: "", ttlSeconds: 0, fields: {} }];
    if (wOp === "hset")
      return [{ op: "hset", key: wKey, value: "", ttlSeconds: 0, fields: parseFields(wFields) }];
    if (wOp === "mset")
      return [{ op: "mset", key: "", value: "", ttlSeconds: 0, fields: parseFields(wFields) }];
    return [];
  }

  async function confirmWrite() {
    setConfirmOpen(false);
    setWErr("");
    setWResults([]);
    try {
      const res = (await Write(selId, buildOps() as Any)) as Any;
      setWResults((res ?? []) as Any[]);
      if (selKey && (selKey === wKey || wOp === "mset")) openKey(selKey);
    } catch (e: Any) {
      setWErr(String(e));
    }
  }

  const readOnly = selProfile ? selProfile.readOnly : true;

  // ---------------- render ----------------
  return (
    <div className="app">
      <Banner
        topo={topo}
        connected={connected}
        readOnly={readOnly}
        profileName={selProfile?.name || ""}
        updateInfo={updateInfo}
        applyingMsg={applyingMsg}
        onApplyUpdate={applyManualUpdate}
      />

      {releaseNotes && (
        <div className="modal-backdrop" onClick={dismissReleaseNotes}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              업데이트 완료 · {releaseNotes.version}
            </div>
            <pre
              className="mono"
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: 360,
                overflow: "auto",
                fontSize: 12,
                lineHeight: 1.5,
                margin: "10px 0",
              }}
            >
              {releaseNotes.notes || "변경 사항 정보가 없습니다."}
            </pre>
            <div className="inline" style={{ justifyContent: "flex-end" }}>
              <button className="btn" onClick={dismissReleaseNotes}>확인</button>
            </div>
          </div>
        </div>
      )}

      <div className="body">
        {/* ---- left: profiles ---- */}
        <div className="col">
          <div className="col-head">
            <span className="grow">프로필</span>
            <button className="btn btn-xs" onClick={startNew}>+ 새로</button>
          </div>
          <div className="col-scroll">
            {profiles.map((p) => (
              <div
                key={p.id}
                className={"profile-item" + (p.id === selId ? " active" : "")}
                onClick={() => selectProfile(p.id)}
              >
                <div className="pname">{p.name}</div>
                <div className="pmeta mono">
                  {p.nodes.join(", ")} · {p.masterName}
                  {p.readOnly ? " · RO" : " · RW"}
                </div>
              </div>
            ))}
            {profiles.length === 0 && (
              <div className="empty">프로필이 없습니다.<br />+ 새로 를 눌러 추가하세요.</div>
            )}
          </div>

          {selProfile && !form && (
            <div className="scan-controls" style={{ borderTop: "1px solid #2c313a", borderBottom: "none" }}>
              {connected ? (
                <>
                  <button className="btn" onClick={disconnect}>연결 해제</button>
                  <button className="btn" onClick={() => startEdit(selProfile)}>수정</button>
                </>
              ) : (
                <>
                  <button className="btn btn-primary" disabled={busy} onClick={connect}>
                    {busy ? "연결 중…" : "연결"}
                  </button>
                  <button className="btn" onClick={() => startEdit(selProfile)}>수정</button>
                  <button className="btn btn-xs" onClick={() => removeProfile(selProfile)}>삭제</button>
                </>
              )}
            </div>
          )}
          {connErr && <div className="err-text">{connErr}</div>}
        </div>

        {/* ---- middle: key browser ---- */}
        <div className="col">
          <div className="col-head">
            <span className="grow">키 브라우저</span>
            {connected && (
              <span className="topo-sub">{keys.length} loaded{scanDone ? " (끝)" : ""}</span>
            )}
          </div>
          {connected ? (
            <>
              <div className="scan-controls">
                <input
                  placeholder="MATCH 패턴 (예: checkpoint:*, device:*, 빈칸=전체)"
                  value={match}
                  onChange={(e) => setMatch(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && scan(true)}
                  className="mono"
                />
                <button className="btn" disabled={scanning} onClick={() => scan(true)}>스캔</button>
              </div>
              <div className="col-scroll" ref={listRef} onScroll={onListScroll}>
                {keys.map((k) => (
                  <div
                    key={k.key}
                    className={"key-row" + (k.key === selKey ? " active" : "")}
                    onClick={() => openKey(k.key)}
                  >
                    <span className={"badge " + typeClass(k.type)}>{k.type}</span>
                    <span className="kname mono">{k.key}</span>
                  </div>
                ))}
                {keys.length === 0 && !scanning && (
                  <div className="empty">
                    {scanDone ? "일치하는 키가 없습니다." : "스캔을 눌러 키를 조회하세요."}
                  </div>
                )}
                {scanning && <div className="load-more dim">불러오는 중…</div>}
                {scanDone && keys.length > 0 && <div className="load-more dim">— 끝 —</div>}
              </div>
            </>
          ) : (
            <div className="empty">연결 후 사용할 수 있습니다.</div>
          )}
        </div>

        {/* ---- right: value / range / write ---- */}
        <div className="col">
          <div className="col-head">
            <div className="tabs">
              <button className={"tab" + (tab === "value" ? " active" : "")} onClick={() => setTab("value")}>값</button>
              <button className={"tab" + (tab === "range" ? " active" : "")} onClick={() => setTab("range")}>범위 조회</button>
              <button className={"tab" + (tab === "write" ? " active" : "")} onClick={() => setTab("write")}>쓰기</button>
            </div>
          </div>

          {tab === "value" && (
            <ValueView
              selKey={selKey}
              meta={meta}
              value={value}
              showDecoded={showDecoded}
              setShowDecoded={setShowDecoded}
              valErr={valErr}
            />
          )}

          {tab === "range" && (
            <div className="col-scroll">
              <div className="panel">
                <div className="inline">
                  <label>접두어<input className="mono" value={rPrefix} onChange={(e) => setRPrefix(e.target.value)} /></label>
                  <label>from<input style={{ width: 100 }} value={rFrom} onChange={(e) => setRFrom(e.target.value)} /></label>
                  <label>to<input style={{ width: 100 }} value={rTo} onChange={(e) => setRTo(e.target.value)} /></label>
                  <button className="btn btn-primary" disabled={!connected} onClick={runRange}>MGET</button>
                </div>
                {rErr && <div className="err-text">{rErr}</div>}
                {rItems.length > 0 && (() => {
                  // decoded.fields를 한 번만 펼쳐 정상/전치 뷰가 공유
                  const rows = rItems.map((it: Any) => {
                    const f: Any = {};
                    (it.decoded?.fields ?? []).forEach((kv: Any) => (f[kv.field] = kv.value));
                    return { it, f };
                  });
                  // 전치 뷰의 행 정의: [필드명, 값 접근자, 셀 클래스, 아웃라이어 하이라이트 여부]
                  // id·raw는 열마다 고유하므로 하이라이트 대상 아님(전체가 튀어 노이즈).
                  const fieldDefs: [string, (r: Any) => string, string, boolean][] = [
                    ["id", (r) => r.f.id ?? "", "", false],
                    ["표시값", (r) => r.f.formatted ?? "", "", true],
                    ["시각", (r) => r.f.timestamp ?? "", "mono", true],
                    ["원값", (r) => r.f.raw ?? "", "", true],
                    ["raw", (r) => (r.it.exists ? r.it.value : "(없음)"), "mono", false],
                  ];
                  return (
                    <>
                      <div className="inline" style={{ marginTop: 4 }}>
                        <button className="btn btn-xs" onClick={() => setRPivot((p) => !p)}>
                          ⇄ 전치 {rPivot ? "해제" : ""}(Tab)
                        </button>
                        <span className="hint-text">표에 포커스 후 Tab으로 행/열 전환 · {rItems.length}건</span>
                      </div>
                      <div
                        style={{ overflow: "auto", outline: "none" }}
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Tab") {
                            e.preventDefault();
                            setRPivot((p) => !p);
                          }
                        }}
                      >
                        {!rPivot ? (
                          <table className="result-table">
                            <thead>
                              <tr><th>key</th><th>id</th><th>표시값</th><th>시각</th><th>원값</th><th>raw</th></tr>
                            </thead>
                            <tbody>
                              {rows.map(({ it, f }: Any) => (
                                <tr key={it.key} className={it.exists ? "" : "row-missing"}>
                                  <td className="mono">{it.key}</td>
                                  <td>{f.id ?? ""}</td>
                                  <td>{f.formatted ?? ""}</td>
                                  <td className="mono">{f.timestamp ?? ""}</td>
                                  <td>{f.raw ?? ""}</td>
                                  <td className="mono wrap">{it.exists ? it.value : "(없음)"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        ) : (
                          <table className="result-table pivot-table">
                            <thead>
                              <tr>
                                <th className="rowhead corner">필드</th>
                                {rows.map(({ it, f }: Any) => (
                                  <th
                                    key={it.key}
                                    title={it.key}
                                    className={"mono" + (it.exists ? "" : " col-missing")}
                                  >
                                    {f.id ?? it.key}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {fieldDefs.map(([label, get, cls, hl]) => {
                                // 하이라이트 기준값 = 첫 유효 셀 값
                                let base: string | null = null;
                                if (hl) {
                                  for (const r of rows) {
                                    if (r.it.exists) { base = get(r); break; }
                                  }
                                }
                                return (
                                  <tr key={label}>
                                    <td className="rowhead">{label}</td>
                                    {rows.map((r: Any) => {
                                      const v = get(r);
                                      const diff = hl && r.it.exists && base !== null && v !== base;
                                      const c =
                                        (cls ? cls : "") +
                                        (r.it.exists ? "" : " col-missing") +
                                        (diff ? " cell-diff" : "");
                                      return (
                                        <td key={r.it.key} className={c.trim()}>{v}</td>
                                      );
                                    })}
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        )}
                      </div>
                    </>
                  );
                })()}
              </div>
            </div>
          )}

          {tab === "write" && (
            <div className="col-scroll">
              <div className="panel">
                <div className="inline">
                  <span className={"badge " + (readOnly ? "badge-ro" : "badge-rw")}>
                    {readOnly ? "읽기 전용" : "쓰기 가능"}
                  </span>
                  <span className="topo-sub">쓰기는 마스터로만 전송됩니다. 읽기전용은 프로필 수정에서 끕니다.</span>
                </div>
                <label>
                  작업
                  <select value={wOp} onChange={(e) => setWOp(e.target.value)}>
                    <option value="set">SET (문자열)</option>
                    <option value="hset">HSET (해시 필드)</option>
                    <option value="mset">MSET (여러 키 배치)</option>
                    <option value="expire">EXPIRE (TTL 설정)</option>
                    <option value="del">DEL (삭제)</option>
                  </select>
                </label>
                {wOp !== "mset" && (
                  <label>키<input className="mono" value={wKey} onChange={(e) => setWKey(e.target.value)} placeholder="checkpoint:__rc_test__" /></label>
                )}
                {wOp === "set" && (
                  <label>값<input className="mono" value={wValue} onChange={(e) => setWValue(e.target.value)} /></label>
                )}
                {(wOp === "set" || wOp === "expire") && (
                  <label>TTL (초, 0=없음)<input style={{ width: 120 }} value={wTtl} onChange={(e) => setWTtl(e.target.value)} /></label>
                )}
                {(wOp === "hset" || wOp === "mset") && (
                  <label>
                    {wOp === "hset" ? "필드 (field=value, 한 줄에 하나)" : "키/값 (key=value, 한 줄에 하나)"}
                    <textarea rows={5} className="mono" value={wFields} onChange={(e) => setWFields(e.target.value)} />
                  </label>
                )}
                <div className="inline">
                  <button
                    className="btn btn-danger"
                    disabled={!connected || readOnly}
                    onClick={() => setConfirmOpen(true)}
                  >
                    실행
                  </button>
                </div>
                {wErr && <div className="err-text">{wErr}</div>}
                {wResults.length > 0 && (
                  <table className="result-table">
                    <thead><tr><th>op</th><th>key</th><th>결과</th></tr></thead>
                    <tbody>
                      {wResults.map((r, i) => (
                        <tr key={i}>
                          <td>{r.op}</td>
                          <td className="mono">{r.key}</td>
                          <td className={r.ok ? "" : "err-text"} style={{ padding: "4px 8px" }}>
                            {r.ok ? r.detail : "실패: " + r.err}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {confirmOpen && (
        <div className="modal-backdrop" onClick={() => setConfirmOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><span className="grow">쓰기 확인</span></div>
            <div className="modal-body">
              <div className="confirm-line">운영 중인 마스터에 다음을 실행합니다:</div>
              <div className="confirm-box mono">{JSON.stringify(buildOps(), null, 2)}</div>
              <div className="confirm-line" style={{ color: "#ffd29b", marginTop: 10 }}>
                마스터: {topo?.master?.addr || "?"}
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setConfirmOpen(false)}>취소</button>
              <button className="btn btn-danger" onClick={confirmWrite}>실행</button>
            </div>
          </div>
        </div>
      )}

      {form && (
        <ProfileModal
          key={form.id || "new"}
          initial={form}
          onSave={saveProfile}
          onCancel={() => setForm(null)}
          busy={busy}
        />
      )}
    </div>
  );
}

// ---------------- Banner ----------------
function Banner({ topo, connected, readOnly, profileName, updateInfo, applyingMsg, onApplyUpdate }: Any) {
  const master = topo?.master;
  const replicas = topo?.replicas ?? [];
  const sentinels = topo?.sentinels ?? [];
  return (
    <div className="banner">
      <span className="title">REDIS CLIENT</span>
      {profileName && <span className="topo-sub">{profileName}</span>}
      {connected && master ? (
        <>
          <div className="topo-item">
            <span className="topo-dot dot-up" />
            <span className="badge badge-master">MASTER</span>
            <b className="mono">{master.addr}</b>
          </div>
          {replicas.map((r: Any) => (
            <div className="topo-item" key={r.addr}>
              <span className={"topo-dot " + (r.up ? "dot-up" : "dot-down")} />
              <span className="badge badge-replica">REPLICA</span>
              <span className="mono">{r.addr}</span>
              <span className="topo-sub">lag {r.lagSeconds}s</span>
            </div>
          ))}
          <div className="topo-item">
            <span className="badge">SENTINEL</span>
            <span className="topo-sub">
              {sentinels.filter((s: Any) => s.up).length}/{sentinels.length} up · quorum {topo.quorum}
            </span>
          </div>
          <span className="topo-sub">src: {topo.source}</span>
        </>
      ) : (
        <span className="topo-sub">{connected ? "마스터 탐색 중…" : "연결 안 됨"}</span>
      )}
      <span className="grow" />
      {applyingMsg ? (
        <span
          className="badge"
          style={{ background: "#2a3550", color: "#9ecbff", cursor: "default" }}
        >
          {applyingMsg}
        </span>
      ) : (
        updateInfo && (
          <span
            className="badge"
            title="브라우저에서 릴리스 페이지를 열어 새 버전을 직접 내려받습니다 (자동 교체 안 함)"
            onClick={onApplyUpdate}
            style={{ background: "#3a2f12", color: "#ffcf6b", cursor: "pointer" }}
          >
            ⬆️ 새 버전 {updateInfo.latestVersion} — 다운로드
          </span>
        )
      )}
      <span className={"badge " + (readOnly ? "badge-ro" : "badge-rw")}>
        {readOnly ? "READ-ONLY" : "READ-WRITE"}
      </span>
    </div>
  );
}

// ---------------- ValueView ----------------
function ValueView({ selKey, meta, value, showDecoded, setShowDecoded, valErr }: Any) {
  if (valErr) return <div className="err-text">{valErr}</div>;
  if (!selKey) return <div className="empty">키를 선택하면 값이 표시됩니다.</div>;
  if (!value) return <div className="empty">불러오는 중…</div>;

  const decoded = value.decoded;
  return (
    <div className="col-scroll">
      {meta && (
        <div className="meta-line">
          <span>type <b className={typeClass(meta.type)}>{meta.type}</b></span>
          <span>TTL <b>{fmtTTL(meta.ttlSeconds)}</b></span>
          <span>encoding <b>{meta.encoding || "-"}</b></span>
          <span>size <b>{fmtBytes(meta.sizeBytes)}</b></span>
          <span>length <b>{meta.length}</b></span>
        </div>
      )}
      <div className="value-pane">
        <div className="mono" style={{ fontSize: 12, color: "#9aa4b2", marginBottom: 10, wordBreak: "break-all" }}>
          {selKey}
        </div>

        {decoded && (
          <div className="inline" style={{ marginBottom: 10 }}>
            <button className={"tab" + (showDecoded ? " active" : "")} onClick={() => setShowDecoded(true)}>Liz 디코딩</button>
            <button className={"tab" + (!showDecoded ? " active" : "")} onClick={() => setShowDecoded(false)}>원본</button>
          </div>
        )}

        {value.truncated && <div className="truncated">⚠ 값이 커서 일부만 표시됩니다.</div>}

        {/* device: grouped in BOTH modes; the Liz-decoded view adds a 상태 column */}
        {decoded && decoded.groups && (
          <>
            {decoded.groups.map((g: Any, gi: number) => (
              <div key={gi}>
                <div className="group-title">{g.name}</div>
                <table className="kv-table">
                  <thead>
                    <tr>
                      <th className="k">필드</th>
                      <th>값</th>
                      {showDecoded && <th>상태</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {g.fields.map((kv: Any, i: number) => (
                      <tr key={i}>
                        <td className="k">{kv.field}</td>
                        <td className="v mono">{kv.value}</td>
                        {showDecoded && (
                          <td className="v">
                            {kv.label ? (
                              <span className={"status-name " + statusColor(kv.label)}>{kv.label}</span>
                            ) : (
                              ""
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </>
        )}

        {/* checkpoint: decoded = labeled fields, raw = the ║ string */}
        {decoded && decoded.fields && showDecoded && (
          <table className="kv-table">
            <tbody>
              {decoded.fields.map((kv: Any, i: number) => (
                <tr key={i}><td className="k">{kv.field}</td><td className="v mono">{kv.value}</td></tr>
              ))}
            </tbody>
          </table>
        )}
        {decoded && decoded.fields && !showDecoded && (
          <div className="raw-box mono">{value.string}</div>
        )}
        {decoded && decoded.note && showDecoded && <div className="warn-text">{decoded.note}</div>}

        {/* generic keys (no recognized Liz schema): render by type */}
        {!decoded && (
          <>
            {value.type === "string" && <div className="raw-box mono">{value.string}</div>}
            {value.type === "hash" && (
              <table className="kv-table">
                <tbody>
                  {(value.hash ?? []).map((kv: Any, i: number) => (
                    <tr key={i}><td className="k mono">{kv.field}</td><td className="v mono">{kv.value}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
            {value.type === "list" && (
              <table className="kv-table">
                <tbody>
                  {(value.list ?? []).map((v: Any, i: number) => (
                    <tr key={i}><td className="k">{i}</td><td className="v mono">{v}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
            {value.type === "set" && (
              <table className="kv-table">
                <tbody>
                  {(value.set ?? []).map((v: Any, i: number) => (
                    <tr key={i}><td className="v mono">{v}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
            {value.type === "zset" && (
              <table className="kv-table">
                <tbody>
                  {(value.zset ?? []).map((kv: Any, i: number) => (
                    <tr key={i}><td className="k mono">{kv.field}</td><td className="v mono">{kv.value}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------- ProfileModal ----------------
// Raw-string local state (parsed on save) so typing spaces/commas in the
// node/alias fields never gets clobbered by a round-trip through the array form.
function ProfileModal({ initial, onSave, onCancel, busy }: Any) {
  const p: Profile = initial;
  const [name, setName] = useState(p.name);
  const [nodesText, setNodesText] = useState((p.nodes || []).join(", "));
  const [redisPort, setRedisPort] = useState(String(p.redisPort || 5000));
  const [sentinelPort, setSentinelPort] = useState(String(p.sentinelPort || 26379));
  const [masterName, setMasterName] = useState(p.masterName || "mymaster");
  const [password, setPassword] = useState(p.password || "");
  const [sentinelPassword, setSentinelPassword] = useState(p.sentinelPassword || "");
  const [aliasText, setAliasText] = useState(
    Object.entries(p.aliases || {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n")
  );
  const [readOnly, setReadOnly] = useState(!!p.readOnly);

  function submit() {
    const nodes = nodesText.split(/[\s,]+/).filter(Boolean);
    if (!name.trim()) {
      alert("이름을 입력하세요.");
      return;
    }
    if (nodes.length === 0) {
      alert("노드를 하나 이상 입력하세요.");
      return;
    }
    const aliases: Record<string, string> = {};
    aliasText.split("\n").forEach((ln) => {
      const i = ln.indexOf("=");
      if (i > 0) aliases[ln.slice(0, i).trim()] = ln.slice(i + 1).trim();
    });
    onSave({
      ...p,
      name: name.trim(),
      nodes,
      redisPort: parseInt(redisPort || "0", 10) || 5000,
      sentinelPort: parseInt(sentinelPort || "0", 10) || 26379,
      masterName: masterName.trim() || "mymaster",
      password,
      sentinelPassword,
      aliases,
      readOnly,
    });
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: "min(560px, 94vw)" }}>
        <div className="modal-head">
          <span className="grow">{p.id ? "프로필 수정" : "새 프로필"}</span>
          <button className="btn btn-xs" onClick={onCancel}>✕</button>
        </div>
        <div className="modal-body">
          <div className="form-grid" style={{ padding: 0 }}>
            <label>이름<input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: liz 운영" /></label>
            <label>
              노드 (IP, 쉼표/공백 구분 — 개수 자유)
              <input
                className="mono"
                value={nodesText}
                onChange={(e) => setNodesText(e.target.value)}
                placeholder="172.17.64.24, 172.17.64.25, 172.17.64.26"
              />
            </label>
            <div className="row2">
              <label>Redis 포트<input value={redisPort} onChange={(e) => setRedisPort(e.target.value)} /></label>
              <label>Sentinel 포트<input value={sentinelPort} onChange={(e) => setSentinelPort(e.target.value)} /></label>
            </div>
            <label>Master 이름<input className="mono" value={masterName} onChange={(e) => setMasterName(e.target.value)} /></label>
            <label>Redis 비밀번호<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
            <label>Sentinel 비밀번호 (보통 비움)<input type="password" value={sentinelPassword} onChange={(e) => setSentinelPassword(e.target.value)} /></label>
            <label>
              별칭 hostname=IP (선택, 한 줄에 하나)
              <textarea rows={2} className="mono" value={aliasText} onChange={(e) => setAliasText(e.target.value)} placeholder="server_1=172.17.64.24" />
            </label>
            <label className="chk">
              <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
              읽기 전용 (안전, 기본 켜짐)
            </label>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onCancel}>취소</button>
          <button className="btn btn-primary" disabled={busy} onClick={submit}>저장</button>
        </div>
      </div>
    </div>
  );
}
