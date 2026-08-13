"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

type Account = { id: string; nickname: string };

type TargetKind = "normal" | "golden" | "trap";

type Target = {
  id: string;
  image: string;
  kind: TargetKind;
  x: number;
  y: number;
  showAt: number;
  hideAt: number;
};

type ReactionRoom = {
  code: string;
  durationMs: number;
  players: Array<{ name: string; guest: boolean }>;
  playerIndex: number;
  scores: [number, number];
  targets: Target[];
  taken: Record<string, 0 | 1>;
  startedAt: number | null;
  endsAt: number | null;
  running: boolean;
  completed: boolean;
  waiting: boolean;
  isHost: boolean;
  serverNow: number;
};

const SESSION_STORAGE_KEY = "memory-session-token";
const PLAYER_STORAGE_KEY = "reaction-player-id";
const MAX_RECONNECT_ATTEMPTS = 6;

const DURATIONS = [
  { ms: 10_000, label: "10초" },
  { ms: 30_000, label: "30초" },
  { ms: 60_000, label: "1분" },
] as const;

const KIND_LABEL: Record<TargetKind, string> = {
  normal: "CLICK!",
  golden: "×2",
  trap: "NO CLICK!",
};

function createPlayerId() {
  if (typeof window.crypto?.randomUUID === "function") return window.crypto.randomUUID();
  return `rx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function ReactionGame({ onExit }: { onExit: () => void }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [sessionToken, setSessionToken] = useState("");
  const [playAsGuest, setPlayAsGuest] = useState(false);
  const [nickname, setNickname] = useState("");
  const [loginCode, setLoginCode] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authMessage, setAuthMessage] = useState("");

  const [room, setRoom] = useState<ReactionRoom | null>(null);
  const [roomInput, setRoomInput] = useState("");
  const [duration, setDuration] = useState<number>(30_000);
  const [networkError, setNetworkError] = useState("");
  const [connecting, setConnecting] = useState(false);
  // Ticks the render loop; the authoritative clock is the server's.
  const [now, setNow] = useState(() => Date.now());
  const [pop, setPop] = useState<{ id: string; kind: TargetKind; seat: 0 | 1 } | null>(null);
  const [penalty, setPenalty] = useState(false);

  const socket = useRef<WebSocket | null>(null);
  const intent = useRef({ code: "", name: "", token: "", duration: 30_000 });
  const attempt = useRef(0);
  const reconnectTimer = useRef<number | null>(null);
  const connectRef = useRef<() => void>(() => {});
  const playerId = useRef("");
  const clockOffset = useRef(0);
  const popTimer = useRef<number | null>(null);
  const penaltyTimer = useRef<number | null>(null);

  const getPlayerId = useCallback(() => {
    if (playerId.current) return playerId.current;
    let stored = "";
    try {
      stored = window.sessionStorage.getItem(PLAYER_STORAGE_KEY) || "";
    } catch {
      // Private modes disable session storage; the in-memory id still works.
    }
    const next = stored || createPlayerId();
    try {
      window.sessionStorage.setItem(PLAYER_STORAGE_KEY, next);
    } catch {
      // Nothing to persist; the seat just will not survive a reload.
    }
    playerId.current = next;
    return next;
  }, []);

  useEffect(() => {
    let stored = "";
    try {
      stored = window.localStorage.getItem(SESSION_STORAGE_KEY) || "";
    } catch {
      // Sign-in simply starts empty when storage is unavailable.
    }
    if (!stored) return;
    let cancelled = false;
    fetch("/api/auth", { headers: { "x-session-token": stored }, cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (cancelled || !data.player) return;
        setAccount(data.player);
        setSessionToken(stored);
        setNickname(data.player.nickname);
      })
      .catch(() => {
        // An offline start just shows the sign-in form.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A single rAF loop drives every circle's appear/disappear animation.
  useEffect(() => {
    if (!room?.running) return;
    let frame = 0;
    const tick = () => {
      setNow(Date.now() + clockOffset.current);
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [room?.running]);

  const disconnect = useCallback(() => {
    if (reconnectTimer.current !== null) {
      window.clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    intent.current.code = "";
    const current = socket.current;
    socket.current = null;
    if (!current) return;
    current.onopen = null;
    current.onmessage = null;
    current.onclose = null;
    current.close();
  }, []);

  const connect = useCallback(() => {
    const plan = intent.current;
    const url = new URL("/api/reaction/ws", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("code", plan.code || "NEW");
    url.searchParams.set("playerId", getPlayerId());
    url.searchParams.set("name", plan.name);
    url.searchParams.set("duration", String(plan.duration));
    if (plan.token) url.searchParams.set("token", plan.token);

    const next = new WebSocket(url);
    socket.current = next;

    next.onopen = () => {
      attempt.current = 0;
      setConnecting(false);
      setNetworkError("");
    };

    next.onmessage = (event) => {
      let payload: { type?: string; room?: ReactionRoom; message?: string };
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (payload.type === "state" && payload.room) {
        // Trust the object's clock so both screens agree on timings.
        clockOffset.current = payload.room.serverNow - Date.now();
        intent.current.code = payload.room.code;
        setRoom(payload.room);
        setDuration(payload.room.durationMs);
        setNetworkError("");
      } else if (payload.type === "error") {
        setNetworkError(payload.message || "요청이 거부되었습니다.");
      }
    };

    next.onclose = (event) => {
      if (socket.current !== next) return;
      socket.current = null;
      setConnecting(false);
      if (event.code >= 4000) {
        intent.current.code = "";
        setRoom(null);
        setNetworkError(event.reason || "방을 사용할 수 없습니다.");
        return;
      }
      if (!intent.current.code || attempt.current >= MAX_RECONNECT_ATTEMPTS) {
        setNetworkError("Connection lost. Reopen the room to try again.");
        return;
      }
      const delay = Math.min(1000 * 2 ** attempt.current, 8000);
      attempt.current += 1;
      setNetworkError("Connection lost. Reconnecting…");
      reconnectTimer.current = window.setTimeout(() => {
        reconnectTimer.current = null;
        connectRef.current();
      }, delay);
    };
  }, [getPlayerId]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => disconnect, [disconnect]);

  const send = useCallback((payload: Record<string, unknown>) => {
    const current = socket.current;
    if (!current || current.readyState !== WebSocket.OPEN) {
      setNetworkError("Connection lost. Reconnecting…");
      return false;
    }
    current.send(JSON.stringify(payload));
    return true;
  }, []);

  const submitLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = nickname.trim();
    if (!name || loginCode.length !== 4) return;
    setAuthBusy(true);
    setAuthMessage("");
    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname: name, code: loginCode }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "로그인하지 못했습니다.");
      setAccount(data.player);
      setSessionToken(data.token);
      setNickname(data.player.nickname);
      setLoginCode("");
      try {
        window.localStorage.setItem(SESSION_STORAGE_KEY, data.token);
      } catch {
        // The session still works for this tab.
      }
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : "로그인하지 못했습니다.");
    } finally {
      setAuthBusy(false);
    }
  };

  const openRoom = (code: string) => {
    disconnect();
    attempt.current = 0;
    intent.current = {
      code,
      name: account?.nickname ?? (nickname.trim() || "Guest"),
      token: sessionToken,
      duration,
    };
    setConnecting(true);
    setNetworkError("");
    connect();
  };

  const visibleTargets = useMemo(() => {
    if (!room?.running || room.startedAt === null) return [];
    return room.targets.filter(
      (target) => now >= target.showAt && now <= target.hideAt && room.taken[target.id] === undefined,
    );
  }, [now, room]);

  const flashPenalty = useCallback(() => {
    setPenalty(true);
    if (penaltyTimer.current !== null) window.clearTimeout(penaltyTimer.current);
    penaltyTimer.current = window.setTimeout(() => setPenalty(false), 420);
  }, []);

  const hitTarget = (target: Target) => {
    if (!room || !room.running) return;
    send({ type: "hit", id: target.id });
    setPop({ id: target.id, kind: target.kind, seat: room.playerIndex as 0 | 1 });
    if (popTimer.current !== null) window.clearTimeout(popTimer.current);
    popTimer.current = window.setTimeout(() => setPop(null), 520);
    if (target.kind === "trap") flashPenalty();
  };

  // Clicking anywhere that is not a circle costs a point.
  const missArena = () => {
    if (!room?.running || room.completed) return;
    if (room.startedAt !== null && now < room.startedAt) return;
    send({ type: "miss" });
    setPop({ id: "miss", kind: "trap", seat: room.playerIndex as 0 | 1 });
    if (popTimer.current !== null) window.clearTimeout(popTimer.current);
    popTimer.current = window.setTimeout(() => setPop(null), 520);
    flashPenalty();
  };

  const secondsLeft = room?.endsAt && room.running ? Math.max(0, Math.ceil((room.endsAt - now) / 1000)) : null;
  const countdown =
    room?.startedAt && room.running && now < room.startedAt
      ? Math.max(1, Math.ceil((room.startedAt - now) / 1000))
      : null;

  const names = [room?.players[0]?.name || "PLAYER 1", room?.players[1]?.name || "WAITING"];
  const mySeat = room?.playerIndex ?? 0;
  const winner = room ? (room.scores[0] === room.scores[1] ? -1 : room.scores[0] > room.scores[1] ? 0 : 1) : -1;

  return (
    <section className="reaction-game" aria-label="Reaction click battle">
      <header className="memory-toolbar">
        <div className="memory-heading">
          <strong>latency-probe.bench.ts</strong>
        </div>
        <div className="memory-scoreboard" aria-live="polite">
          <span className={mySeat === 0 ? "turn-active" : ""}><small>{names[0]}</small><b>{room?.scores[0] ?? 0}</b></span>
          <i>:</i>
          <span className={mySeat === 1 ? "turn-active" : ""}><small>{names[1]}</small><b>{room?.scores[1] ?? 0}</b></span>
        </div>
        <div className="memory-stats">
          <span>TIME <b>{secondsLeft === null ? `${duration / 1000}s` : `${secondsLeft}s`}</b></span>
          <span>ROOM <b>{room?.code ?? "—"}</b></span>
        </div>
        <div className="memory-actions">
          <div className="difficulty-switch" aria-label="게임 시간">
            {DURATIONS.map((option) => (
              <button
                key={option.ms}
                className={duration === option.ms ? "active" : ""}
                onClick={() => setDuration(option.ms)}
                disabled={Boolean(room && !room.completed && room.running)}
              >
                {option.label}
              </button>
            ))}
          </div>
          {room?.isHost && !room.waiting && (!room.running || room.completed) && (
            <button className="memory-plain-button" onClick={() => send({ type: "start", duration })}>
              {room.completed ? "Play again" : "Start"}
            </button>
          )}
          <button className="memory-plain-button" onClick={onExit}>Close</button>
        </div>
      </header>

      {!room && !account && !playAsGuest ? (
        <div className="memory-lobby">
          <div className="lobby-signin">
            <small>PLAYER SIGN IN</small>
            <strong>REACTION BATTLE</strong>
            <p>먼저 누르는 사람이 점수를 가져갑니다. 로그인하면 승패가 랭킹에 기록됩니다.</p>
            <form onSubmit={submitLogin}>
              <label>
                닉네임 (ID)
                <input value={nickname} maxLength={18} placeholder="닉네임" autoComplete="username" onChange={(event) => { setNickname(event.target.value); setAuthMessage(""); }} />
              </label>
              <label>
                비밀번호 (숫자 4자리)
                <input type="password" inputMode="numeric" maxLength={4} value={loginCode} placeholder="0000" autoComplete="current-password" onChange={(event) => { setLoginCode(event.target.value.replace(/\D/g, "").slice(0, 4)); setAuthMessage(""); }} />
              </label>
              <button type="submit" className="lobby-create lobby-signin-submit" disabled={authBusy || !nickname.trim() || loginCode.length !== 4}>
                {authBusy ? "확인 중…" : "로그인 / 가입"}
              </button>
            </form>
            {authMessage && <em>{authMessage}</em>}
            <div className="lobby-divider"><span>or</span></div>
            <button className="lobby-guest" onClick={() => setPlayAsGuest(true)}>guest로 게임하기</button>
          </div>
        </div>
      ) : !room ? (
        <div className="memory-lobby">
          <div>
            <small>CLICK RACE</small>
            <strong>REACTION BATTLE</strong>
            <p>원이 뜨면 먼저 클릭하세요. 황금 원은 2점, NO CLICK! 원을 누르면 1점을 잃습니다.</p>
            {account ? (
              <div className="lobby-account"><span><b>{account.nickname}</b>로 로그인됨</span></div>
            ) : (
              <div className="lobby-account guest">
                <span>게스트로 진행 중 · 내 전적은 기록되지 않습니다</span>
                <button type="button" onClick={() => setPlayAsGuest(false)}>로그인하기</button>
              </div>
            )}
            {!account && (
              <label>
                닉네임을 적어주세요
                <input value={nickname} maxLength={18} placeholder="닉네임을 적어주세요" onChange={(event) => setNickname(event.target.value)} />
              </label>
            )}
            <div className="lobby-difficulty">
              <span>게임 시간</span>
              <div role="group" aria-label="게임 시간">
                {DURATIONS.map((option) => (
                  <button type="button" key={option.ms} className={duration === option.ms ? "active" : ""} onClick={() => setDuration(option.ms)} disabled={connecting}>
                    <b>{option.label}</b>
                  </button>
                ))}
              </div>
            </div>
            <button className="lobby-create" onClick={() => openRoom("")} disabled={connecting || (!account && !nickname.trim())}>
              Create room · {DURATIONS.find((d) => d.ms === duration)?.label}
            </button>
            <div className="lobby-divider"><span>or join</span></div>
            <div className="lobby-join">
              <input
                value={roomInput}
                maxLength={4}
                placeholder="ROOM"
                onChange={(event) => setRoomInput(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                onKeyDown={(event) => { if (event.key === "Enter" && roomInput.length === 4) openRoom(roomInput); }}
              />
              <button onClick={() => openRoom(roomInput)} disabled={connecting || roomInput.length !== 4 || (!account && !nickname.trim())}>Join</button>
            </div>
            {networkError && <em>{networkError}</em>}
          </div>
        </div>
      ) : room.waiting ? (
        <div className="memory-room-waiting">
          <div role="dialog" aria-modal="true" aria-label="상대 대기 중">
            <span className="waiting-spinner" aria-hidden="true" />
            <small>ROOM CREATED</small>
            <strong>WAITING FOR OPPONENT</strong>
            <p>상대방에게 아래 방 코드를 알려주세요.</p>
            <button className="waiting-room-code" onClick={() => navigator.clipboard?.writeText(room.code).catch(() => {})}>{room.code}</button>
            <span className="waiting-difficulty">{DURATIONS.find((d) => d.ms === room.durationMs)?.label}</span>
            {networkError && <i>{networkError}</i>}
            <button className="waiting-cancel" onClick={() => { disconnect(); setRoom(null); }}>Cancel room</button>
          </div>
        </div>
      ) : (
        <div className="reaction-arena-wrap">
          <div className={`reaction-arena ${penalty ? "penalised" : ""}`} aria-label="클릭 영역" onPointerDown={missArena}>
            {visibleTargets.map((target) => {
              const life = (now - target.showAt) / (target.hideAt - target.showAt);
              return (
                <button
                  key={target.id}
                  type="button"
                  className={`reaction-target ${target.kind}`}
                  style={{ left: `${target.x}%`, top: `${target.y}%`, ["--life" as string]: String(Math.min(1, Math.max(0, life))) }}
                  onPointerDown={(event) => { event.stopPropagation(); hitTarget(target); }}
                  aria-label={KIND_LABEL[target.kind]}
                >
                  <img src={target.image} alt="" draggable={false} />
                  <span>{KIND_LABEL[target.kind]}</span>
                </button>
              );
            })}

            {pop && <div className={`reaction-pop ${pop.kind}`} aria-hidden="true">{pop.kind === "trap" ? "-1" : pop.kind === "golden" ? "+2" : "+1"}</div>}
            {penalty && <div className="reaction-penalty" role="status"><span>MISS −1</span></div>}

            {countdown !== null && (
              <div className="reaction-countdown" role="status"><b>{countdown}</b><small>READY</small></div>
            )}

            {!room.running && !room.completed && (
              <div className="reaction-idle" role="status">
                <strong>준비 완료</strong>
                <p>{room.isHost ? "위의 Start를 누르면 시작합니다." : "방장이 시작하기를 기다리는 중…"}</p>
              </div>
            )}

            {room.completed && (
              <div className="memory-complete" role="dialog" aria-label="결과">
                <div>
                  <small>TIME UP</small>
                  <strong>{winner < 0 ? "DRAW" : winner === mySeat ? "YOU WIN" : `${names[winner]} WINS`}</strong>
                  <p>{names[0]} {room.scores[0]} : {room.scores[1]} {names[1]}</p>
                  {room.isHost ? (
                    <button onClick={() => send({ type: "start", duration })}>Play again · {DURATIONS.find((d) => d.ms === duration)?.label}</button>
                  ) : (
                    <em className="rematch-waiting">방장이 다시 시작하기를 기다리는 중…</em>
                  )}
                  <button onClick={onExit}>Return to editor</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <footer className="memory-footer">
        <span>먼저 클릭한 사람이 득점 · 황금 원 +2 · NO CLICK! 원 −1 · 빈 곳 클릭 −1 (최소 0점)</span>
        <span>{networkError || (room ? `ROOM ${room.code} · ${DURATIONS.find((d) => d.ms === room.durationMs)?.label}` : "")}</span>
      </footer>
    </section>
  );
}
