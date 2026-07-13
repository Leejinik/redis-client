# redis-client

Liz Redis-Sentinel 데스크톱 클라이언트 (Wails + Go + React).

## 무엇을 하나

- **마스터 자동 탐색 + 페일오버 추적** — Sentinel(`get-master-addr-by-name`/`replicas`/`sentinels`) +
  각 노드 `INFO replication` 직접 프로브를 함께 사용해 현재 마스터/복제본/센티넬을 런타임에 열거한다.
  노드 수(redis 1~5, sentinel 1~7)를 하드코딩하지 않는다 — 프로필의 노드 목록 길이만큼 자동 대응.
- **호스트명 → IP 치환** — Sentinel/INFO가 주소를 `server_1` 같은 호스트명으로 돌려주는데, 클라이언트
  PC에선 안 풀린다. `server_N → nodes[N-1]` positional alias(+수동 별칭)로 접속 시점에 IP로 바꾼다.
- **타입별 읽기** — `SCAN` 브라우저(112k 키라 `KEYS` 금지, **무한 스크롤**로 페이지 자동 로드),
  string=GET / hash=HGETALL / list·set·zset 지원, **범위 MGET**(`checkpoint:` id X~Y 한번에).
  정확한 키(glob 문자 없음)는 `SCAN` 대신 `TYPE`로 즉시 조회. 백엔드는 매칭이 한 페이지분
  모일 때까지(또는 키스페이스 끝까지) 내부적으로 `SCAN`을 이어 돌려, 희소 패턴도 빈 페이지로
  끊기지 않는다.
- **Liz 디코딩** — `checkpoint:*` 문자열(`id║형식값║타임스탬프ms║원값`, 구분자 U+2551)과
  `device:*` 해시(`interface.N.*` 필드를 인터페이스별로 그룹핑)를 구조화해서 보여준다. "원본/디코딩" 토글.
- **가드된 쓰기** — SET/HSET/MSET(배치)/EXPIRE/DEL, 마스터로만 전송. 프로필 **읽기전용 토글 기본 ON**,
  실행 전 확인 다이얼로그, FLUSHALL 등 위험 명령 미노출.

## 구조

```
main.go / app.go            Wails 부트스트랩 + IPC 표면
internal/profile            연결 프로필 (~/.redis-client/profiles.json)
internal/topo               마스터 탐색(discover) + 별칭(aliases) + 감시자(watch)
internal/rc                 연결 관리(manager) + 키(keys)/값(values)/쓰기(write) + Liz 디코더(liz)
frontend/                   React + TypeScript UI (토폴로지 배너 / 프로필 / 키 브라우저 / 값 뷰어)
```

## 빌드 / 실행

```
wails dev      # 개발 (핫리로드)
wails build    # 배포 → build/bin/redis-client.exe
```

## 연결 설정

프로필에 노드 IP 목록, Redis 포트(기본 5000), Sentinel 포트(기본 26379), Master 이름(기본 `mymaster`),
Redis 비밀번호를 넣는다. Sentinel은 보통 무인증. 노드 개수는 자유 — Sentinel이 실제 토폴로지를 알려준다.
