# Covert Code Arcade

VS Code 창처럼 위장한 웹 게임입니다. 코드 편집 영역에서는 사진 맞추기 게임이,
하단 터미널에서는 2048 · Snake · Pong이 실행됩니다. 방 코드를 공유하면 두 사람이
실시간으로 대전할 수 있습니다.

[vinext](https://github.com/cloudflare/vinext)(Cloudflare Workers 위에서 도는
Next.js App Router) 기반이며, 진행 중인 대전 상태는 Durable Objects, 업로드한
사진은 Workers KV, 플레이어 전적은 D1에 저장합니다.

## 기능

- **VS Code 위장** — 파일 탐색기, 탭, 경로 표시줄, 상태바, 실제 Codicon 폰트,
  코드가 저절로 타이핑되는 연출
- **터미널 게임** — 2048, Snake, Pong
- **사진 맞추기** — Easy 5×4, Normal 6×5, Hard 8×6, 연속 매칭 콤보 점수
- **1:1 실시간 대전** — 방을 만들고 4자리 코드를 공유하면 양쪽 보드가 WebSocket으로
  동기화됩니다
- **실시간 채팅** — 텍스트와 함께 카드 사진을 골라 보낼 수 있습니다
- **사진 관리** — 게임 안에서 카드 사진을 추가·삭제할 수 있으며 비밀번호로 보호됩니다
- **계정과 랭킹** — 닉네임과 숫자 4자리로 로그인하면 승패와 상대별 전적이 기록됩니다.
  로그인 없이 게스트로도 즐길 수 있습니다

## 요구 사항

- Node.js `>=22.13.0`
- 배포하려면 Cloudflare 계정 (무료 플랜으로 충분합니다)

## 로컬에서 실행하기

```bash
npm install
cp .env.example .env
npm run dev
```

<http://localhost:3010> 을 열고, 파일 탐색기에서 **games** 폴더를 펼친 뒤 맨 위
항목을 클릭하면 사진 맞추기 게임이 실행됩니다.

`npm run dev`는 Cloudflare Vite 플러그인을 통해 앱을 `workerd` 안에서 구동하므로
Durable Objects · KV · D1이 로컬 시뮬레이션 저장소로 모두 동작합니다. 게임을
해보는 것만으로는 Cloudflare 계정이 필요 없습니다.

같은 네트워크의 다른 기기가 대전에 참가하게 하려면 모든 인터페이스에 바인딩하세요.

```bash
HOST=0.0.0.0 npm run dev
```

> `npm start`는 Cloudflare 런타임 없이 순수 Node로 서빙하기 때문에 대전 기능을
> 쓸 수 없습니다. 2인 플레이는 `npm run dev`를 사용하세요.

## 내 사진으로 플레이하기

저장소에는 자동 생성한 샘플 카드 24장이 `public/assets`에 들어 있습니다. 개인
사진을 커밋하지 않고 사용하려면:

1. `public/assets/` 에 이미지 파일을 넣습니다
2. `app/photos.local.json` 을 만들어 경로를 나열합니다
   ```json
   ["/assets/my-photo-1.jpg", "/assets/my-photo-2.jpg"]
   ```

두 경로 모두 git에서 제외됩니다. `app/photos.local.json`이 있으면 그 목록이 샘플을
대체하고, 없으면 샘플이 쓰이므로 새로 클론해도 항상 정상 동작합니다. Hard 난이도는
이미지가 최소 24장 필요합니다.

게임 안의 **Add photos** 버튼으로도 사진을 추가할 수 있습니다. 이쪽은 KV에
저장되므로 재배포 없이 바로 반영됩니다.

## Cloudflare에 배포하기

리소스를 한 번만 만들어 둡니다.

```bash
npx wrangler login
npx wrangler kv namespace create MEMORY_IMAGES
npx wrangler d1 create arcade-stats
```

출력된 id를 `.env`에 넣고(변수 이름은 `.env.example` 참고), 스키마를 적용한 뒤
배포합니다.

```bash
npx wrangler d1 execute arcade-stats --remote --file db/stats.sql
npm run deploy
```

마지막으로 사진 업로드 비밀번호를 시크릿으로 등록합니다.

```bash
npx wrangler secret put UPLOAD_PASSWORD --name <워커-이름>
```

이제 `https://<WORKER_NAME>.<서브도메인>.workers.dev` 에서 서비스됩니다.

## 동작 방식

| 대상 | 저장 위치 |
| --- | --- |
| 진행 중인 대전 상태 · 턴 · 채팅 | Durable Object `MemoryRoom`, 방 코드마다 인스턴스 하나 |
| 업로드한 사진 | Workers KV, 목록 조회 대신 인덱스 키 하나 사용 |
| 계정 · 완료된 경기 · 랭킹 | D1 (`players`, `sessions`, `matches`) |
| 기본 샘플 카드 | 정적 자산, 무료·무제한으로 제공 |

플레이어는 폴링 대신 WebSocket으로 방과 통신합니다. 그래서 아무도 움직이지 않는
방은 비용이 들지 않고, 상대의 수는 즉시 반영됩니다. 짝이 틀린 카드를 되뒤집는
처리는 Durable Object의 알람이 담당하므로, 어느 쪽 클라이언트가 연결을 유지하는지에
타이밍이 좌우되지 않습니다.

전적은 **끝까지 진행된 경기만** 기록됩니다. 중간에 나가면 결과가 남지 않으므로
연결을 끊어 패배를 피할 수 없습니다. 게스트는 자신의 전적을 남기지 않지만, 상대가
로그인한 상태라면 상대의 승패는 정상 집계되고 상대 전적에는 `Guest`와의 대전으로
표시됩니다.

## 스크립트

| 명령 | 설명 |
| --- | --- |
| `npm run dev` | Cloudflare 런타임이 붙은 로컬 개발 서버 |
| `npm run build` | `dist/` 로 프로덕션 빌드 |
| `npm start` | 빌드 결과를 순수 Node로 서빙 (대전 불가) |
| `npm run deploy` | 빌드 후 Cloudflare Workers에 배포 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | 타입 검사 + 빌드 |
| `npm run lint` | ESLint |

## 구조

```
app/            UI, 게임 로직, API 라우트
worker/         Worker 진입점과 MemoryRoom Durable Object
server/         계정, 전적 쿼리, 저장소 어댑터
db/stats.sql    D1 스키마
public/assets/  카드 이미지 (샘플은 커밋, 개인 사진은 제외)
```

## 라이선스

재사용 권한은 부여하지 않습니다. 참고용으로 공개한 코드입니다.
