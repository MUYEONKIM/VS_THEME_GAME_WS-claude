"use client";

import type React from "react";
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
  messages: Array<{ id: string; playerIndex: 0 | 1; name: string; text: string; image?: string; at: number }>;
  startedAt: number | null;
  endsAt: number | null;
  pausedBy: 0 | 1 | null;
  pausedByName: string;
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

export function ReactionGame({
  onExit,
  hidden = false,
  onHiddenChange,
}: {
  onExit: () => void;
  hidden?: boolean;
  onHiddenChange?: (hidden: boolean) => void;
}) {
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
  /** Floating score labels, shown only to whoever actually earned them. */
  const [pops, setPops] = useState<Array<{ key: string; x: number; y: number; text: string; kind: TargetKind }>>([]);
  /** Burst left behind by a circle that was just claimed, shown to both. */
  const [vanishing, setVanishing] = useState<Array<{ key: string; x: number; y: number; kind: TargetKind; image: string }>>([]);
  const [penalty, setPenalty] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatPickerOpen, setChatPickerOpen] = useState(false);
  const [chatImagePending, setChatImagePending] = useState("");
  const [imagePool, setImagePool] = useState<string[]>([]);
  const [resumeAsking, setResumeAsking] = useState(false);

  const socket = useRef<WebSocket | null>(null);
  const intent = useRef({ code: "", name: "", token: "", duration: 30_000 });
  const attempt = useRef(0);
  const reconnectTimer = useRef<number | null>(null);
  const connectRef = useRef<() => void>(() => {});
  const playerId = useRef("");
  const clockOffset = useRef(0);
  const penaltyTimer = useRef<number | null>(null);
  /** Targets already animated, so a repeated state message does not replay them. */
  const settledTargets = useRef<Set<string>>(new Set());
  const chatListRef = useRef<HTMLDivElement>(null);

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

  const addPop = useCallback((x: number, y: number, text: string, kind: TargetKind) => {
    const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    setPops((current) => [...current, { key, x, y, text, kind }]);
    window.setTimeout(() => setPops((current) => current.filter((entry) => entry.key !== key)), 620);
  }, []);

  /**
   * Runs on every state message: any target the object has just handed out
   * gets a burst on both screens, but the score label only appears for the
   * player who actually won the click.
   */
  const announceSettled = useCallback((next: ReactionRoom) => {
    const seen = settledTargets.current;
    const takenIds = Object.keys(next.taken);
    if (takenIds.length === 0) {
      seen.clear();
      return;
    }

    for (const id of takenIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const target = next.targets.find((candidate) => candidate.id === id);
      if (!target) continue;

      const key = `${id}-${Math.random().toString(36).slice(2, 6)}`;
      setVanishing((current) => [...current, { key, x: target.x, y: target.y, kind: target.kind, image: target.image }]);
      window.setTimeout(() => setVanishing((current) => current.filter((entry) => entry.key !== key)), 420);

      if (next.taken[id] !== next.playerIndex) continue;
      addPop(target.x, target.y, target.kind === "trap" ? "-1" : target.kind === "golden" ? "+2" : "+1", target.kind);
    }
  }, [addPop]);

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
        announceSettled(payload.room);
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
    if (!room?.running || room.startedAt === null || room.pausedBy !== null) return [];
    return room.targets.filter(
      (target) => now >= target.showAt && now <= target.hideAt && room.taken[target.id] === undefined,
    );
  }, [now, room]);

  // The circles use the same photo pool as the matching game.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/memory-images", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled && Array.isArray(data.images)) setImagePool(data.images);
      })
      .catch(() => {
        // Sending photos is simply unavailable until this succeeds.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Photos arrive with no height until they decode, so the list is nudged
  // again once each one loads.
  const scrollChatToBottom = useCallback(() => {
    const list = chatListRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, []);

  useEffect(() => {
    scrollChatToBottom();
    // Keyed on the newest message rather than the count: the server caps the
    // log at 80 and drops the oldest, so the count stops changing after that
    // and the chat would quietly stop following along.
  }, [scrollChatToBottom, room?.messages[room.messages.length - 1]?.id]);

  const sendChat = () => {
    if (!room) return;
    if (chatImagePending) {
      if (send({ type: "chat", image: chatImagePending })) setChatImagePending("");
      return;
    }
    const text = chatInput.trim();
    if (!text) return;
    if (send({ type: "chat", text })) setChatInput("");
  };

  // Esc drops back to the editor without closing the socket, so the opponent
  // sees a pause instead of a dropout. The clock freezes while away.
  const escapeGame = useCallback(() => {
    if (hidden) {
      onHiddenChange?.(false);
      setResumeAsking(true);
      return;
    }
    if (socket.current?.readyState === WebSocket.OPEN) send({ type: "pause" });
    setChatPickerOpen(false);
    setChatImagePending("");
    setResumeAsking(false);
    onHiddenChange?.(true);
  }, [hidden, onHiddenChange, send]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      event.preventDefault();
      escapeGame();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [escapeGame]);

  const resumeGame = () => {
    if (socket.current?.readyState === WebSocket.OPEN) send({ type: "resume" });
    setResumeAsking(false);
  };

  const flashPenalty = useCallback(() => {
    setPenalty(true);
    if (penaltyTimer.current !== null) window.clearTimeout(penaltyTimer.current);
    penaltyTimer.current = window.setTimeout(() => setPenalty(false), 420);
  }, []);

  // No optimistic label here: the score only shows once the object confirms
  // this player won the click, so losing the race never flashes a phantom +1.
  const hitTarget = (target: Target) => {
    if (!room || !room.running || room.pausedBy !== null) return;
    send({ type: "hit", id: target.id });
    if (target.kind === "trap") flashPenalty();
  };

  // Clicking anywhere that is not a circle costs a point. This one is always
  // the clicker's own doing, so the feedback can be immediate.
  const missArena = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!room?.running || room.completed || room.pausedBy !== null) return;
    if (room.startedAt !== null && now < room.startedAt) return;
    send({ type: "miss" });
    const box = event.currentTarget.getBoundingClientRect();
    addPop(
      ((event.clientX - box.left) / box.width) * 100,
      ((event.clientY - box.top) / box.height) * 100,
      "-1",
      "trap",
    );
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
    <section className={`reaction-game ${hidden ? "is-hidden" : ""}`} aria-label="Reaction click battle" aria-hidden={hidden}>
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
        <div className="reaction-arena-wrap has-chat">
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

            {vanishing.map((ghost) => (
              <div key={ghost.key} className={`reaction-vanish ${ghost.kind}`} style={{ left: `${ghost.x}%`, top: `${ghost.y}%` }} aria-hidden="true">
                <img src={ghost.image} alt="" draggable={false} />
              </div>
            ))}

            {pops.map((entry) => (
              <div key={entry.key} className={`reaction-pop ${entry.kind}`} style={{ left: `${entry.x}%`, top: `${entry.y}%` }} aria-hidden="true">
                {entry.text}
              </div>
            ))}
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

          <aside className="memory-chat" aria-label="대전 채팅">
            <header><strong>LIVE CHAT</strong><span>{room.messages.length}</span></header>
            <div className="memory-chat-list" ref={chatListRef}>
              {room.messages.length === 0 && <p>상대방에게 메시지를 보내보세요.</p>}
              {room.messages.map((message) => (
                <article key={message.id} className={message.playerIndex === room.playerIndex ? "mine" : ""}>
                  <div><b>{message.name}</b><time>{new Date(message.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>
                  {message.image
                    ? <img className="chat-photo" src={message.image} alt="보낸 사진" loading="lazy" draggable={false} onLoad={scrollChatToBottom} />
                    : <span>{message.text}</span>}
                </article>
              ))}
            </div>
            {chatPickerOpen && (
              <div className="chat-photo-picker">
                <header>
                  <span>사진 보내기</span>
                  <button type="button" onClick={() => { setChatImagePending(""); setChatPickerOpen(false); }} aria-label="사진 선택 닫기">×</button>
                </header>
                <div className="chat-photo-grid">
                  {imagePool.map((image) => (
                    <button key={image} type="button" onClick={() => { setChatImagePending(image); setChatPickerOpen(false); }} title="이 사진 고르기">
                      <img src={image} alt="" loading="lazy" draggable={false} />
                    </button>
                  ))}
                </div>
              </div>
            )}
            {chatImagePending && (
              <div className="chat-staged-photo">
                <img src={chatImagePending} alt="보낼 사진" draggable={false} />
                <button type="button" onClick={() => setChatImagePending("")} aria-label="선택한 사진 취소">×</button>
              </div>
            )}
            <form onSubmit={(event) => { event.preventDefault(); sendChat(); }}>
              <button
                type="button"
                className={`chat-photo-toggle ${chatPickerOpen ? "active" : ""}`}
                onClick={() => { setChatImagePending(""); setChatPickerOpen((open) => !open); }}
                aria-expanded={chatPickerOpen}
                title="사진 보내기"
              >
                🖼
              </button>
              <input
                value={chatInput}
                maxLength={160}
                placeholder={chatImagePending ? "Send를 누르면 사진이 전송됩니다" : "메시지를 입력하세요"}
                onChange={(event) => setChatInput(event.target.value)}
              />
              <button type="submit" disabled={!chatInput.trim() && !chatImagePending}>Send</button>
            </form>
          </aside>
        </div>
      )}

      {room && room.pausedBy !== null && room.pausedBy !== room.playerIndex && (
        <div className="memory-pause-overlay" role="dialog" aria-modal="true" aria-label="일시중지">
          <div>
            <span className="pause-bars" aria-hidden="true"><i /><i /></span>
            <strong>일시중지중입니다</strong>
            <p>{room.pausedByName || "상대방"}님이 잠시 자리를 비웠습니다. 남은 시간은 멈춰 있습니다.</p>
          </div>
        </div>
      )}

      {resumeAsking && (
        <div className="memory-pause-overlay" role="dialog" aria-modal="true" aria-label="게임 재개 확인">
          <div>
            <strong>게임을 다시 재개하시겠습니까?</strong>
            <p>Esc를 누르면 언제든 다시 편집기 화면으로 빠져나갈 수 있습니다.</p>
            <div className="pause-actions">
              <button type="button" onClick={() => { setResumeAsking(false); onHiddenChange?.(true); }}>No</button>
              <button type="button" className="primary" onClick={resumeGame}>Yes</button>
            </div>
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
