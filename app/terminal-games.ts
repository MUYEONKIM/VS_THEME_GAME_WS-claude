"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type GameId = "2048" | "snake" | "pong";
export type Direction = "up" | "down" | "left" | "right";

export const gameCatalog: Array<{ id: GameId; name: string; label: string; hint: string; primary?: boolean }> = [
  { id: "pong", name: "pong.ts", label: "PONG", hint: "W/S or arrows", primary: true },
  { id: "2048", name: "2048.ts", label: "2048", hint: "Arrow keys" },
  { id: "snake", name: "snake.ts", label: "SNAKE", hint: "Arrow keys / WASD" },
];

type GameStatus = "running" | "paused" | "won" | "lost";
type Point = { x: number; y: number };

export type GameBoard =
  | { kind: "2048"; cells: number[]; direction: Direction | "none"; revision: number }
  | { kind: "snake"; cells: string[]; width: number; height: number; direction: Direction }
  | { kind: "pong"; cells: string[]; width: number; height: number };

export type TerminalGameView = {
  title: string;
  help: string;
  status: string;
  score: string;
  board: GameBoard;
  overlay?: string;
};

type Board2048 = {
  cells: number[];
  score: number;
  status: Exclude<GameStatus, "paused">;
  direction: Direction | "none";
  revision: number;
};

const initial2048 = (): Board2048 => ({
  cells: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
  score: 0,
  status: "running",
  direction: "none",
  revision: 0,
});

function spawnTile(cells: number[]) {
  const empty = cells.flatMap((value, index) => (value === 0 ? [index] : []));
  if (!empty.length) return cells;
  const next = [...cells];
  const index = empty[Math.floor(Math.random() * empty.length)];
  next[index] = Math.random() < 0.9 ? 2 : 4;
  return next;
}

function move2048(cells: number[], direction: Direction) {
  const next = [...cells];
  let gained = 0;

  for (let lane = 0; lane < 4; lane += 1) {
    const positions = Array.from({ length: 4 }, (_, step) => {
      if (direction === "left") return lane * 4 + step;
      if (direction === "right") return lane * 4 + (3 - step);
      if (direction === "up") return step * 4 + lane;
      return (3 - step) * 4 + lane;
    });
    const compact = positions.map((position) => cells[position]).filter(Boolean);
    const merged: number[] = [];

    for (let index = 0; index < compact.length; index += 1) {
      if (compact[index] === compact[index + 1]) {
        const value = compact[index] * 2;
        merged.push(value);
        gained += value;
        index += 1;
      } else {
        merged.push(compact[index]);
      }
    }

    while (merged.length < 4) merged.push(0);
    positions.forEach((position, index) => { next[position] = merged[index]; });
  }

  return { cells: next, gained, changed: next.some((value, index) => value !== cells[index]) };
}

function has2048Move(cells: number[]) {
  if (cells.includes(0)) return true;
  return cells.some((value, index) => {
    const x = index % 4;
    const y = Math.floor(index / 4);
    return (x < 3 && value === cells[index + 1]) || (y < 3 && value === cells[index + 4]);
  });
}

const SNAKE_WIDTH = 40;
const SNAKE_HEIGHT = 13;

type SnakeState = {
  body: Point[];
  food: Point;
  direction: Direction;
  queuedDirection: Direction;
  score: number;
  status: Exclude<GameStatus, "paused">;
};

const initialSnake = (): SnakeState => ({
  body: [{ x: 10, y: 6 }, { x: 9, y: 6 }, { x: 8, y: 6 }, { x: 7, y: 6 }],
  food: { x: 29, y: 6 },
  direction: "right",
  queuedDirection: "right",
  score: 0,
  status: "running",
});

function samePoint(a: Point, b: Point) {
  return a.x === b.x && a.y === b.y;
}

function nextSnakeFood(body: Point[]) {
  const empty: Point[] = [];
  for (let y = 0; y < SNAKE_HEIGHT; y += 1) {
    for (let x = 0; x < SNAKE_WIDTH; x += 1) {
      if (!body.some((part) => part.x === x && part.y === y)) empty.push({ x, y });
    }
  }
  return empty[Math.floor(Math.random() * empty.length)] ?? { x: 0, y: 0 };
}

const PONG_WIDTH = 58;
const PONG_HEIGHT = 15;
const PADDLE_HEIGHT = 4;
const WINNING_SCORE = 5;

type PongState = {
  ball: Point & { vx: number; vy: number };
  playerY: number;
  aiY: number;
  playerScore: number;
  aiScore: number;
  tick: number;
  status: GameStatus;
};

const initialPong = (): PongState => ({
  ball: { x: Math.floor(PONG_WIDTH / 2), y: Math.floor(PONG_HEIGHT / 2), vx: -1, vy: 1 },
  playerY: 5,
  aiY: 5,
  playerScore: 0,
  aiScore: 0,
  tick: 0,
  status: "paused",
});

function statusLabel(status: GameStatus) {
  if (status === "won") return "YOU WIN";
  if (status === "lost") return "GAME OVER";
  return status.toUpperCase();
}

export function useTerminalGames() {
  const [activeGame, setActiveGame] = useState<GameId | null>(null);
  const [board2048, setBoard2048] = useState(initial2048);
  const [snake, setSnake] = useState(initialSnake);
  const [pong, setPong] = useState(initialPong);
  const heldPongKeys = useRef(new Set<string>());

  const launchGame = useCallback((game: GameId) => {
    heldPongKeys.current.clear();
    setActiveGame(game);
    if (game === "2048") setBoard2048(initial2048());
    if (game === "snake") setSnake(initialSnake());
    if (game === "pong") setPong(initialPong());
  }, []);

  const closeGame = useCallback(() => {
    heldPongKeys.current.clear();
    setActiveGame(null);
  }, []);

  const restartGame = useCallback(() => {
    if (activeGame) launchGame(activeGame);
  }, [activeGame, launchGame]);

  useEffect(() => {
    const releaseKeys = () => heldPongKeys.current.clear();
    window.addEventListener("blur", releaseKeys);
    return () => window.removeEventListener("blur", releaseKeys);
  }, []);

  useEffect(() => {
    if (activeGame !== "snake" || snake.status !== "running") return;
    const timer = window.setInterval(() => {
      setSnake((state) => {
        if (state.status !== "running") return state;
        const movement: Record<Direction, Point> = {
          up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 },
        };
        const direction = state.queuedDirection;
        const delta = movement[direction];
        const head = { x: state.body[0].x + delta.x, y: state.body[0].y + delta.y };
        const grows = samePoint(head, state.food);
        const collisionBody = grows ? state.body : state.body.slice(0, -1);
        const crashed = head.x < 0 || head.x >= SNAKE_WIDTH || head.y < 0 || head.y >= SNAKE_HEIGHT || collisionBody.some((part) => samePoint(part, head));
        if (crashed) return { ...state, direction, status: "lost" };
        const body = [head, ...state.body];
        if (!grows) body.pop();
        return {
          ...state,
          body,
          direction,
          food: grows ? nextSnakeFood(body) : state.food,
          score: state.score + (grows ? 10 : 0),
        };
      });
    }, 135);
    return () => window.clearInterval(timer);
  }, [activeGame, snake.status]);

  useEffect(() => {
    if (activeGame !== "pong" || pong.status !== "running") return;
    const timer = window.setInterval(() => {
      setPong((state) => {
        if (state.status !== "running") return state;
        const tick = state.tick + 1;
        const movingUp = heldPongKeys.current.has("arrowup") || heldPongKeys.current.has("w");
        const movingDown = heldPongKeys.current.has("arrowdown") || heldPongKeys.current.has("s");
        let playerY = state.playerY;
        if (movingUp !== movingDown) playerY += movingUp ? -1 : 1;
        playerY = Math.max(0, Math.min(PONG_HEIGHT - PADDLE_HEIGHT, playerY));
        let aiY = state.aiY;
        if (tick % 2 === 0) {
          const aiCenter = aiY + Math.floor(PADDLE_HEIGHT / 2);
          if (state.ball.y < aiCenter) aiY -= 1;
          if (state.ball.y > aiCenter) aiY += 1;
          aiY = Math.max(0, Math.min(PONG_HEIGHT - PADDLE_HEIGHT, aiY));
        }

        let { x, y, vx, vy } = state.ball;
        let nextX = x + vx;
        let nextY = y + vy;
        if (nextY < 0 || nextY >= PONG_HEIGHT) {
          vy *= -1;
          nextY = y + vy;
        }
        if (vx < 0 && nextX <= 1 && x > 1 && nextY >= playerY && nextY < playerY + PADDLE_HEIGHT) {
          vx = 1;
          nextX = 2;
        }
        if (vx > 0 && nextX >= PONG_WIDTH - 2 && x < PONG_WIDTH - 2 && nextY >= aiY && nextY < aiY + PADDLE_HEIGHT) {
          vx = -1;
          nextX = PONG_WIDTH - 3;
        }

        let playerScore = state.playerScore;
        let aiScore = state.aiScore;
        let status: GameStatus = "running";
        const playerScored = nextX >= PONG_WIDTH;
        const aiScored = nextX < 0;
        if (playerScored) playerScore += 1;
        if (aiScored) aiScore += 1;
        if (playerScored || aiScored) {
          nextX = Math.floor(PONG_WIDTH / 2);
          nextY = Math.floor(PONG_HEIGHT / 2);
          vx = playerScored ? -1 : 1;
          vy = Math.random() < 0.5 ? -1 : 1;
          status = "paused";
        }
        if (playerScore >= WINNING_SCORE) status = "won";
        if (aiScore >= WINNING_SCORE) status = "lost";
        return { ...state, playerY, aiY, playerScore, aiScore, status, tick, ball: { x: nextX, y: nextY, vx, vy } };
      });
    }, 72);
    return () => window.clearInterval(timer);
  }, [activeGame, pong.status]);

  const handleGameKey = useCallback((event: KeyboardEvent) => {
    if (!activeGame) return false;
    const key = event.key.toLowerCase();
    if (key === "escape") {
      closeGame();
      return true;
    }

    if (activeGame === "2048") {
      const directions: Partial<Record<string, Direction>> = {
        arrowleft: "left", arrowright: "right", arrowup: "up", arrowdown: "down",
      };
      if (key === "r") { setBoard2048(initial2048()); return true; }
      const direction = directions[key];
      if (!direction) return false;
      setBoard2048((state) => {
        if (state.status !== "running") return state;
        const moved = move2048(state.cells, direction);
        if (!moved.changed) return state;
        const cells = spawnTile(moved.cells);
        const status = cells.some((value) => value >= 2048) ? "won" : (has2048Move(cells) ? "running" : "lost");
        return { cells, score: state.score + moved.gained, status, direction, revision: state.revision + 1 };
      });
      return true;
    }

    if (activeGame === "snake") {
      if (key === "r") { setSnake(initialSnake()); return true; }
      const directions: Partial<Record<string, Direction>> = {
        arrowup: "up", w: "up", arrowdown: "down", s: "down", arrowleft: "left", a: "left", arrowright: "right", d: "right",
      };
      const direction = directions[key];
      if (!direction) return false;
      setSnake((state) => {
        const opposite: Record<Direction, Direction> = { up: "down", down: "up", left: "right", right: "left" };
        return opposite[state.direction] === direction ? state : { ...state, queuedDirection: direction };
      });
      return true;
    }

    if (key === "r") { setPong(initialPong()); return true; }
    if (key === " ") {
      if (event.repeat) return true;
      setPong((state) => ({ ...state, status: state.status === "paused" ? "running" : (state.status === "running" ? "paused" : state.status) }));
      return true;
    }
    if (["arrowup", "w", "arrowdown", "s"].includes(key)) {
      const wasHeld = heldPongKeys.current.has(key);
      heldPongKeys.current.add(key);
      if (!wasHeld) {
        const delta = key === "arrowup" || key === "w" ? -1 : 1;
        setPong((state) => ({ ...state, playerY: Math.max(0, Math.min(PONG_HEIGHT - PADDLE_HEIGHT, state.playerY + delta)) }));
      }
      return true;
    }
    return false;
  }, [activeGame, closeGame]);

  const handleGameKeyUp = useCallback((event: KeyboardEvent) => {
    const key = event.key.toLowerCase();
    if (!["arrowup", "w", "arrowdown", "s"].includes(key)) return false;
    heldPongKeys.current.delete(key);
    return activeGame === "pong";
  }, [activeGame]);

  const gameView = useMemo<TerminalGameView | null>(() => {
    if (!activeGame) return null;
    if (activeGame === "2048") {
      return {
        title: "2048.ts",
        help: "Arrows move · R restart · Esc exit",
        status: statusLabel(board2048.status),
        score: `score ${board2048.score}`,
        board: { kind: "2048", cells: board2048.cells, direction: board2048.direction, revision: board2048.revision },
        overlay: board2048.status === "lost" ? "GAME OVER" : (board2048.status === "won" ? "2048 · YOU WIN" : undefined),
      };
    }
    if (activeGame === "snake") {
      const cells = Array<string>(SNAKE_WIDTH * SNAKE_HEIGHT).fill("empty");
      cells[snake.food.y * SNAKE_WIDTH + snake.food.x] = "food";
      snake.body.forEach((part, index) => {
        const token = index === 0 ? "head" : (index === snake.body.length - 1 ? "tail" : "body");
        if (part.x >= 0 && part.x < SNAKE_WIDTH && part.y >= 0 && part.y < SNAKE_HEIGHT) cells[part.y * SNAKE_WIDTH + part.x] = token;
      });
      return {
        title: "snake.ts",
        help: "Arrows/WASD · R restart · Esc exit",
        status: statusLabel(snake.status),
        score: `score ${snake.score}`,
        board: { kind: "snake", cells, width: SNAKE_WIDTH, height: SNAKE_HEIGHT, direction: snake.direction },
        overlay: snake.status === "lost" ? "GAME OVER" : undefined,
      };
    }

    const cells = Array<string>(PONG_WIDTH * PONG_HEIGHT).fill("empty");
    for (let y = 0; y < PONG_HEIGHT; y += 2) cells[y * PONG_WIDTH + Math.floor(PONG_WIDTH / 2)] = "center";
    for (let offset = 0; offset < PADDLE_HEIGHT; offset += 1) {
      cells[(pong.playerY + offset) * PONG_WIDTH + 1] = "player";
      cells[(pong.aiY + offset) * PONG_WIDTH + PONG_WIDTH - 2] = "cpu";
    }
    if (pong.ball.x >= 0 && pong.ball.x < PONG_WIDTH && pong.ball.y >= 0 && pong.ball.y < PONG_HEIGHT) cells[pong.ball.y * PONG_WIDTH + pong.ball.x] = "ball";
    return {
      title: "pong.ts · MAIN",
      help: "W/S or arrows · Space pause/serve · R restart · Esc exit",
      status: statusLabel(pong.status),
      score: `YOU  ${pong.playerScore}  :  ${pong.aiScore}  CPU`,
      board: { kind: "pong", cells, width: PONG_WIDTH, height: PONG_HEIGHT },
      overlay: pong.status === "paused" ? "SPACE TO SERVE" : (pong.status === "won" ? "YOU WIN" : (pong.status === "lost" ? "GAME OVER" : undefined)),
    };
  }, [activeGame, board2048, pong, snake]);

  return { activeGame, gameView, launchGame, closeGame, restartGame, handleGameKey, handleGameKeyUp };
}
