"use client";

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  buildSortRound,
  normalizeSortDifficulty,
  SORT_DIFFICULTIES,
  SORT_DURATIONS,
  SORT_LEAD_IN,
  SORT_PENALTY,
  SORT_SCORE,
  type SortDifficulty,
  type SortRound,
  sideFor,
} from "./sort-schedule";

type Account = { id: string; nickname: string };

type Room = {
  code: string;
  durationMs: number;
  difficulty: SortDifficulty;
  players: Array<{ name: string; guest: boolean }>;
  playerIndex: number;
  scores: [number, number];
  progress: [number, number];
  hits: [number, number];
  misses: [number, number];
  roundKey: number;
  round: SortRound | null;
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

type SoloRun = {
  round: SortRound;
  index: number;
  score: number;
  hits: number;
  misses: number;
  startedAt: number;
  endsAt: number;
};

type GameMode = "solo" | "versus";

const SESSION_STORAGE_KEY = "memory-session-token";
const PLAYER_STORAGE_KEY = "sort-player-id";
const BEST_STORAGE_KEY = "sort-best-scores";
const MAX_RECONNECT_ATTEMPTS = 6;
/** How many upcoming characters are drawn behind the current one. */
const LANE_PREVIEW = 7;

const DURATION_LABELS: Record<number, string> = { 30000: "30초", 60000: "60초", 90000: "90초" };

function createPlayerId() {
  if (typeof window.crypto?.randomUUID === "function") return window.crypto.randomUUID();
  return `st-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function readBestScores(): Record<string, number> {
  try {
    return JSON.parse(window.localStorage.getItem(BEST_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

export function SortGame({
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

  const [gameMode, setGameMode] = useState<GameMode>("solo");
  const [room, setRoom] = useState<Room | null>(null);
  const [solo, setSolo] = useState<SoloRun | null>(null);
  const [roomInput, setRoomInput] = useState("");
  const [difficulty, setDifficulty] = useState<SortDifficulty>("easy");
  const [duration, setDuration] = useState<number>(30_000);
  const [networkError, setNetworkError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [flash, setFlash] = useState<"correct" | "wrong" | null>(null);
  const [bestScores, setBestScores] = useState<Record<string, number>>({});
  const [imagePool, setImagePool] = useState<string[]>([]);

  const [chatInput, setChatInput] = useState("");
  const [chatPickerOpen, setChatPickerOpen] = useState(false);
  const [chatImagePending, setChatImagePending] = useState("");
  const [resumeAsking, setResumeAsking] = useState(false);

  const socket = useRef<WebSocket | null>(null);
  const intent = useRef({ code: "", name: "", token: "", duration: 30_000, difficulty: "easy" as SortDifficulty });
  const attempt = useRef(0);
  const reconnectTimer = useRef<number | null>(null);
  const connectRef = useRef<() => void>(() => {});
  const playerId = useRef("");
  const clockOffset = useRef(0);
  const flashTimer = useRef<number | null>(null);
  const cachedRound = useRef<{ key: number; round: SortRound } | null>(null);
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
      // The seat just will not survive a reload.
    }
    playerId.current = next;
    return next;
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBestScores(readBestScores());
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/memory-images", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled && Array.isArray(data.images)) setImagePool(data.images);
      })
      .catch(() => {
        // Practice simply waits until the photo list is available.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let stored = "";
    try {
      stored = window.localStorage.getItem(SESSION_STORAGE_KEY) || "";
    } catch {
      // Sign-in starts empty when storage is unavailable.
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

  // Timer alongside rAF: browsers suspend rAF entirely on a hidden tab, which
  // would leave the clock frozen until the player came back.
  useEffect(() => {
    if (!room?.running && !solo) return;
    const advance = () => setNow(Date.now() + clockOffset.current);
    let frame = window.requestAnimationFrame(function tick() {
      advance();
      frame = window.requestAnimationFrame(tick);
    });
    const timer = window.setInterval(advance, 100);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearInterval(timer);
    };
  }, [room?.running, solo]);

  useEffect(() => {
    const list = chatListRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [room?.messages[room.messages.length - 1]?.id]);

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
    const url = new URL("/api/sort/ws", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("code", plan.code || "NEW");
    url.searchParams.set("playerId", getPlayerId());
    url.searchParams.set("name", plan.name);
    url.searchParams.set("duration", String(plan.duration));
    url.searchParams.set("difficulty", plan.difficulty);
    if (plan.token) url.searchParams.set("token", plan.token);

    const next = new WebSocket(url);
    socket.current = next;

    next.onopen = () => {
      attempt.current = 0;
      setConnecting(false);
      setNetworkError("");
    };

    next.onmessage = (event) => {
      let payload: { type?: string; room?: Room; message?: string };
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (payload.type === "state" && payload.room) {
        clockOffset.current = payload.room.serverNow - Date.now();
        intent.current.code = payload.room.code;
        // The queue only travels when a round is planned; keep the cached copy
        // for the small updates that follow every answer.
        if (payload.room.round) {
          cachedRound.current = { key: payload.room.roundKey, round: payload.room.round };
        } else if (cachedRound.current?.key === payload.room.roundKey) {
          payload.room.round = cachedRound.current.round;
        }
        setRoom(payload.room);
        setDuration(payload.room.durationMs);
        setDifficulty(payload.room.difficulty);
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
      difficulty,
    };
    setConnecting(true);
    setNetworkError("");
    connect();
  };

  const flashResult = useCallback((correct: boolean) => {
    setFlash(correct ? "correct" : "wrong");
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 260);
  }, []);

  const soloFinished = solo !== null && now >= solo.endsAt;
  const soloRunning = solo !== null && !soloFinished;

  const startSolo = () => {
    const startedAt = Date.now() + SORT_LEAD_IN;
    setSolo({
      round: buildSortRound(imagePool.length > 0 ? imagePool : [""], difficulty, duration),
      index: 0,
      score: 0,
      hits: 0,
      misses: 0,
      startedAt,
      endsAt: startedAt + duration,
    });
  };

  useEffect(() => {
    if (!soloFinished || !solo) return;
    const key = `${difficulty}-${duration}`;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBestScores((current) => {
      if ((current[key] ?? -1) >= solo.score) return current;
      const next = { ...current, [key]: solo.score };
      try {
        window.localStorage.setItem(BEST_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // The best score simply is not kept between visits.
      }
      return next;
    });
  }, [soloFinished, solo, difficulty, duration]);

  const round = solo ? solo.round : room?.round ?? null;
  const seat = room?.playerIndex ?? 0;
  const myIndex = solo ? solo.index : room?.progress[seat] ?? 0;
  const roundLive = solo
    ? soloRunning && now >= solo.startedAt
    : Boolean(room?.running && !room.completed && room.pausedBy === null && room.startedAt !== null && now >= room.startedAt);

  const answer = (direction: "left" | "right") => {
    if (!round || !roundLive) return;
    const image = round.queue[myIndex];
    if (!image) return;
    const correct = sideFor(round, image) === direction;
    flashResult(correct);

    if (solo) {
      setSolo((current) => (current ? {
        ...current,
        index: current.index + 1,
        score: Math.max(0, current.score + (correct ? SORT_SCORE : SORT_PENALTY)),
        hits: current.hits + (correct ? 1 : 0),
        misses: current.misses + (correct ? 0 : 1),
      } : current));
      return;
    }
    send({ type: "answer", direction });
  };

  // Esc keeps the room alive and only hides the screen, so the opponent sees a
  // pause rather than a dropout.
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
      const target = event.target as HTMLElement | null;
      const typing = target && /^(INPUT|TEXTAREA)$/.test(target.tagName);
      if (event.key === "Escape") {
        if (typing) return;
        event.preventDefault();
        escapeGame();
        return;
      }
      if (typing || hidden) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        answer("left");
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        answer("right");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const resumeGame = () => {
    if (socket.current?.readyState === WebSocket.OPEN) send({ type: "resume" });
    setResumeAsking(false);
  };

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

  const endsAt = solo ? solo.endsAt : room?.endsAt ?? null;
  const startedAt = solo ? solo.startedAt : room?.startedAt ?? null;
  const secondsLeft = endsAt !== null && (solo || room?.running) ? Math.max(0, Math.ceil((endsAt - now) / 1000)) : null;
  const countdown = startedAt !== null && (solo || room?.running) && now < startedAt
    ? Math.max(1, Math.ceil((startedAt - now) / 1000))
    : null;
  const timeRatio = endsAt !== null && startedAt !== null && endsAt > startedAt
    ? Math.min(1, Math.max(0, (endsAt - now) / (endsAt - startedAt)))
    : 1;

  const names = [room?.players[0]?.name || "PLAYER 1", room?.players[1]?.name || "WAITING"];
  const bestKey = `${difficulty}-${duration}`;
  const best = bestScores[bestKey] ?? 0;
  const myScore = solo ? solo.score : room?.scores[seat] ?? 0;
  const accuracy = solo && solo.hits + solo.misses > 0 ? Math.round((solo.hits / (solo.hits + solo.misses)) * 100) : 0;
  const winner = room ? (room.scores[0] === room.scores[1] ? -1 : room.scores[0] > room.scores[1] ? 0 : 1) : -1;

  const lane = round ? round.queue.slice(myIndex, myIndex + LANE_PREVIEW) : [];

  const arena = (
    <div className={`sort-arena ${flash ? `flash-${flash}` : ""}`}>
      <div className="sort-side left" aria-label="왼쪽으로 보낼 캐릭터">
        {round?.left.map((image, index) => (
          <figure key={`${image}-${index}`}><img src={image} alt="" draggable={false} /></figure>
        ))}
      </div>

      <div className="sort-lane" aria-label="분류할 캐릭터">
        {lane.slice().reverse().map((image, reverseIndex) => {
          const depth = lane.length - 1 - reverseIndex;
          return (
            <figure key={`${myIndex + depth}-${image}`} className={depth === 0 ? "current" : ""} style={{ ["--depth" as string]: String(depth) }}>
              <img src={image} alt="" draggable={false} />
            </figure>
          );
        })}
        {lane.length === 0 && roundLive && <p className="sort-lane-empty">대기 중…</p>}

        {countdown !== null && (
          <div className="reaction-countdown" role="status"><b>{countdown}</b><small>READY</small></div>
        )}
      </div>

      <div className="sort-side right" aria-label="오른쪽으로 보낼 캐릭터">
        {round?.right.map((image, index) => (
          <figure key={`${image}-${index}`}><img src={image} alt="" draggable={false} /></figure>
        ))}
      </div>

      <div className="sort-controls">
        <button type="button" className="sort-arrow" onClick={() => answer("left")} disabled={!roundLive} aria-label="왼쪽으로 보내기">←</button>
        <div className="sort-timer" aria-label="남은 시간">
          <i style={{ transform: `scaleX(${timeRatio})` }} />
          <span>{secondsLeft === null ? `${duration / 1000}s` : `${secondsLeft}`}</span>
        </div>
        <button type="button" className="sort-arrow" onClick={() => answer("right")} disabled={!roundLive} aria-label="오른쪽으로 보내기">→</button>
      </div>
    </div>
  );

  return (
    <section className={`reaction-game sort-game ${hidden ? "is-hidden" : ""}`} aria-label="Left right sorting battle" aria-hidden={hidden}>
      <header className="memory-toolbar">
        <div className="memory-heading">
          <strong>router-split.spec.ts</strong>
          <div className="memory-mode-switch" aria-label="게임 모드">
            <button className={gameMode === "solo" ? "active" : ""} onClick={() => { disconnect(); setRoom(null); setGameMode("solo"); }}>PRACTICE</button>
            <button className={gameMode === "versus" ? "active" : ""} onClick={() => { setSolo(null); setGameMode("versus"); }}>VERSUS</button>
          </div>
        </div>
        <div className="memory-scoreboard" aria-live="polite">
          {gameMode === "solo" ? (
            <>
              <span className="turn-active"><small>SCORE</small><b>{myScore}</b></span>
              <i>/</i>
              <span><small>BEST</small><b>{best}</b></span>
            </>
          ) : (
            <>
              <span className={seat === 0 ? "turn-active" : ""}><small>{names[0]}</small><b>{room?.scores[0] ?? 0}</b></span>
              <i>:</i>
              <span className={seat === 1 ? "turn-active" : ""}><small>{names[1]}</small><b>{room?.scores[1] ?? 0}</b></span>
            </>
          )}
        </div>
        <div className="memory-stats">
          <span>TIME <b>{secondsLeft === null ? `${duration / 1000}s` : `${secondsLeft}s`}</b></span>
          {gameMode === "solo"
            ? <span>SENT <b>{myIndex}</b></span>
            : <span>ROOM <b>{room?.code ?? "—"}</b></span>}
        </div>
        <div className="memory-actions">
          <div className="difficulty-switch" aria-label="난이도">
            {(Object.keys(SORT_DIFFICULTIES) as SortDifficulty[]).map((level) => (
              <button
                key={level}
                className={difficulty === level ? "active" : ""}
                onClick={() => setDifficulty(level)}
                disabled={soloRunning || Boolean(room && room.running && !room.completed)}
              >
                {SORT_DIFFICULTIES[level].label}
                <small>{SORT_DIFFICULTIES[level].types}종</small>
              </button>
            ))}
          </div>
          <div className="difficulty-switch" aria-label="제한 시간">
            {SORT_DURATIONS.map((ms) => (
              <button
                key={ms}
                className={duration === ms ? "active" : ""}
                onClick={() => setDuration(ms)}
                disabled={soloRunning || Boolean(room && room.running && !room.completed)}
              >
                {DURATION_LABELS[ms]}
              </button>
            ))}
          </div>
          {gameMode === "solo" && !soloRunning && (
            <button className="memory-plain-button" onClick={startSolo}>{solo ? "Try again" : "Start"}</button>
          )}
          {gameMode === "solo" && soloRunning && (
            <button className="memory-plain-button" onClick={() => setSolo(null)}>Stop</button>
          )}
          {gameMode === "versus" && room?.isHost && !room.waiting && (!room.running || room.completed) && (
            <button className="memory-plain-button" onClick={() => send({ type: "start", duration, difficulty })}>
              {room.completed ? "Play again" : "Start"}
            </button>
          )}
          <button className="memory-plain-button" onClick={onExit}>Close</button>
        </div>
      </header>

      {gameMode === "solo" ? (
        <div className="reaction-arena-wrap">
          <div className="sort-stage">
            {arena}
            {!solo && (
              <div className="reaction-idle" role="status">
                <strong>연습 모드</strong>
                <p>가운데 캐릭터를 왼쪽/오른쪽 목록에 맞는 방향으로 보내세요. ← → 키도 됩니다.</p>
                <p>전적에는 기록되지 않습니다.</p>
              </div>
            )}
            {soloFinished && solo && (
              <div className="memory-complete" role="dialog" aria-label="연습 결과">
                <div>
                  <small>PRACTICE DONE</small>
                  <strong>{solo.score}점</strong>
                  <div className="solo-stats">
                    <span><b>{solo.hits}</b><small>정답</small></span>
                    <span><b>{solo.misses}</b><small>오답</small></span>
                    <span><b>{accuracy}%</b><small>정확도</small></span>
                  </div>
                  <p>{solo.score >= best ? "최고 기록을 세웠습니다!" : `최고 기록 ${best}점`}</p>
                  <button onClick={startSolo}>다시 연습 · {SORT_DIFFICULTIES[difficulty].label} {DURATION_LABELS[duration]}</button>
                  <button onClick={() => setGameMode("versus")}>대전하러 가기</button>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : !room && !account && !playAsGuest ? (
        <div className="memory-lobby">
          <div className="lobby-signin">
            <small>PLAYER SIGN IN</small>
            <strong>SORTING BATTLE</strong>
            <p>캐릭터를 좌우로 빠르게 분류하는 게임입니다. 로그인하면 승패가 랭킹에 기록됩니다.</p>
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
            <small>TWO BUTTON PUZZLE</small>
            <strong>SORTING BATTLE</strong>
            <p>같은 문제를 함께 풀고, 제한 시간 안에 더 많이 맞춘 쪽이 이깁니다. 틀리면 1점을 잃습니다.</p>
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
              <span>난이도 · 제한 시간</span>
              <div role="group" aria-label="난이도">
                {(Object.keys(SORT_DIFFICULTIES) as SortDifficulty[]).map((level) => (
                  <button type="button" key={level} className={difficulty === level ? "active" : ""} onClick={() => setDifficulty(level)} disabled={connecting}>
                    <b>{SORT_DIFFICULTIES[level].label}</b>
                    <small>{SORT_DIFFICULTIES[level].types}종</small>
                  </button>
                ))}
              </div>
              <div role="group" aria-label="제한 시간">
                {SORT_DURATIONS.map((ms) => (
                  <button type="button" key={ms} className={duration === ms ? "active" : ""} onClick={() => setDuration(ms)} disabled={connecting}>
                    <b>{DURATION_LABELS[ms]}</b>
                  </button>
                ))}
              </div>
            </div>
            <button className="lobby-create" onClick={() => openRoom("")} disabled={connecting || (!account && !nickname.trim())}>
              Create room · {SORT_DIFFICULTIES[difficulty].label} {DURATION_LABELS[duration]}
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
            <span className="waiting-difficulty">{SORT_DIFFICULTIES[room.difficulty].label} · {DURATION_LABELS[room.durationMs]}</span>
            {networkError && <i>{networkError}</i>}
            <button className="waiting-cancel" onClick={() => { disconnect(); setRoom(null); }}>Cancel room</button>
          </div>
        </div>
      ) : (
        <div className="reaction-arena-wrap has-chat">
          <div className="sort-stage">
            {arena}

            {/* The opponent's lane is drawn from data the room already sends,
                so watching them costs no extra traffic. */}
            {round && (
              <aside className="sort-opponent" aria-label={`${names[seat === 0 ? 1 : 0]}의 화면`}>
                <header>
                  <span>{names[seat === 0 ? 1 : 0]}</span>
                  <b>{room.scores[seat === 0 ? 1 : 0]}</b>
                </header>
                <div className="sort-opponent-lane">
                  {round.queue.slice(room.progress[seat === 0 ? 1 : 0], room.progress[seat === 0 ? 1 : 0] + 4).map((image, index) => (
                    <figure key={`${index}-${image}`} className={index === 0 ? "current" : ""} style={{ ["--depth" as string]: String(index) }}>
                      <img src={image} alt="" draggable={false} />
                    </figure>
                  ))}
                </div>
                <footer>보낸 {room.progress[seat === 0 ? 1 : 0]} · 정답 {room.hits[seat === 0 ? 1 : 0]}</footer>
              </aside>
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
                  <strong>{winner < 0 ? "DRAW" : winner === seat ? "YOU WIN" : `${names[winner]} WINS`}</strong>
                  <p>{names[0]} {room.scores[0]} : {room.scores[1]} {names[1]}</p>
                  <p>정답 {room.hits[seat]} · 오답 {room.misses[seat]}</p>
                  {room.isHost ? (
                    <button onClick={() => send({ type: "start", duration, difficulty })}>Play again</button>
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
                    ? <img className="chat-photo" src={message.image} alt="보낸 사진" loading="lazy" draggable={false} onLoad={() => { const l = chatListRef.current; if (l) l.scrollTop = l.scrollHeight; }} />
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
        <span>← → 로 캐릭터를 알맞은 쪽으로 · 정답 +1 · 오답 −1 (최소 0점)</span>
        <span>{networkError || (room ? `ROOM ${room.code} · ${SORT_DIFFICULTIES[room.difficulty].label} ${DURATION_LABELS[room.durationMs]}` : `${SORT_DIFFICULTIES[difficulty].label} · ${SORT_DIFFICULTIES[difficulty].types}종 분류`)}</span>
      </footer>
    </section>
  );
}
