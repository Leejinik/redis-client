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
  MGet,
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

// STATUS_TABLE is the status-code list the app decodes with (Liz dev
// status-codes.md). Labels stay neutral grey: which codes count as "bad" in the
// product hasn't been confirmed, so the app must not paint a verdict.
const STATUS_TABLE =
  "앱에 넣은 상태 코드표 (Liz 개발 status-codes.md)\n" +
  "0 NOT_VERIFIED · 1 DISCONNECTED · 2 CONNECTED · 3 RECONNECTING\n" +
  "4 PROTOCOL_ERROR · 5 CONNECTING · 6 OFFLINE · 7 STOPPED_POINT_NOT_DEFINED\n" +
  "8 STOPPED_MONITOR_STOPPED · 9 STOPPED_DISABLED · 10 RESPONSE_DELAY\n" +
  "제품 화면의 한국어 표기·정상 여부는 아직 확인 전입니다.";

// checkpoint value parts: stable backend keys -> on-screen names (same names in
// the value tab and the range table).
const CP_LABEL: Record<string, string> = { id: "번호", formatted: "표시값", timestamp: "시각", raw: "원래값" };

// tzLabel renders this PC's UTC offset, e.g. "UTC+09:00". Decoded times use the
// PC's zone, not the server's.
function tzLabel(): string {
  const off = -new Date().getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return `UTC${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

// msTime turns a 13-digit epoch-ms string into local time, or "" when it isn't one.
function msTime(v: string): string {
  if (!/^1\d{12}$/.test((v || "").trim())) return "";
  const d = new Date(parseInt(v, 10));
  const z = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}.${z(d.getMilliseconds(), 3)}`;
}

function clockNow(d: Date): string {
  const z = (n: number) => String(n).padStart(2, "0");
  return `${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
}

// lengthLabel says what `length` counts for each type.
function lengthLabel(type: string, n: number): string {
  if (type === "string") return `길이 ${n}바이트`;
  if (type === "hash") return `필드 ${n}개`;
  return `원소 ${n}개`;
}

function hasGlob(s: string): boolean {
  return /[*?[]/.test(s);
}

function short(s: string, n = 120): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// summarizeConnErr turns the joined Go/redis error text into one Korean line per
// cause; the original stays available under "오류 원문 보기".
function summarizeConnErr(raw: string): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    if (!out.includes(s)) out.push(s);
  };
  // With a wrong password every probe fails, so the "couldn't verify the master"
  // follow-on line only misleads (the master is fine) — show the cause alone.
  const authFail = /WRONGPASS|invalid password|NOAUTH/i.test(raw);
  raw
    .replace(/^Error: /, "")
    .replace(/^connect failed: /, "")
    .split("; ")
    .forEach((part) => {
      const m = part.match(/^redis ([^ ]+): (.*)$/);
      const who = m ? m[1] : "";
      const why = m ? m[2] : part;
      if (/no such host/i.test(why)) add(`${who} — 이 이름의 서버를 찾을 수 없습니다`);
      else if (/WRONGPASS|invalid password|NOAUTH/i.test(why)) add("Redis 비밀번호가 틀렸습니다");
      else if (/refused/i.test(why)) add(`${who} — 연결을 거부했습니다 (포트가 닫혀 있거나 Redis 가 꺼져 있음)`);
      else if (/deadline exceeded|timeout/i.test(why)) add(`${who} — 응답이 없습니다 (시간 초과)`);
      else if (authFail && /마스터인지 확인하지 못했습니다|마스터를 찾지 못했습니다/.test(why)) return;
      else add(why);
    });
  return out;
}

function fmtBytes(n: number): string {
  if (!n) return "-";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

// missingLabel explains an MGET hole: MGET returns nothing both for a missing
// key and for a key of another type, which the backend tells apart via TYPE.
function missingLabel(it: Any): string {
  if (it.type && it.type !== "none") return `(${it.type} — 범위 조회는 string 키만 읽음, 값 탭에서 보기)`;
  return "(없음 — 키가 없음)";
}

function fmtTTL(s: number): string {
  if (s === -1) return "만료 없음";
  if (s === -2) return "키 없음";
  return `${s}초 뒤 만료`;
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
  const [pendingScan, setPendingScan] = useState(false); // run a fresh scan once `match` has updated
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
  const [valReadAt, setValReadAt] = useState<Date | null>(null);

  // range
  const [rPrefix, setRPrefix] = useState("checkpoint:");
  const [rFrom, setRFrom] = useState("");
  const [rTo, setRTo] = useState("");
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
  const [preview, setPreview] = useState<{ rows: Any[]; notes: string[]; at: Date } | null>(null);
  const [wErr, setWErr] = useState("");

  const selProfile = useMemo(
    () => profiles.find((p) => p.id === selId) || null,
    [profiles, selId]
  );

  // Esc closes the topmost dialog (write confirm first, then the profile form).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (confirmOpen) setConfirmOpen(false);
      else if (form) setForm(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmOpen, form]);

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

  // saveFoundNodes adds the servers discovery found to the profile, so a later
  // connect can start from any of them. Saving drops the live connection, so
  // reconnect right after.
  async function saveFoundNodes() {
    const found: string[] = topo?.foundNodes ?? [];
    if (!selProfile || found.length === 0) return;
    await saveProfile({ ...selProfile, nodes: [...selProfile.nodes, ...found.filter((n) => !selProfile.nodes.includes(n))] });
    await connect();
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

  useEffect(() => {
    if (pendingScan) {
      setPendingScan(false);
      scan(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingScan]);

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
      setValReadAt(new Date());
    } catch (e: Any) {
      setValErr(String(e));
    }
  }

  async function runRange() {
    setRErr("");
    setRItems([]);
    if (!/^\d+$/.test(rFrom.trim()) || !/^\d+$/.test(rTo.trim())) {
      setRErr("from·to 에 0 이상의 정수를 넣으세요");
      return;
    }
    try {
      const items = (await MGetRange(
        selId,
        rPrefix,
        parseInt(rFrom, 10),
        parseInt(rTo, 10)
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
      if (idx <= 0) return; // writeProblem() blocks these before anything is sent
      out[t.slice(0, idx).trim()] = t.slice(idx + 1);
    });
    return out;
  }

  // writeProblem returns why the current form must not be sent, or "" when OK.
  // Malformed lines are refused (not silently dropped) and EXPIRE never gets a
  // TTL <= 0, which Redis treats as "delete now".
  function writeProblem(): string {
    if (wOp !== "mset" && !wKey.trim()) return "키를 입력하세요";
    if (wOp === "set" && wTtl.trim() !== "" && !/^\d+$/.test(wTtl.trim()))
      return "TTL 은 0 이상의 정수(초)로 넣으세요 (0 = 만료 없음)";
    if (wOp === "expire" && !(/^\d+$/.test(wTtl.trim()) && parseInt(wTtl, 10) >= 1))
      return "EXPIRE 의 TTL 은 1 이상의 정수(초)만 됩니다 — 0 은 Redis 가 키를 즉시 삭제합니다. 삭제는 DEL 을 쓰세요";
    if (wOp === "hset" || wOp === "mset") {
      const bad: number[] = [];
      let good = 0;
      wFields.split("\n").forEach((line, i) => {
        const s = line.trim();
        if (!s) return;
        if (s.indexOf("=") <= 0) bad.push(i + 1);
        else good++;
      });
      if (bad.length > 0)
        return `${bad.join(", ")}행이 ${wOp === "hset" ? "field=value" : "key=value"} 형식이 아닙니다 — 고친 뒤 실행하세요`;
      if (good === 0) return "한 줄 이상 입력하세요";
    }
    return "";
  }

  // buildPreview reads what is there now so the confirm dialog can show
  // "지금 값 → 바꿀 내용" instead of a JSON dump. HSET sends the field name
  // exactly as typed, so a name that isn't in the hash is called out.
  async function buildPreview(): Promise<{ rows: Any[]; notes: string[]; at: Date }> {
    const op = buildOps()[0];
    const rows: Any[] = [];
    const notes: string[] = [];
    const cur = (it: Any) =>
      !it || !it.exists
        ? it && it.type && it.type !== "none"
          ? `(${it.type} 키 — 문자열로 덮어씀)`
          : "(없음 · 새로 생김)"
        : short(it.value);
    if (op.op === "set") {
      const [it] = (await MGet(selId, [op.key])) as Any;
      rows.push({ key: op.key, now: cur(it), next: short(op.value), ttl: op.ttlSeconds > 0 ? `${op.ttlSeconds}초 뒤 만료` : "만료 없음" });
      if (it && !it.exists && it.type && it.type !== "none")
        notes.push(`⚠ ${op.key} 는 ${it.type} 키입니다 — SET 하면 기존 값이 사라지고 문자열 키로 바뀝니다.`);
    } else if (op.op === "mset") {
      const ks = Object.keys(op.fields);
      const its = (await MGet(selId, ks)) as Any[];
      ks.forEach((k, i) => rows.push({ key: k, now: cur(its[i]), next: short(op.fields[k]), ttl: "만료 없음" }));
    } else if (op.op === "hset") {
      const v = (await ReadValue(selId, op.key)) as Any;
      if (!v.exists) notes.push(`${op.key} 키가 없어 새 해시가 생깁니다.`);
      else if (v.type !== "hash") notes.push(`⚠ ${op.key} 는 ${v.type} 키라 HSET 이 실패합니다.`);
      const have: Record<string, string> = {};
      (v.hash ?? []).forEach((kv: Any) => (have[kv.field] = kv.value));
      Object.keys(op.fields).forEach((f) => {
        const exists = f in have;
        rows.push({ key: op.key, field: f, now: exists ? short(have[f]) : "(없음 · 새 필드)", next: short(op.fields[f]) });
        if (!exists && v.type === "hash") {
          const similar = Object.keys(have).filter((h) => h !== f && h.split(".").pop() === f.split(".").pop());
          notes.push(
            `⚠ 이 해시에 「${f}」 필드는 없습니다 — 입력한 이름 그대로 새 필드가 생깁니다.` +
              (similar.length
                ? ` 비슷한 기존 필드: ${similar.slice(0, 3).map((h) => `${h} (지금 값 ${short(have[h], 30)})`).join(", ")}. 그 필드를 바꾸려면 취소하고 필드 이름을 고치세요.`
                : "")
          );
        }
      });
    } else if (op.op === "expire") {
      const m = (await KeyMeta(selId, op.key)) as Any;
      if (!m.exists) notes.push(`${op.key} 키가 없어 아무 일도 일어나지 않습니다.`);
      const when = clockNow(new Date(Date.now() + op.ttlSeconds * 1000));
      rows.push({ key: op.key, now: m.exists ? fmtTTL(m.ttlSeconds) : "(없음)", next: `${op.ttlSeconds}초 뒤 만료 — ${when} 무렵 키가 지워짐` });
    } else if (op.op === "del") {
      const m = (await KeyMeta(selId, op.key)) as Any;
      rows.push({
        key: op.key,
        now: m.exists ? `${m.type} · ${lengthLabel(m.type, m.length)}` : "(없음)",
        next: m.exists ? "삭제 — 되돌릴 수 없습니다" : "(지울 키 없음)",
      });
    }
    return { rows, notes, at: new Date() };
  }

  async function openConfirm() {
    const p = writeProblem();
    setWErr(p);
    setWResults([]);
    if (p) return;
    setPreview(null);
    setConfirmOpen(true);
    try {
      setPreview(await buildPreview());
    } catch (e: Any) {
      setPreview({ rows: [], notes: ["지금 값을 읽지 못했습니다: " + String(e)], at: new Date() });
    }
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
    const p = writeProblem();
    if (p) {
      setWErr(p);
      return;
    }
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
                  {p.readOnly ? " · 읽기 전용" : " · 쓰기 가능"}
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
          {connected && (topo?.foundNodes ?? []).length > 0 && (
            <div className="hint-line">
              프로필에 없는 서버 {topo.foundNodes.length}대를 찾았습니다: <span className="mono">{topo.foundNodes.join(", ")}</span>
              <br />
              저장해 두면 처음 넣은 서버가 꺼져 있어도 다른 서버로 연결을 시작할 수 있어요.{" "}
              <button className="btn btn-xs" disabled={busy} onClick={saveFoundNodes}>프로필에 저장</button>
            </div>
          )}
          {connErr && (
            <div className="err-text">
              연결하지 못했습니다.
              {summarizeConnErr(connErr).map((s, i) => (
                <div key={i}>· {s}</div>
              ))}
              <details style={{ marginTop: 6 }}>
                <summary>오류 원문 보기</summary>
                <div className="mono" style={{ fontSize: 11 }}>{connErr}</div>
              </details>
            </div>
          )}
        </div>

        {/* ---- middle: key browser ---- */}
        <div className="col">
          <div className="col-head">
            <span className="grow">키 브라우저</span>
            {connected && (
              <span className="topo-sub">불러온 키 {keys.length.toLocaleString()}개 · {scanDone ? "끝" : "더 있음"}</span>
            )}
          </div>
          {connected ? (
            <>
              <div className="scan-controls">
                <input
                  placeholder="키 이름 찾기 (예: device:*, 빈칸=전체)"
                  value={match}
                  onChange={(e) => setMatch(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && scan(true)}
                  className="mono"
                />
                <button className="btn" disabled={scanning} onClick={() => scan(true)}>찾기</button>
              </div>
              {/* always shown: hiding it on blur shifted the list up under the pointer mid-click */}
              <div className="hint-line">* 아무 글자 · ? 한 글자 · [abc] 중 하나 · 기호가 없으면 그 이름의 키 하나만</div>
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
                    {!scanDone ? (
                      "찾기를 눌러 키를 불러오세요."
                    ) : match.trim() && !hasGlob(match) ? (
                      <>
                        「{match.trim()}」 키가 없습니다.
                        <br />
                        <button
                          className="btn btn-xs"
                          style={{ marginTop: 8 }}
                          onClick={() => {
                            setMatch(match.trim() + "*");
                            setPendingScan(true);
                          }}
                        >
                          {match.trim()}* 로 찾기
                        </button>
                      </>
                    ) : (
                      "찾는 패턴과 맞는 키가 없습니다."
                    )}
                  </div>
                )}
                {scanning && <div className="load-more dim">불러오는 중…</div>}
                {!scanning && !scanDone && keys.length > 0 && (
                  <div className="load-more dim">── 스크롤하면 다음 키를 불러옵니다 ──</div>
                )}
                {scanDone && keys.length > 0 && (
                  <div className="load-more dim">── 끝 ({keys.length.toLocaleString()}개) ──</div>
                )}
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
              <button
                className={"tab" + (tab === "write" ? " active" : "")}
                onClick={() => {
                  if (!wKey && selKey) setWKey(selKey);
                  setTab("write");
                }}
              >
                쓰기
              </button>
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
              readAt={valReadAt}
              connected={connected}
              masterAddr={topo?.master?.addr || ""}
              onRefresh={() => openKey(selKey)}
            />
          )}

          {tab === "range" && (
            <div className="col-scroll">
              <div className="panel">
                <div className="inline">
                  <label>키 앞부분<input className="mono" value={rPrefix} onChange={(e) => setRPrefix(e.target.value)} /></label>
                  <label>시작 번호<input style={{ width: 100 }} value={rFrom} onChange={(e) => setRFrom(e.target.value)} onKeyDown={(e) => e.key === "Enter" && runRange()} /></label>
                  <label>끝 번호 (포함)<input style={{ width: 100 }} value={rTo} onChange={(e) => setRTo(e.target.value)} onKeyDown={(e) => e.key === "Enter" && runRange()} /></label>
                  <button className="btn btn-primary" disabled={!connected} onClick={runRange}>가져오기</button>
                </div>
                {(() => {
                  const a = rFrom.trim(), b = rTo.trim();
                  if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return null;
                  const lo = Math.min(+a, +b), hi = Math.max(+a, +b);
                  return <div className="hint-line mono">→ {rPrefix}{lo} ~ {rPrefix}{hi} · 키 {(hi - lo + 1).toLocaleString()}개</div>;
                })()}
                <div className="hint-text">문자열(string) 키만 읽습니다 — hash 등은 값 탭에서 보세요.</div>
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
                    ["번호", (r) => r.f.id ?? "", "", false],
                    ["표시값", (r) => r.f.formatted ?? "", "", true],
                    ["시각", (r) => r.f.timestamp ?? "", "mono", true],
                    ["원래값", (r) => r.f.raw ?? "", "", true],
                    ["저장된 그대로", (r) => (r.it.exists ? r.it.value : missingLabel(r.it)), "mono", false],
                  ];
                  return (
                    <>
                      <div className="inline" style={{ marginTop: 4 }}>
                        <button className="btn btn-xs" onClick={() => setRPivot((p) => !p)}>
                          ⇄ 행·열 바꾸기
                        </button>
                        {rPivot && (
                          <span className="hint-text">
                            <span className="cell-diff legend-swatch" /> 첫 번째 키와 다른 값
                          </span>
                        )}
                        <span className="grow" />
                        <span className="hint-text">{rItems.length}건 · 시각은 이 PC 시간 ({tzLabel()})</span>
                      </div>
                      <div style={{ overflow: "auto" }}>
                        {!rPivot ? (
                          <table className="result-table">
                            <thead>
                              <tr><th>키</th><th>번호</th><th>표시값</th><th>시각</th><th>원래값</th><th>저장된 그대로</th></tr>
                            </thead>
                            <tbody>
                              {rows.map(({ it, f }: Any) => (
                                <tr key={it.key} className={it.exists ? "" : "row-missing"}>
                                  <td className="mono">{it.key}</td>
                                  <td>{f.id ?? ""}</td>
                                  <td>{f.formatted ?? ""}</td>
                                  <td className="mono">{f.timestamp ?? ""}</td>
                                  <td>{f.raw ?? ""}</td>
                                  <td className="mono cell-1line" title={it.exists ? it.value : ""}>{it.exists ? it.value : missingLabel(it)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        ) : (
                          <table className="result-table pivot-table">
                            <thead>
                              <tr>
                                <th className="rowhead corner">항목</th>
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
                  <span className="topo-sub">읽기·쓰기 모두 마스터 {topo?.master?.addr || "?"} 로 갑니다. 읽기 전용은 프로필 수정에서 끕니다.</span>
                </div>
                <label>
                  작업
                  <select
                    value={wOp}
                    onChange={(e) => {
                      setWOp(e.target.value);
                      setWResults([]);
                      setWErr("");
                    }}
                  >
                    <option value="set">SET — 문자열 키 하나 쓰기</option>
                    <option value="hset">HSET — 해시 키의 필드 쓰기</option>
                    <option value="mset">MSET — 문자열 키 여러 개 한 번에 쓰기</option>
                    <option value="expire">EXPIRE — 키에 만료 시간 걸기 (지나면 키가 지워짐)</option>
                    <option value="del">DEL — 키 지우기</option>
                  </select>
                </label>
                {wOp !== "mset" && (
                  <label>키<input className="mono" value={wKey} onChange={(e) => setWKey(e.target.value)} placeholder="키 이름 (값 탭에서 고른 키가 자동으로 들어옵니다)" /></label>
                )}
                {wOp === "set" && (
                  <label>값<input className="mono" value={wValue} onChange={(e) => setWValue(e.target.value)} /></label>
                )}
                {wOp === "set" && (
                  <label>TTL (초, 0=만료 없음)<input style={{ width: 120 }} value={wTtl} onChange={(e) => setWTtl(e.target.value)} /></label>
                )}
                {wOp === "expire" && (
                  <label>TTL (초, 1 이상 — 0 은 키 삭제라 막혀 있음)<input style={{ width: 120 }} value={wTtl} onChange={(e) => setWTtl(e.target.value)} /></label>
                )}
                {(wOp === "hset" || wOp === "mset") && (
                  <label>
                    {wOp === "hset" ? "필드 (Redis 에 저장할 이름 그대로 — field=value, 한 줄에 하나)" : "키/값 (key=value, 한 줄에 하나)"}
                    <textarea rows={5} className="mono" value={wFields} onChange={(e) => setWFields(e.target.value)} />
                  </label>
                )}
                <div className="inline">
                  <button
                    className="btn btn-danger"
                    disabled={!connected || readOnly}
                    onClick={openConfirm}
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
              <div className="confirm-line">
                운영 중인 마스터 <b className="mono">{topo?.master?.addr || "?"}</b> 에 다음을 실행합니다.
              </div>
              {!preview ? (
                <div className="hint-text">지금 값을 읽는 중…</div>
              ) : (
                <>
                  {preview.rows.length > 0 && (
                    <table className="result-table confirm-table">
                      <thead>
                        <tr>
                          <th>키</th>
                          {wOp === "hset" && <th>필드</th>}
                          <th>지금</th>
                          <th>→ 바뀔 내용</th>
                          {(wOp === "set" || wOp === "mset") && <th>만료</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {preview.rows.map((r: Any, i: number) => (
                          <tr key={i}>
                            <td className="mono">{r.key}</td>
                            {wOp === "hset" && <td className="mono">{r.field}</td>}
                            <td className="mono">{r.now}</td>
                            <td className="mono">{r.next}</td>
                            {(wOp === "set" || wOp === "mset") && <td>{r.ttl}</td>}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {preview.notes.map((n, i) => (
                    <div key={i} className="warn-text">{n}</div>
                  ))}
                  <div className="hint-text">「지금」은 {clockNow(preview.at)} 에 읽은 값입니다.</div>
                </>
              )}
              <details style={{ marginTop: 8 }}>
                <summary className="hint-text">전송 내용 자세히 보기</summary>
                <div className="confirm-box mono">{JSON.stringify(buildOps(), null, 2)}</div>
              </details>
            </div>
            <div className="modal-foot">
              <button className="btn" autoFocus onClick={() => setConfirmOpen(false)}>취소</button>
              <button className="btn btn-danger" disabled={!preview} onClick={confirmWrite}>
                {wOp === "del" ? "삭제 실행" : `${Math.max(preview?.rows.length ?? 1, 1)}건 쓰기`}
              </button>
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
          <div className="topo-item" title="앱이 직접 접속해 마스터임을 확인했습니다. 읽기와 쓰기는 모두 여기로 갑니다.">
            <span className="topo-dot dot-up" />
            <span className="badge badge-master">MASTER</span>
            <b className="mono">{master.addr}</b>
          </div>
          {replicas.map((r: Any) => (
            <div
              className="topo-item"
              key={r.addr}
              title={
                "● = 마스터가 online 으로 보고한 복제본 (앱이 직접 접속한 것은 아님)\n" +
                "지연 = 이 복제본이 마지막으로 마스터에 응답한 뒤 지난 시간 (마스터 보고).\n" +
                "1초마다 응답하므로 0~1초가 평소 값입니다."
              }
            >
              <span className={"topo-dot " + (r.up ? "dot-up" : "dot-down")} />
              <span className="badge badge-replica">REPLICA</span>
              <span className="mono">{r.addr}</span>
              <span className="topo-sub">지연 {r.lagSeconds}초</span>
            </div>
          ))}
          <SentinelBox topo={topo} sentinels={sentinels} />
          {(() => {
            const s = SRC_LABEL[topo.source] || [topo.source, "", false];
            return (
              <span
                className={s[2] ? "topo-warn" : "topo-sub"}
                title={(s[1] ? s[1] + "\n" : "") + "3초마다 다시 찾아, 마스터가 바뀌면 따라갑니다."}
              >
                {s[0]}
              </span>
            );
          })()}
          {(topo.warnings ?? []).length > 0 && (
            <span className="topo-warn">⚠ {(topo.warnings ?? []).join(" / ")}</span>
          )}
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
      {profileName && (
        <span
          className={"badge " + (readOnly ? "badge-ro" : "badge-rw")}
          title="선택한 프로필의 설정입니다 (프로필 수정에서 바꿉니다)"
        >
          {readOnly ? "읽기 전용" : "쓰기 가능"}
        </span>
      )}
    </div>
  );
}

// src -> [화면 문구, 툴팁, 경고 여부]
const SRC_LABEL: Record<string, [string, string, boolean]> = {
  "sentinel+probe": ["마스터 확인: Sentinel+직접", "노드에 직접 물어 마스터를 찾았고 Sentinel 도 응답했습니다.", false],
  sentinel: ["마스터 확인: Sentinel 안내", "프로필 노드 중 마스터라고 답한 곳이 없어, Sentinel 이 알려 준 마스터에 직접 확인했습니다.", false],
  "direct-probe": [
    "⚠ 마스터 확인: 직접만 — Sentinel 응답 없음",
    "Sentinel 이 하나도 응답하지 않아, 프로필에 넣은 노드 안에서만 마스터를 찾았습니다.",
    true,
  ],
};

// SentinelBox is the "Sentinel x/y 응답 ▾" button; it unfolds the per-address
// list (who answered, where the address came from) and what quorum means.
function SentinelBox({ topo, sentinels }: Any) {
  const [open, setOpen] = useState(false);
  const up = sentinels.filter((s: Any) => s.up).length;
  const partial = sentinels.length === 0 || up < sentinels.length;
  return (
    <div className="sentinel-box" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
      <button
        className={"topo-item sentinel-btn" + (partial ? " warn" : "")}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {partial ? "⚠ " : ""}Sentinel {up}/{sentinels.length} 응답 {open ? "▴" : "▾"}
      </button>
      {open && (
        <div className="sentinel-pop">
          <div className="pop-title">Sentinel {sentinels.length}개 중 {up}개 응답</div>
          {sentinels.map((s: Any) => (
            <div className="pop-row" key={s.addr}>
              <span className={"topo-dot " + (s.up ? "dot-up" : "dot-down")} />
              <span className="mono">{s.addr}</span>
              <span>{s.up ? "응답" : "응답 없음"}</span>
              <span className="dim">
                {s.source === "announced" ? "Sentinel 이 알려 준 주소" : s.source === "found" ? "연결하며 찾은 서버" : "프로필 노드"}
              </span>
            </div>
          ))}
          <div className="pop-foot">quorum {topo.quorum} — 마스터 장애를 확정하는 데 필요한 Sentinel 동의 수 (서버 설정값)</div>
        </div>
      )}
    </div>
  );
}

// ---------------- ValueView ----------------
function ValueView({ selKey, meta, value, showDecoded, setShowDecoded, valErr, readAt, connected, masterAddr, onRefresh }: Any) {
  if (valErr) return <div className="err-text">{valErr}</div>;
  if (!selKey) return <div className="empty">키를 선택하면 값이 표시됩니다.</div>;
  if (!value) return <div className="empty">불러오는 중…</div>;

  const decoded = value.decoded;
  const cpField = (kv: Any) => CP_LABEL[kv.field] || kv.field;
  return (
    <div className={"col-scroll" + (connected ? "" : " stale")}>
      {meta && (
        <div className="meta-line">
          <b className={typeClass(meta.type)}>{meta.type}</b>
          <span>{fmtTTL(meta.ttlSeconds)}</span>
          <span>{lengthLabel(meta.type, meta.length)}</span>
          <span title={`Redis MEMORY USAGE 근사값 · 내부 인코딩 ${meta.encoding || "-"}`}>
            메모리 약 {fmtBytes(meta.sizeBytes)} ⓘ
          </span>
        </div>
      )}
      <div className="value-pane">
        <div className="inline value-head">
          <span className="mono" style={{ fontSize: 12, color: "#9aa4b2", wordBreak: "break-all" }}>{selKey}</span>
          <span className="grow" />
          <span className={connected ? "hint-text" : "warn-text"}>
            {readAt
              ? connected
                ? `${clockNow(readAt)} 에 마스터 ${masterAddr} 에서 읽음`
                : `연결 해제됨 — ${clockNow(readAt)} 에 읽은 값`
              : ""}
          </span>
          <button className="btn btn-xs" disabled={!connected} onClick={onRefresh}>새로고침</button>
        </div>

        {decoded && (
          <div className="inline" style={{ marginBottom: 10 }}>
            <button className={"tab" + (showDecoded ? " active" : "")} onClick={() => setShowDecoded(true)}>Liz 형식으로 보기</button>
            <button className={"tab" + (!showDecoded ? " active" : "")} onClick={() => setShowDecoded(false)}>저장된 그대로</button>
          </div>
        )}

        {value.truncated && <div className="truncated">⚠ 값이 커서 일부만 표시됩니다.</div>}

        {/* device, Liz view: grouped by interface, full stored field names, 뜻 column */}
        {decoded && decoded.groups && showDecoded && (
          <>
            {decoded.groups.map((g: Any, gi: number) => (
              <div key={gi}>
                <div className="group-title">{g.name}</div>
                <table className="kv-table three">
                  <colgroup>
                    <col style={{ width: "38%" }} />
                    <col style={{ width: "22%" }} />
                    <col />
                  </colgroup>
                  <thead>
                    <tr>
                      <th className="k">필드</th>
                      <th>값</th>
                      <th>뜻</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.fields.map((kv: Any, i: number) => {
                      const when = msTime(kv.value);
                      return (
                        <tr key={i}>
                          <td className="k mono">{kv.field}</td>
                          <td className="v mono">{kv.value}</td>
                          <td className="v">
                            {kv.label ? (
                              <span className="status-name st-idle" title={STATUS_TABLE}>{kv.label}</span>
                            ) : when ? (
                              <span className="hint-text">{when} (이 PC 시간)</span>
                            ) : (
                              ""
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ))}
          </>
        )}

        {/* device, stored view: flat hash exactly as stored */}
        {decoded && decoded.groups && !showDecoded && (
          <table className="kv-table">
            <tbody>
              {(value.hash ?? []).map((kv: Any, i: number) => (
                <tr key={i}><td className="k mono">{kv.field}</td><td className="v mono">{kv.value}</td></tr>
              ))}
            </tbody>
          </table>
        )}

        {/* checkpoint, Liz view: the stored string, then its parts by name */}
        {decoded && decoded.fields && showDecoded && (
          <>
            <div className="hint-line mono">저장된 문자열 {value.string}</div>
            <table className="kv-table">
              <tbody>
                {decoded.fields.map((kv: Any, i: number) => (
                  <tr key={i}>
                    <td className="k">{cpField(kv)}</td>
                    <td className="v mono">
                      {kv.value}
                      {kv.field === "timestamp" && <span className="hint-text"> · 이 PC 시간 ({tzLabel()})</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
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
      alert("서버 IP 를 하나 이상 입력하세요.");
      return;
    }
    if (!password) {
      alert("Redis 비밀번호를 입력하세요.");
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
            <div className="hint-text">Sentinel 구성(Liz 표준)에 연결합니다. * 는 꼭 넣어야 하는 칸입니다.</div>
            <label>이름 *<input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: liz 운영" /></label>
            <label>
              서버 IP * (아무 서버 하나만 넣어도 됩니다 — 나머지는 연결할 때 찾아요. 여러 개면 살아 있는 곳에서 시작)
              <input
                className="mono"
                value={nodesText}
                onChange={(e) => setNodesText(e.target.value)}
                placeholder="172.17.64.24, 172.17.64.25, 172.17.64.26"
              />
            </label>
            <div className="row2">
              <label>Redis 포트 (Liz 표준 5000)<input value={redisPort} onChange={(e) => setRedisPort(e.target.value)} /></label>
              <label>Sentinel 포트 (Liz 표준 26379)<input value={sentinelPort} onChange={(e) => setSentinelPort(e.target.value)} /></label>
            </div>
            <label>마스터 이름 (Liz 표준 mymaster)<input className="mono" value={masterName} onChange={(e) => setMasterName(e.target.value)} /></label>
            <label>Redis 비밀번호 *<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
            <label>Sentinel 비밀번호 (Liz 는 비워 둠)<input type="password" value={sentinelPassword} onChange={(e) => setSentinelPassword(e.target.value)} /></label>
            <label>
              서버 이름=IP (보통 비워 둠 — 상단에 ⚠ 경고가 안내할 때만, 한 줄에 하나)
              <textarea rows={2} className="mono" value={aliasText} onChange={(e) => setAliasText(e.target.value)} placeholder="server01=172.17.64.130" />
            </label>
            <label className="chk">
              <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
              읽기 전용 (쓰기 탭 잠금 — 기본 켜짐)
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
