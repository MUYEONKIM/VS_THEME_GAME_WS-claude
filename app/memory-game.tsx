"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MEMORY_CARD_IMAGES, MEMORY_DIFFICULTIES, type Difficulty } from "./memory-assets";

type GameMode = "computer" | "lan";

const MAX_RECONNECT_ATTEMPTS = 6;

// Uploaded photos are served through the API; built-in ones are static assets.
const UPLOADED_IMAGE_PREFIX = "/api/memory-images?key=";
const isUploadedImage = (image: string) => image.startsWith(UPLOADED_IMAGE_PREFIX);

type MemoryCard = {
  id: string;
  pairId: string;
  image: string;
};

type LocalGame = {
  deck: MemoryCard[];
  openCards: number[];
  matchedCards: number[];
  matchedBy: Array<0 | 1 | null>;
  currentTurn: 0 | 1;
  scores: [number, number];
  combos: [number, number];
  moves: number;
  locked: boolean;
  completed: boolean;
};

type Account = { id: string; nickname: string };

type PlayerRecord = { games: number; wins: number; losses: number; draws: number };

type RankingRow = PlayerRecord & { id: string; nickname: string; rank: number };

type OpponentRow = PlayerRecord & { id: string; nickname: string; lastPlayedAt: number };

type StatsPayload = {
  player: Account | null;
  record: PlayerRecord | null;
  ranking: RankingRow[];
  opponents: OpponentRow[];
};

const SESSION_STORAGE_KEY = "memory-session-token";

type LanRoom = {
  code: string;
  difficulty: Difficulty;
  deck: string[];
  openCards: number[];
  matchedCards: number[];
  matchedBy: Array<0 | 1 | null>;
  players: Array<{ name: string; guest: boolean }>;
  messages: Array<{ id: string; playerIndex: 0 | 1; name: string; text: string; image?: string; at: number }>;
  playerIndex: number;
  currentTurn: 0 | 1;
  scores: [number, number];
  combos: [number, number];
  moves: number;
  locked: boolean;
  completed: boolean;
  waiting: boolean;
  isHost: boolean;
};

function createDeck(difficulty: Difficulty, shuffled: boolean, imagePool: readonly string[]) {
  const { pairs } = MEMORY_DIFFICULTIES[difficulty];
  const images = [...imagePool];
  if (shuffled) {
    for (let index = images.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [images[index], images[swapIndex]] = [images[swapIndex], images[index]];
    }
  }
  const cards = images.slice(0, pairs).flatMap((image, index) => [
    { id: `${index}-a`, pairId: image, image },
    { id: `${index}-b`, pairId: image, image },
  ]);

  if (!shuffled) return cards;
  const next = [...cards];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

function createLocalGame(difficulty: Difficulty, shuffled: boolean, imagePool: readonly string[]): LocalGame {
  const deck = createDeck(difficulty, shuffled, imagePool);
  return {
    deck,
    openCards: [],
    matchedCards: [],
    matchedBy: Array.from({ length: deck.length }, () => null),
    currentTurn: 0,
    scores: [0, 0],
    combos: [0, 0],
    moves: 0,
    locked: false,
    completed: false,
  };
}

function createPlayerId() {
  if (typeof window.crypto?.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  if (typeof window.crypto?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return `lan-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  return `lan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

async function copyText(value: string) {
  try {
    if (typeof navigator.clipboard?.writeText === "function") {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // LAN HTTP pages may not expose the secure Clipboard API.
  }
  const field = document.createElement("textarea");
  field.value = value;
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  document.execCommand("copy");
  field.remove();
}

export function MemoryGame({ onExit }: { onExit: () => void }) {
  const [mode, setMode] = useState<GameMode>("computer");
  const [difficulty, setDifficulty] = useState<Difficulty>("normal");
  const [rematchDifficulty, setRematchDifficulty] = useState<Difficulty>("normal");
  const [imagePool, setImagePool] = useState<string[]>(() => [...MEMORY_CARD_IMAGES]);
  const [localGame, setLocalGame] = useState<LocalGame>(() => createLocalGame("normal", true, MEMORY_CARD_IMAGES));
  const [lanRoom, setLanRoom] = useState<LanRoom | null>(null);
  const [roomInput, setRoomInput] = useState("");
  const [nickname, setNickname] = useState("");
  const [networkError, setNetworkError] = useState("");
  const [networkBusy, setNetworkBusy] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadPassword, setUploadPassword] = useState("");
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadMessage, setUploadMessage] = useState("");
  const [photoNotice, setPhotoNotice] = useState("");
  const [chatPickerOpen, setChatPickerOpen] = useState(false);
  const [chatImagePending, setChatImagePending] = useState("");
  const [account, setAccount] = useState<Account | null>(null);
  const [sessionToken, setSessionToken] = useState("");
  const [playAsGuest, setPlayAsGuest] = useState(false);
  const [loginCode, setLoginCode] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authMessage, setAuthMessage] = useState("");
  const [myRecord, setMyRecord] = useState<PlayerRecord | null>(null);
  const [rankingOpen, setRankingOpen] = useState(false);
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [statsBusy, setStatsBusy] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryPassword, setLibraryPassword] = useState("");
  const [libraryMessage, setLibraryMessage] = useState("");
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [selectedImages, setSelectedImages] = useState<string[]>([]);
  const [deleteStage, setDeleteStage] = useState<"" | "confirm" | "password">("");
  const [matchEffect, setMatchEffect] = useState<{ cardIndexes: number[] } | null>(null);
  const [comboEffect, setComboEffect] = useState<number | null>(null);
  const [scorePulse, setScorePulse] = useState<number | null>(null);
  const timers = useRef<number[]>([]);
  const playerId = useRef("");
  const lanSocket = useRef<WebSocket | null>(null);
  const lanIntent = useRef({ code: "", name: "", difficulty: "normal" as Difficulty, token: "" });
  const lanAttempt = useRef(0);
  const reconnectTimer = useRef<number | null>(null);
  const connectLanRef = useRef<() => void>(() => {});
  const chatListRef = useRef<HTMLDivElement>(null);
  const effectSnapshot = useRef({ key: "", matched: 0, scores: [0, 0] as [number, number] });

  const clearTimers = useCallback(() => {
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current = [];
  }, []);

  const schedule = useCallback((callback: () => void, delay: number) => {
    const timer = window.setTimeout(() => {
      timers.current = timers.current.filter((candidate) => candidate !== timer);
      callback();
    }, delay);
    timers.current.push(timer);
  }, []);

  const showMatchEffect = useCallback((cardIndexes: number[]) => {
    setMatchEffect({ cardIndexes });
    schedule(() => setMatchEffect(null), 720);
  }, [schedule]);

  const getPlayerId = useCallback(() => {
    if (playerId.current) return playerId.current;
    let stored = "";
    try {
      stored = window.sessionStorage.getItem("memory-player-id") || "";
    } catch {
      // Some privacy modes disable session storage.
    }
    const next = stored || createPlayerId();
    try {
      window.sessionStorage.setItem("memory-player-id", next);
    } catch {
      // The in-memory ref still keeps this tab's identity stable.
    }
    playerId.current = next;
    return next;
  }, []);

  const startComputerGame = useCallback((nextDifficulty: Difficulty) => {
    clearTimers();
    setDifficulty(nextDifficulty);
    setLocalGame(createLocalGame(nextDifficulty, true, imagePool));
  }, [clearTimers, imagePool]);

  useEffect(() => {
    return clearTimers;
  }, [clearTimers]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/memory-images", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "사진 목록을 불러오지 못했습니다.");
        if (!cancelled && Array.isArray(data.images)) setImagePool(data.images);
      })
      .catch(() => {
        // Built-in photos remain available when storage is temporarily unavailable.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (mode !== "computer" || localGame.currentTurn !== 1 || localGame.locked || localGame.completed) return;
    const available = localGame.deck.map((_, index) => index).filter((index) => !localGame.matchedCards.includes(index));
    if (available.length < 2) return;
    const firstPosition = Math.floor(Math.random() * available.length);
    const first = available[firstPosition];
    const remaining = available.filter((_, index) => index !== firstPosition);
    const second = remaining[Math.floor(Math.random() * remaining.length)];
    const matched = localGame.deck[first].pairId === localGame.deck[second].pairId;

    setLocalGame((game) => ({ ...game, locked: true }));
    schedule(() => setLocalGame((game) => ({ ...game, openCards: [first] })), 420);
    schedule(() => {
      setLocalGame((game) => {
        if (matched) {
          const matchedCards = [...game.matchedCards, first, second];
          const matchedBy = [...game.matchedBy];
          matchedBy[first] = 1;
          matchedBy[second] = 1;
          const scores: [number, number] = [game.scores[0], game.scores[1] + 2 ** game.combos[1]];
          const combos: [number, number] = [game.combos[0], game.combos[1] + 1];
          return {
            ...game,
            matchedCards,
            matchedBy,
            openCards: [],
            scores,
            combos,
            moves: game.moves + 1,
            locked: false,
            completed: matchedCards.length === game.deck.length,
          };
        }
        return { ...game, openCards: [first, second], moves: game.moves + 1 };
      });
      if (matched) showMatchEffect([first, second]);
    }, 920);
    if (!matched) schedule(() => {
      setLocalGame((game) => {
        return {
          ...game,
          openCards: [],
          combos: [game.combos[0], 0],
          currentTurn: 0,
          locked: false,
        };
      });
    }, 1620);
  }, [localGame, mode, schedule, showMatchEffect]);

  const disconnectLan = useCallback(() => {
    if (reconnectTimer.current !== null) {
      window.clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    lanIntent.current.code = "";
    const socket = lanSocket.current;
    lanSocket.current = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.close();
  }, []);

  // Everything this needs lives in refs so the socket's own close handler can
  // call it again to reconnect without capturing a stale render.
  const connectLan = useCallback(() => {
    const intent = lanIntent.current;
    const url = new URL("/api/memory/ws", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("code", intent.code || "NEW");
    url.searchParams.set("playerId", getPlayerId());
    url.searchParams.set("name", intent.name);
    url.searchParams.set("difficulty", intent.difficulty);
    if (intent.token) url.searchParams.set("token", intent.token);

    const socket = new WebSocket(url);
    lanSocket.current = socket;

    socket.onopen = () => {
      lanAttempt.current = 0;
      setNetworkBusy(false);
      setNetworkError("");
    };

    socket.onmessage = (event) => {
      let payload: { type?: string; room?: LanRoom; message?: string };
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (payload.type === "state" && payload.room) {
        lanIntent.current.code = payload.room.code;
        setLanRoom(payload.room);
        setDifficulty(payload.room.difficulty);
        setNetworkError("");
      } else if (payload.type === "error") {
        setNetworkError(payload.message || "LAN sync failed.");
      }
    };

    socket.onclose = (event) => {
      if (lanSocket.current !== socket) return;
      lanSocket.current = null;
      setNetworkBusy(false);

      // The server closes with a 4xxx code when the room itself is the problem,
      // so retrying would never succeed.
      if (event.code >= 4000) {
        lanIntent.current.code = "";
        setLanRoom(null);
        setNetworkError(event.reason || "The room is no longer available.");
        return;
      }

      if (!lanIntent.current.code || lanAttempt.current >= MAX_RECONNECT_ATTEMPTS) {
        setNetworkError("Connection lost. Reopen the room to try again.");
        return;
      }

      const delay = Math.min(1000 * 2 ** lanAttempt.current, 8000);
      lanAttempt.current += 1;
      setNetworkError("Connection lost. Reconnecting…");
      reconnectTimer.current = window.setTimeout(() => {
        reconnectTimer.current = null;
        connectLanRef.current();
      }, delay);
    };
  }, [getPlayerId]);

  useEffect(() => {
    connectLanRef.current = connectLan;
  }, [connectLan]);

  const sendLan = useCallback((payload: Record<string, unknown>) => {
    const socket = lanSocket.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setNetworkError("Connection lost. Reconnecting…");
      return false;
    }
    socket.send(JSON.stringify(payload));
    return true;
  }, []);

  useEffect(() => disconnectLan, [disconnectLan]);

  const switchMode = (nextMode: GameMode) => {
    clearTimers();
    disconnectLan();
    setChatPickerOpen(false);
    setChatImagePending("");
    setMode(nextMode);
    setLanRoom(null);
    setNetworkError("");
    if (nextMode === "computer") startComputerGame(difficulty);
  };

  const openLanRoom = (code: string) => {
    disconnectLan();
    lanAttempt.current = 0;
    lanIntent.current = {
      code,
      name: account?.nickname ?? (nickname.trim() || "Guest"),
      difficulty,
      token: sessionToken,
    };
    setNetworkBusy(true);
    setNetworkError("");
    connectLan();
  };

  const createRoom = () => openLanRoom("");

  const joinRoom = () => openLanRoom(roomInput.trim().toUpperCase());

  const restartLan = (nextDifficulty: Difficulty) => {
    if (!lanRoom?.isHost) return;
    sendLan({ type: "restart", difficulty: nextDifficulty });
  };

  const flipLocalCard = (cardIndex: number) => {
    const game = localGame;
    if (game.currentTurn !== 0 || game.locked || game.completed || game.openCards.includes(cardIndex) || game.matchedCards.includes(cardIndex)) return;
    if (game.openCards.length === 0) {
      setLocalGame({ ...game, openCards: [cardIndex] });
      return;
    }

    const first = game.openCards[0];
    const matched = game.deck[first].pairId === game.deck[cardIndex].pairId;
    if (matched) {
      const matchedCards = [...game.matchedCards, first, cardIndex];
      const matchedBy = [...game.matchedBy];
      matchedBy[first] = 0;
      matchedBy[cardIndex] = 0;
      setLocalGame({
        ...game,
        matchedCards,
        matchedBy,
        openCards: [],
        scores: [game.scores[0] + 2 ** game.combos[0], game.scores[1]],
        combos: [game.combos[0] + 1, game.combos[1]],
        moves: game.moves + 1,
        locked: false,
        completed: matchedCards.length === game.deck.length,
      });
      showMatchEffect([first, cardIndex]);
      return;
    }

    setLocalGame({ ...game, openCards: [first, cardIndex], locked: true, moves: game.moves + 1 });
    schedule(() => {
      setLocalGame((current) => {
        return {
          ...current,
          openCards: [],
          combos: [0, current.combos[1]],
          currentTurn: 1,
          locked: false,
        };
      });
    }, 700);
  };

  const flipLanCard = (cardIndex: number) => {
    if (!lanRoom || lanRoom.waiting || lanRoom.locked || lanRoom.completed || lanRoom.currentTurn !== lanRoom.playerIndex) return;
    sendLan({ type: "flip", cardIndex });
  };

  // A staged photo goes out first; whatever is typed stays for the next message.
  const sendChat = () => {
    if (!lanRoom) return;
    if (chatImagePending) {
      if (sendLan({ type: "chat", image: chatImagePending })) setChatImagePending("");
      return;
    }
    const text = chatInput.trim();
    if (!text) return;
    if (sendLan({ type: "chat", text })) setChatInput("");
  };

  const uploadPhotos = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    if (form.getAll("images").every((value) => !(value instanceof File) || value.size === 0)) {
      setUploadMessage("추가할 사진을 선택해주세요.");
      return;
    }
    if (!uploadPassword) {
      setUploadMessage("비밀번호를 입력해주세요.");
      return;
    }

    setUploadBusy(true);
    setUploadMessage("");
    try {
      const response = await fetch("/api/memory-images", {
        method: "POST",
        headers: { "x-upload-password": uploadPassword },
        body: form,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "사진을 추가하지 못했습니다.");
      if (Array.isArray(data.images)) setImagePool(data.images);
      formElement.reset();
      // The dialog has nothing left to say, so report the result on the status
      // line and get out of the player's way.
      setUploadOpen(false);
      setUploadMessage("");
      setPhotoNotice(`${data.added}장의 사진을 추가했습니다. 다음 게임부터 카드 후보에 포함됩니다.`);
      schedule(() => setPhotoNotice(""), 5000);
    } catch (error) {
      setUploadMessage(error instanceof Error ? error.message : "사진을 추가하지 못했습니다.");
    } finally {
      setUploadBusy(false);
    }
  };

  const closeLibrary = () => {
    setLibraryOpen(false);
    setDeleteStage("");
    setLibraryPassword("");
    setSelectedImages([]);
  };

  // Restore a stored session so a reload keeps the player signed in.
  useEffect(() => {
    let stored = "";
    try {
      stored = window.localStorage.getItem(SESSION_STORAGE_KEY) || "";
    } catch {
      // Private modes disable local storage; the player just signs in again.
    }
    if (!stored) return;

    let cancelled = false;
    fetch("/api/auth", { headers: { "x-session-token": stored }, cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return;
        if (data.player) {
          setAccount(data.player);
          setSessionToken(stored);
          setMyRecord(data.record ?? null);
          setNickname(data.player.nickname);
        } else {
          try {
            window.localStorage.removeItem(SESSION_STORAGE_KEY);
          } catch {
            // Nothing to clean up when storage is unavailable.
          }
        }
      })
      .catch(() => {
        // An offline start simply shows the sign-in form.
      });
    return () => {
      cancelled = true;
    };
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
      setMyRecord(data.record ?? null);
      setNickname(data.player.nickname);
      setLoginCode("");
      try {
        window.localStorage.setItem(SESSION_STORAGE_KEY, data.token);
      } catch {
        // The session still works for this tab without storage.
      }
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : "로그인하지 못했습니다.");
    } finally {
      setAuthBusy(false);
    }
  };

  const signOut = () => {
    const token = sessionToken;
    setAccount(null);
    setSessionToken("");
    setMyRecord(null);
    setPlayAsGuest(false);
    setLoginCode("");
    setAuthMessage("");
    try {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // Nothing to clean up when storage is unavailable.
    }
    if (token) {
      fetch("/api/auth", { method: "DELETE", headers: { "x-session-token": token } }).catch(() => {
        // The token expires on its own even if this never lands.
      });
    }
  };

  const openRanking = async () => {
    setRankingOpen(true);
    setStatsBusy(true);
    try {
      const response = await fetch("/api/stats", {
        headers: sessionToken ? { "x-session-token": sessionToken } : undefined,
        cache: "no-store",
      });
      const data = await response.json();
      if (response.ok) {
        setStats(data);
        if (data.record) setMyRecord(data.record);
      }
    } catch {
      // The previously loaded board stays on screen.
    } finally {
      setStatsBusy(false);
    }
  };

  const openLibrary = async () => {
    setLibraryOpen(true);
    setLibraryMessage("");
    setDeleteStage("");
    setLibraryPassword("");
    setSelectedImages([]);
    try {
      const response = await fetch("/api/memory-images", { cache: "no-store" });
      const data = await response.json();
      if (response.ok && Array.isArray(data.images)) setImagePool(data.images);
    } catch {
      // The already-loaded list stays usable when the refresh fails.
    }
  };

  const toggleSelectImage = (image: string) => {
    if (!isUploadedImage(image)) return;
    setLibraryMessage("");
    setSelectedImages((current) => (
      current.includes(image) ? current.filter((entry) => entry !== image) : [...current, image]
    ));
  };

  const deleteSelectedImages = async () => {
    if (!libraryPassword) {
      setLibraryMessage("비밀번호를 입력해주세요.");
      return;
    }

    setLibraryBusy(true);
    setLibraryMessage("");

    let deleted = 0;
    let failure = "";
    let latest: string[] | null = null;

    for (const image of selectedImages) {
      try {
        const key = decodeURIComponent(image.slice(UPLOADED_IMAGE_PREFIX.length));
        const response = await fetch(`/api/memory-images?key=${encodeURIComponent(key)}`, {
          method: "DELETE",
          headers: { "x-upload-password": libraryPassword },
        });
        const data = await response.json();
        if (!response.ok) {
          failure = data.error || "사진을 삭제하지 못했습니다.";
          break;
        }
        if (Array.isArray(data.images)) latest = data.images;
        deleted += 1;
      } catch {
        failure = "사진을 삭제하지 못했습니다.";
        break;
      }
    }

    if (latest) setImagePool(latest);
    setLibraryBusy(false);

    if (failure) {
      // Keep the prompt open with whatever is still selected so it can be retried.
      setSelectedImages((current) => current.slice(deleted));
      setLibraryMessage(failure);
      return;
    }

    setSelectedImages([]);
    setDeleteStage("");
    setLibraryPassword("");
    setLibraryMessage(`${deleted}장을 삭제했습니다. 다음 게임부터 반영됩니다.`);
  };

  const uploadedImages = useMemo(() => imagePool.filter(isUploadedImage), [imagePool]);

  const view = useMemo(() => {
    if (mode === "lan" && lanRoom) {
      return {
        pairIds: lanRoom.deck,
        openCards: lanRoom.openCards,
        matchedCards: lanRoom.matchedCards,
        matchedBy: lanRoom.matchedBy,
        currentTurn: lanRoom.currentTurn,
        scores: lanRoom.scores,
        combos: lanRoom.combos,
        moves: lanRoom.moves,
        locked: lanRoom.locked,
        completed: lanRoom.completed,
        playerIndex: lanRoom.playerIndex,
        names: [
          lanRoom.players[0]?.name || "HOST",
          lanRoom.players[1]?.name || "WAITING",
        ],
      };
    }
    return {
      pairIds: localGame.deck.map((card) => card.pairId),
      openCards: localGame.openCards,
      matchedCards: localGame.matchedCards,
      matchedBy: localGame.matchedBy,
      currentTurn: localGame.currentTurn,
      scores: localGame.scores,
      combos: localGame.combos,
      moves: localGame.moves,
      locked: localGame.locked,
      completed: localGame.completed,
      playerIndex: 0,
      names: [nickname.trim() || "PLAYER", "CPU"],
    };
  }, [lanRoom, localGame, mode, nickname]);

  useEffect(() => {
    const gameKey = `${mode}:${mode === "lan" ? lanRoom?.code ?? "lobby" : "cpu"}:${difficulty}:${view.pairIds.join(",")}`;
    const previous = effectSnapshot.current;
    if (previous.key !== gameKey) {
      effectSnapshot.current = { key: gameKey, matched: view.matchedCards.length, scores: [...view.scores] };
      setMatchEffect(null);
      setComboEffect(null);
      setScorePulse(null);
      return;
    }

    const scorer = ([0, 1] as const).find((index) => view.scores[index] > previous.scores[index]);
    if (view.matchedCards.length > previous.matched) {
      const newMatchedCards = view.matchedCards.slice(previous.matched);
      if (mode === "lan" && newMatchedCards.length > 0) showMatchEffect(newMatchedCards);
      if (scorer !== undefined && view.combos[scorer] >= 2) {
        setComboEffect(2 ** (view.combos[scorer] - 1));
        schedule(() => setComboEffect(null), 1050);
      }
    }
    if (scorer !== undefined) {
      setScorePulse(scorer);
      schedule(() => setScorePulse(null), 520);
    }
    effectSnapshot.current = { key: gameKey, matched: view.matchedCards.length, scores: [...view.scores] };
  }, [difficulty, lanRoom?.code, mode, schedule, showMatchEffect, view]);

  useEffect(() => {
    if (!chatListRef.current) return;
    chatListRef.current.scrollTop = chatListRef.current.scrollHeight;
  }, [lanRoom?.messages.length]);

  useEffect(() => {
    if (mode === "lan" && lanRoom?.completed) setRematchDifficulty(lanRoom.difficulty);
  }, [lanRoom?.code, lanRoom?.completed, lanRoom?.difficulty, mode]);

  const config = MEMORY_DIFFICULTIES[difficulty];
  const matchedPairs = view.matchedCards.length / 2;
  const activeCombo = view.combos[view.currentTurn];
  const yourTurn = view.currentTurn === view.playerIndex;
  const waiting = mode === "lan" && (!lanRoom || lanRoom.waiting);
  const gridStyle = useMemo(() => ({
    gridTemplateColumns: `repeat(${config.columns}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${config.rows}, minmax(0, 1fr))`,
  }), [config]);

  const changeDifficulty = (nextDifficulty: Difficulty) => {
    if (mode === "computer") startComputerGame(nextDifficulty);
    else if (!lanRoom) setDifficulty(nextDifficulty);
    else restartLan(nextDifficulty);
  };

  const winner = view.scores[0] === view.scores[1] ? -1 : (view.scores[0] > view.scores[1] ? 0 : 1);
  const resultText = winner < 0 ? "DRAW" : (winner === view.playerIndex ? "YOU WIN" : `${view.names[winner]} WINS`);

  return (
    <section className="memory-game" aria-label="Picture matching battle">
      <header className="memory-toolbar">
        <div className="memory-heading">
          <strong>asset-cache.test.ts</strong>
          <div className="memory-mode-switch" aria-label="Battle mode">
            <button className={mode === "computer" ? "active" : ""} onClick={() => switchMode("computer")}>VS CPU</button>
            <button className={mode === "lan" ? "active" : ""} onClick={() => switchMode("lan")}>LAN BATTLE</button>
          </div>
        </div>
        <div className="memory-scoreboard" aria-live="polite">
          <span className={`${view.currentTurn === 0 ? "turn-active" : ""} ${scorePulse === 0 ? "score-pulse" : ""}`}><small>{view.names[0]}</small><b>{view.scores[0]}</b></span>
          <i>:</i>
          <span className={`${view.currentTurn === 1 ? "turn-active" : ""} ${scorePulse === 1 ? "score-pulse" : ""}`}><small>{view.names[1]}</small><b>{view.scores[1]}</b></span>
        </div>
        <div className="memory-stats">
          <span>TURN <b>{waiting ? "WAIT" : (yourTurn ? "YOU" : view.names[view.currentTurn])}</b></span>
          <span>MOVES <b>{view.moves}</b></span>
          <span key={`${view.currentTurn}-${activeCombo}`} className={activeCombo ? "combo-active" : ""}>COMBO <b>{activeCombo ? `×${2 ** activeCombo}` : "—"}</b></span>
          <span>PAIRS <b>{matchedPairs}/{config.pairs}</b></span>
        </div>
        <div className="memory-actions">
          <div className="difficulty-switch" aria-label="Difficulty">
            {(Object.keys(MEMORY_DIFFICULTIES) as Difficulty[]).map((level) => (
              <button
                key={level}
                className={difficulty === level ? "active" : ""}
                onClick={() => changeDifficulty(level)}
                disabled={mode === "lan" && !!lanRoom && !lanRoom.isHost}
              >
                {MEMORY_DIFFICULTIES[level].label}
                <small>{MEMORY_DIFFICULTIES[level].columns}×{MEMORY_DIFFICULTIES[level].rows}</small>
              </button>
            ))}
          </div>
          <button className="memory-plain-button" onClick={() => { setUploadOpen(true); setUploadMessage(""); }} title={`${imagePool.length} photos available`}>Add photos</button>
          <button className="memory-plain-button" onClick={openLibrary} title={`${imagePool.length} photos · ${uploadedImages.length} uploaded`}>Photo list</button>
          <button className="memory-plain-button" onClick={openRanking} title="전적과 랭킹">Ranking</button>
          <button className="memory-plain-button" onClick={() => mode === "computer" ? startComputerGame(difficulty) : restartLan(difficulty)} disabled={mode === "lan" && !lanRoom?.isHost}>Restart</button>
          <button className="memory-plain-button" onClick={onExit}>Close</button>
        </div>
      </header>

      {mode === "lan" && !lanRoom && !account && !playAsGuest ? (
        <div className="memory-lobby">
          <div className="lobby-signin">
            <small>PLAYER SIGN IN</small>
            <strong>LAN BATTLE</strong>
            <p>닉네임과 숫자 4자리로 로그인하면 승패와 랭킹이 기록됩니다. 처음 쓰는 닉네임이면 그대로 가입됩니다.</p>
            <form onSubmit={submitLogin}>
              <label>
                닉네임 (ID)
                <input
                  value={nickname}
                  maxLength={18}
                  placeholder="닉네임"
                  autoComplete="username"
                  onChange={(event) => { setNickname(event.target.value); setAuthMessage(""); }}
                />
              </label>
              <label>
                비밀번호 (숫자 4자리)
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  value={loginCode}
                  placeholder="0000"
                  autoComplete="current-password"
                  onChange={(event) => { setLoginCode(event.target.value.replace(/\D/g, "").slice(0, 4)); setAuthMessage(""); }}
                />
              </label>
              <button type="submit" className="lobby-create" disabled={authBusy || !nickname.trim() || loginCode.length !== 4}>
                {authBusy ? "확인 중…" : "로그인 / 가입"}
              </button>
            </form>
            {authMessage && <em>{authMessage}</em>}
            <div className="lobby-divider"><span>or</span></div>
            <button className="lobby-guest" onClick={() => { setPlayAsGuest(true); setAuthMessage(""); }}>guest로 게임하기</button>
            <footer>guest로 하면 내 전적은 남지 않습니다. 다만 상대가 로그인했다면 상대의 승패는 기록되고, 상대 전적에 &lsquo;Guest&rsquo;와의 대전으로 남습니다.</footer>
          </div>
        </div>
      ) : mode === "lan" && !lanRoom ? (
        <div className="memory-lobby">
          <div>
            <small>LOCAL NETWORK MATCHMAKING</small>
            <strong>LAN BATTLE</strong>
            <p>Create a room on this server or enter a four-character room code.</p>
            {account ? (
              <div className="lobby-account">
                <span><b>{account.nickname}</b>로 로그인됨</span>
                {myRecord && <small>{myRecord.games}전 {myRecord.wins}승 {myRecord.losses}패 {myRecord.draws}무</small>}
                <button type="button" onClick={signOut}>로그아웃</button>
              </div>
            ) : (
              <div className="lobby-account guest">
                <span>게스트로 진행 중 · 내 전적은 기록되지 않습니다</span>
                <button type="button" onClick={() => { setPlayAsGuest(false); setLoginCode(""); }}>로그인하기</button>
              </div>
            )}
            {!account && (
              <label>
                닉네임을 적어주세요
                <input value={nickname} maxLength={18} placeholder="닉네임을 적어주세요" onChange={(event) => setNickname(event.target.value)} />
              </label>
            )}
            <div className="lobby-difficulty">
              <span>방 난이도</span>
              <div role="group" aria-label="LAN room difficulty">
                {(Object.keys(MEMORY_DIFFICULTIES) as Difficulty[]).map((level) => (
                  <button
                    type="button"
                    key={level}
                    className={difficulty === level ? "active" : ""}
                    onClick={() => setDifficulty(level)}
                    disabled={networkBusy}
                  >
                    <b>{MEMORY_DIFFICULTIES[level].label}</b>
                    <small>{MEMORY_DIFFICULTIES[level].columns}×{MEMORY_DIFFICULTIES[level].rows}</small>
                  </button>
                ))}
              </div>
            </div>
            <button className="lobby-create" onClick={createRoom} disabled={networkBusy || !nickname.trim()}>Create room · {config.label} {config.columns}×{config.rows}</button>
            <div className="lobby-divider"><span>or join</span></div>
            <div className="lobby-join">
              <input
                value={roomInput}
                maxLength={4}
                placeholder="ROOM"
                onChange={(event) => setRoomInput(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                onKeyDown={(event) => { if (event.key === "Enter" && roomInput.length === 4) joinRoom(); }}
              />
              <button onClick={joinRoom} disabled={networkBusy || roomInput.length !== 4 || !nickname.trim()}>Join</button>
            </div>
            {networkError && <em>{networkError}</em>}
            <footer>Both players must open the same internal-network server address.</footer>
          </div>
        </div>
      ) : mode === "lan" && lanRoom?.waiting ? (
        <div className="memory-room-waiting">
          <div role="dialog" aria-modal="true" aria-label="Waiting for LAN opponent">
            <span className="waiting-spinner" aria-hidden="true" />
            <small>ROOM CREATED</small>
            <strong>WAITING FOR OPPONENT</strong>
            <p>상대방에게 아래 방 코드를 알려주세요.</p>
            <button className="waiting-room-code" onClick={() => copyText(lanRoom.code)} title="Copy room code">
              {lanRoom.code}
            </button>
            <span className="waiting-difficulty">{config.label} · {config.columns}×{config.rows}</span>
            <em>상대방이 참가하면 게임 화면이 자동으로 열립니다.</em>
            {networkError && <i>{networkError}</i>}
            <button className="waiting-cancel" onClick={() => { disconnectLan(); setLanRoom(null); setNetworkError(""); }}>Cancel room</button>
          </div>
        </div>
      ) : (
        <>
          <div className={`memory-turn-banner ${yourTurn ? "your-turn" : "opponent-turn"}`}>
            {waiting ? `ROOM ${lanRoom?.code} · WAITING FOR OPPONENT` : (yourTurn ? "YOUR TURN" : `${view.names[view.currentTurn]}'S TURN`)}
            {mode === "lan" && lanRoom && <button onClick={() => copyText(lanRoom.code)} title="Copy room code">ROOM {lanRoom.code}</button>}
          </div>
          <div className={`memory-battle-layout ${mode === "lan" ? "has-chat" : ""}`}>
            <div className="memory-board-area">
              <div className={`memory-grid difficulty-${difficulty} ${!yourTurn || waiting ? "board-waiting" : ""}`} style={gridStyle}>
                {view.pairIds.map((pairId, index) => {
                  const matched = view.matchedCards.includes(index);
                  const flipped = matched || view.openCards.includes(index);
                  const matchedOwner = view.matchedBy[index] ?? null;
                  const matchedOwnerName = matchedOwner === null ? "" : view.names[matchedOwner];
                  const matchedOwnerInitial = Array.from(matchedOwnerName.trim())[0]?.toLocaleUpperCase() || String((matchedOwner ?? 0) + 1);
                  return (
                    <button
                      key={`${pairId}-${index}`}
                      className={`memory-card ${flipped ? "flipped" : ""} ${matched ? "matched" : ""} ${matchEffect?.cardIndexes.includes(index) ? "match-celebrate" : ""}`}
                      onClick={() => mode === "computer" ? flipLocalCard(index) : flipLanCard(index)}
                      disabled={view.locked || waiting || !yourTurn || matched || flipped}
                      aria-label={matched ? `Matched card ${index + 1}` : `Card ${index + 1}`}
                      aria-pressed={flipped}
                    >
                      <span className="memory-card-inner">
                        <span className="memory-card-face memory-card-back">
                          <code>{"{}"}</code>
                          <small>ref[{String(index + 1).padStart(2, "0")}]</small>
                        </span>
                        <span className="memory-card-face memory-card-front">
                          <img src={pairId} alt="" draggable={false} />
                          {matched && matchedOwner !== null && (
                            <i
                              className={matchedOwner === view.playerIndex ? "owner-self" : "owner-rival"}
                              title={`${matchedOwnerName} matched this pair`}
                              aria-label={`Matched by ${matchedOwnerName}`}
                            >
                              {matchedOwnerInitial}
                            </i>
                          )}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
              {comboEffect && <div className="memory-combo-effect">COMBO ×{comboEffect}</div>}
              {view.completed && (
                <div className="memory-complete" role="dialog" aria-label="Match complete">
                  <div>
                    <small>MATCH COMPLETE</small>
                    <strong>{resultText}</strong>
                    <p>{view.names[0]} {view.scores[0]} : {view.scores[1]} {view.names[1]} · {view.moves} moves</p>
                    {mode === "lan" && (
                      <div className="memory-rematch-difficulty">
                        <span>{lanRoom?.isHost ? "재대결 난이도" : `방장이 재대결 난이도를 선택합니다 · ${config.label}`}</span>
                        <div role="group" aria-label="Rematch difficulty">
                          {(Object.keys(MEMORY_DIFFICULTIES) as Difficulty[]).map((level) => (
                            <button
                              type="button"
                              key={level}
                              className={rematchDifficulty === level ? "active" : ""}
                              onClick={() => setRematchDifficulty(level)}
                              disabled={!lanRoom?.isHost || networkBusy}
                            >
                              <b>{MEMORY_DIFFICULTIES[level].label}</b>
                              <small>{MEMORY_DIFFICULTIES[level].columns}×{MEMORY_DIFFICULTIES[level].rows}</small>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {(mode === "computer" || lanRoom?.isHost) && (
                      <button
                        onClick={() => mode === "computer" ? startComputerGame(difficulty) : restartLan(rematchDifficulty)}
                        disabled={networkBusy}
                      >
                        {mode === "lan" ? `Play again · ${MEMORY_DIFFICULTIES[rematchDifficulty].label}` : "Play again"}
                      </button>
                    )}
                    {mode === "lan" && !lanRoom?.isHost && <em className="rematch-waiting">방장이 재대결을 시작하기를 기다리는 중…</em>}
                    <button onClick={onExit}>Return to editor</button>
                  </div>
                </div>
              )}
            </div>
            {mode === "lan" && lanRoom && (
              <aside className="memory-chat" aria-label="LAN battle chat">
                <header><strong>LIVE CHAT</strong><span>{lanRoom.messages.length}</span></header>
                <div className="memory-chat-list" ref={chatListRef}>
                  {lanRoom.messages.length === 0 && <p>상대방에게 메시지를 보내보세요.</p>}
                  {lanRoom.messages.map((message) => (
                    <article key={message.id} className={message.playerIndex === lanRoom.playerIndex ? "mine" : ""}>
                      <div><b>{message.name}</b><time>{new Date(message.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>
                      {message.image
                        ? <img className="chat-photo" src={message.image} alt="보낸 사진" loading="lazy" draggable={false} />
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
            )}
          </div>
        </>
      )}

      <footer className="memory-footer">
        <span>Match: keep turn · Miss: pass turn · Combo scores +1, +2, +4, +8…</span>
        <span>{networkError || photoNotice || `${config.columns} columns × ${config.rows} rows · ${config.pairs} image pairs · ${imagePool.length} photos`}</span>
      </footer>

      {rankingOpen && (
        <div className="memory-library-overlay" role="dialog" aria-modal="true" aria-label="전적과 랭킹">
          <div className="memory-library-panel memory-ranking-panel">
            <header>
              <div>
                <small>LAN BATTLE RECORDS</small>
                <strong>전적 · 랭킹</strong>
              </div>
              <span className="library-count">{statsBusy ? "불러오는 중…" : `${stats?.ranking.length ?? 0}명 등록`}</span>
              <button type="button" className="library-close" onClick={() => setRankingOpen(false)} aria-label="닫기">×</button>
            </header>

            <div className="ranking-body">
              {stats?.player && stats.record ? (
                <section className="ranking-me">
                  <h4>내 전적 · {stats.player.nickname}</h4>
                  <div className="ranking-me-figures">
                    <span><b>{stats.record.games}</b><small>전</small></span>
                    <span className="win"><b>{stats.record.wins}</b><small>승</small></span>
                    <span className="loss"><b>{stats.record.losses}</b><small>패</small></span>
                    <span><b>{stats.record.draws}</b><small>무</small></span>
                  </div>
                </section>
              ) : (
                <p className="ranking-empty">로그인하면 내 전적과 상대별 기록이 여기에 표시됩니다. 랭킹은 로그인 없이도 볼 수 있습니다.</p>
              )}

              <section>
                <h4>랭킹 · 승수순</h4>
                {stats && stats.ranking.length > 0 ? (
                  <table className="ranking-table">
                    <thead>
                      <tr><th>#</th><th>닉네임</th><th>전</th><th>승</th><th>패</th><th>무</th></tr>
                    </thead>
                    <tbody>
                      {stats.ranking.map((row) => (
                        <tr key={row.id} className={row.id === stats.player?.id ? "mine" : ""}>
                          <td>{row.rank}</td>
                          <td className="nickname">{row.nickname}</td>
                          <td>{row.games}</td>
                          <td className="win">{row.wins}</td>
                          <td className="loss">{row.losses}</td>
                          <td>{row.draws}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="ranking-empty">{statsBusy ? "불러오는 중…" : "아직 끝난 대전이 없습니다."}</p>
                )}
              </section>

              {stats?.player && (
                <section>
                  <h4>상대별 전적</h4>
                  {stats.opponents.length > 0 ? (
                    <table className="ranking-table">
                      <thead>
                        <tr><th>상대</th><th>전</th><th>승</th><th>패</th><th>무</th><th>최근</th></tr>
                      </thead>
                      <tbody>
                        {stats.opponents.map((row) => (
                          <tr key={row.id}>
                            <td className="nickname">{row.nickname}</td>
                            <td>{row.games}</td>
                            <td className="win">{row.wins}</td>
                            <td className="loss">{row.losses}</td>
                            <td>{row.draws}</td>
                            <td>{new Date(row.lastPlayedAt).toLocaleDateString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="ranking-empty">아직 대전한 상대가 없습니다.</p>
                  )}
                </section>
              )}
            </div>

            <footer>
              <p>LAN 대전이 끝까지 진행된 판만 기록됩니다 · 중간에 나간 판과 CPU 대전은 집계되지 않습니다</p>
            </footer>
          </div>
        </div>
      )}

      {libraryOpen && (
        <div className="memory-library-overlay" role="dialog" aria-modal="true" aria-label="Memory game photo list">
          <div className="memory-library-panel">
            <header>
              <div>
                <small>ASSET LIBRARY</small>
                <strong>사진 목록</strong>
              </div>
              <span className="library-count">{imagePool.length}장 · 업로드 {uploadedImages.length}장</span>
              <button
                type="button"
                className="library-delete"
                onClick={() => { setLibraryMessage(""); setDeleteStage("confirm"); }}
                disabled={selectedImages.length === 0}
                title={selectedImages.length ? `선택한 ${selectedImages.length}장 삭제` : "삭제할 사진을 먼저 선택하세요"}
              >
                삭제{selectedImages.length > 0 ? ` (${selectedImages.length})` : ""}
              </button>
              <button type="button" className="library-close" onClick={closeLibrary} aria-label="Close photo list">×</button>
            </header>

            <div className="memory-library-grid">
              {imagePool.map((image) => {
                const uploaded = isUploadedImage(image);
                const selected = selectedImages.includes(image);
                return (
                  <figure key={image} className={`${uploaded ? "uploaded" : ""} ${selected ? "selected" : ""}`}>
                    {uploaded ? (
                      <button
                        type="button"
                        onClick={() => toggleSelectImage(image)}
                        aria-pressed={selected}
                        title={selected ? "선택 해제" : "선택"}
                      >
                        <img src={image} alt="" loading="lazy" draggable={false} />
                      </button>
                    ) : (
                      <img src={image} alt="" loading="lazy" draggable={false} />
                    )}
                    <figcaption>{uploaded ? "업로드" : "기본"}</figcaption>
                    {selected && <i className="library-check" aria-hidden="true">✓</i>}
                  </figure>
                );
              })}
            </div>

            <footer>
              {libraryMessage ? (
                <output>{libraryMessage}</output>
              ) : (
                <p>업로드한 사진을 클릭해 선택한 뒤 오른쪽 위 삭제를 누르세요 · 기본 사진 {imagePool.length - uploadedImages.length}장은 삭제할 수 없습니다</p>
              )}
            </footer>

            {deleteStage && (
              <div className="library-confirm" role="dialog" aria-modal="true" aria-label="사진 삭제 확인">
                <div>
                  {deleteStage === "confirm" ? (
                    <>
                      <strong>정말 삭제하시겠습니까?</strong>
                      <p>선택한 {selectedImages.length}장이 영구히 삭제됩니다.</p>
                      <div className="library-confirm-actions">
                        <button type="button" onClick={() => setDeleteStage("")}>No</button>
                        <button type="button" className="danger" onClick={() => { setLibraryMessage(""); setDeleteStage("password"); }}>Yes</button>
                      </div>
                    </>
                  ) : (
                    <>
                      <strong>비밀번호를 입력해주세요.</strong>
                      <input
                        type="password"
                        value={libraryPassword}
                        placeholder="비밀번호"
                        autoComplete="current-password"
                        autoFocus
                        disabled={libraryBusy}
                        onChange={(event) => setLibraryPassword(event.target.value)}
                        onKeyDown={(event) => { if (event.key === "Enter" && libraryPassword && !libraryBusy) deleteSelectedImages(); }}
                      />
                      {libraryMessage && <em>{libraryMessage}</em>}
                      <div className="library-confirm-actions">
                        <button type="button" onClick={() => { setDeleteStage(""); setLibraryPassword(""); setLibraryMessage(""); }} disabled={libraryBusy}>취소</button>
                        <button type="button" className="danger" onClick={deleteSelectedImages} disabled={libraryBusy || !libraryPassword}>
                          {libraryBusy ? "삭제 중…" : "삭제"}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {uploadOpen && (
        <div className="memory-upload-overlay" role="dialog" aria-modal="true" aria-label="Add memory game photos">
          <form onSubmit={uploadPhotos}>
            <header>
              <div>
                <small>ASSET IMPORT</small>
                <strong>사진 추가</strong>
              </div>
              <button type="button" onClick={() => setUploadOpen(false)} aria-label="Close photo upload">×</button>
            </header>
            <p>추가한 사진은 서버에 저장되며 다음 게임부터 무작위 카드 후보에 포함됩니다.</p>
            <label>
              비밀번호
              <input
                type="password"
                value={uploadPassword}
                placeholder="비밀번호"
                autoComplete="current-password"
                onChange={(event) => setUploadPassword(event.target.value)}
              />
            </label>
            <label>
              사진 선택
              <input name="images" type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple />
            </label>
            <small className="upload-rule">JPG, PNG, WEBP, GIF · 장당 5MB 이하 · 한 번에 최대 10장</small>
            {uploadMessage && <output>{uploadMessage}</output>}
            <footer>
              <button type="button" onClick={() => setUploadOpen(false)}>Cancel</button>
              <button type="submit" disabled={uploadBusy}>{uploadBusy ? "Uploading…" : "Add photos"}</button>
            </footer>
          </form>
        </div>
      )}
    </section>
  );
}
