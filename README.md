# redis-client

Liz Redis-Sentinel 데스크톱 클라이언트 (Wails + Go + React).

## 무엇을 하나

- **마스터 자동 탐색 + 페일오버 추적** — Sentinel(`get-master-addr-by-name`/`replicas`/`sentinels`) +
  각 노드 `INFO replication` 직접 프로브를 함께 사용해 현재 마스터/복제본/센티넬을 런타임에 열거한다.
  노드 수(redis 1~5, sentinel 1~7)를 하드코딩하지 않는다 — 프로필의 노드 목록 길이만큼 자동 대응.
- **호스트명 → IP 치환** — Sentinel/INFO가 주소를 `server_1` 같은 호스트명으로 돌려주는데, 클라이언트
  PC에선 안 풀린다. `server_N → nodes[N-1]` positional alias(+수동 별칭)로 접속 시점에 IP로 바꾼다.
- **타입별 읽기** — `SCAN` 브라우저(112k 키라 `KEYS` 금지, **무한 스크롤**로 페이지 자동 로드),
  string=GET / hash=HGETALL / list·set·zset 지원, **범위 MGET**(`checkpoint:` id X~Y 한번에,
  결과 표에 포커스 후 **`Tab`**(또는 `⇄ 전치` 버튼)으로 **행↔열 전치** — 필드별 비교·첫 값과 다른 셀 하이라이트).
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

### 리눅스 (Ubuntu 24.04 / 26.04)

```bash
sudo apt install -y build-essential pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev
wails build -tags webkit2_41    # → build/bin/redis-client
wails dev   -tags webkit2_41
```

`-tags webkit2_41`은 **필수**다. Ubuntu가 24.04에서 `webkit2gtk-4.0`을 걷어냈는데 Wails v2는
아직 pkg-config를 4.0으로 가리켜서, 태그 없이는 `webkit2gtk-4.0.pc not found`로 실패한다.

**크로스컴파일은 불가능하다** — Wails 리눅스 백엔드는 cgo로 시스템 웹뷰를 링크하므로 각 타깃은
그 OS에서 빌드해야 한다. 실행 측 런타임 의존은 `libwebkit2gtk-4.1-0`, `libgtk-3-0t64`,
`libsoup-3.0-0`, 그리고 **`tzdata`**다. Ubuntu 24.04+ 데스크톱에는 전부 있다
(서버/최소설치면 `sudo apt install libwebkit2gtk-4.1-0 tzdata`). tzdata가 없으면 Go의
`time.Local`이 조용히 UTC로 떨어져 **checkpoint 디코딩 타임스탬프가 9시간 어긋난 채 표시된다**
— 에러가 나지 않으므로 눈치채기 어렵다. 폰트는 한글용 `fonts-noto-cjk`,
이모지용 `fonts-noto-color-emoji`(없으면 라벨의 이모지가 ▯로 보인다).

릴리즈 리눅스 바이너리(`redis-client-linux-amd64`)는 CI가 **ubuntu-24.04**에서 빌드한다.
실행 범위를 정하는 관문이 둘 — glibc 2.34(→22.04+)와 `libwebkit2gtk-4.1.so.0`(24.04는 기본,
22.04는 SRU 백포트가 있으나 기본이 4.0 계열이라 직접 설치 필요, GTK 패키지명도 `libgtk-3-0`).

## 연결 설정

프로필에 노드 IP 목록, Redis 포트(기본 5000), Sentinel 포트(기본 26379), Master 이름(기본 `mymaster`),
Redis 비밀번호를 넣는다. Sentinel은 보통 무인증. 노드 개수는 자유 — Sentinel이 실제 토폴로지를 알려준다.
