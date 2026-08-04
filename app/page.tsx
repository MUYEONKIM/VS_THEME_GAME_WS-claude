"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { gameCatalog, type GameId, type TerminalGameView, useTerminalGames } from "./terminal-games";
import { MemoryGame } from "./memory-game";

type ExplorerFile = {
  name: string;
  kind: "ts" | "json" | "md" | "game";
  indent?: number;
};

const files: ExplorerFile[] = [
  { name: ".github", kind: "json" },
  { name: "config", kind: "json" },
  { name: "src", kind: "ts" },
  { name: "api", kind: "ts", indent: 1 },
  { name: "middleware", kind: "ts", indent: 1 },
  { name: "server.ts", kind: "ts", indent: 2 },
  { name: "auth.ts", kind: "ts", indent: 2 },
  { name: "database.ts", kind: "ts", indent: 2 },
  { name: "types", kind: "ts", indent: 1 },
  { name: "models.ts", kind: "ts", indent: 2 },
  { name: "tests", kind: "ts" },
  { name: ".env.example", kind: "json" },
  { name: "package.json", kind: "json" },
  { name: "README.md", kind: "md" },
];

const editorGame = {
  id: "memory",
  name: "asset-cache.test.ts",
  hint: "Picture reference test · editor",
};

const sourceByFile: Record<string, string> = {
  "server.ts": `import { createServer } from "node:http";
import { createRouter } from "./api/router";
import { env } from "./config/env";

const router = createRouter({
  prefix: "/api/v2",
  requestId: true,
  timeout: 12_000,
});

router.use(async (context, next) => {
  const startedAt = performance.now();

  try {
    await next();
  } finally {
    context.logger.info({
      method: context.request.method,
      path: context.request.url,
      status: context.response.status,
      durationMs: performance.now() - startedAt,
    });
  }
});

const server = createServer(router.handler);

server.listen(env.PORT, env.HOST, () => {
  console.log(\`API listening on http://\${env.HOST}:\${env.PORT}\`);
});
`,
  "auth.ts": `import { timingSafeEqual } from "node:crypto";
import type { Middleware } from "./api/types";

export const authenticate: Middleware = async (context, next) => {
  const token = context.request.headers.authorization?.replace("Bearer ", "");

  if (!token || !isValidToken(token)) {
    return context.json({ error: "Unauthorized" }, 401);
  }

  context.set("actor", await resolveActor(token));
  await next();
};

function isValidToken(candidate: string): boolean {
  const expected = Buffer.from(process.env.API_TOKEN ?? "");
  const received = Buffer.from(candidate);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
`,
  "database.ts": `import { Pool } from "pg";
import { env } from "./config/env";

export const database = new Pool({
  connectionString: env.DATABASE_URL,
  max: 12,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 2_000,
});

export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
`,
  "models.ts": `export type Environment = "development" | "staging" | "production";

export interface RequestContext {
  requestId: string;
  actorId?: string;
  environment: Environment;
  startedAt: number;
}

export interface ApiResponse<T> {
  data: T;
  meta: {
    requestId: string;
    timestamp: string;
  };
}
`,
};

const keywordPattern = /("[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|`[^`]*`|\/\/.*$|\b(?:import|from|const|let|async|await|try|finally|catch|return|function|export|interface|type|new|throw|if|else|true|false)\b|\b\d[\d_]*(?:\.\d+)?\b|\b(?:string|boolean|number|Promise|Record|Buffer|PoolClient)\b)/g;

function highlightLine(line: string) {
  return line.split(keywordPattern).map((part, index) => {
    let className = "token-default";
    if (/^\/\//.test(part)) className = "token-comment";
    else if (/^["'`]/.test(part)) className = "token-string";
    else if (/^\d/.test(part)) className = "token-number";
    else if (/^(string|boolean|number|Promise|Record|Buffer|PoolClient)$/.test(part)) className = "token-type";
    else if (/^(import|from|const|let|async|await|try|finally|catch|return|function|export|interface|type|new|throw|if|else|true|false)$/.test(part)) className = "token-keyword";
    return <span className={className} key={`${index}-${part}`}>{part}</span>;
  });
}

function FileIcon({ kind }: { kind: ExplorerFile["kind"] }) {
  if (kind === "ts") return <span className="file-icon ts-icon">TS</span>;
  if (kind === "json") return <span className="file-icon json-icon">{'{}'}</span>;
  if (kind === "md") return <span className="file-icon md-icon">M↓</span>;
  return <span className="file-icon ts-icon">TS</span>;
}

function TerminalGameBoard({ view }: { view: TerminalGameView }) {
  const { board } = view;
  if (board.kind === "2048") {
    return (
      <div className="game-board-shell board-shell-2048">
        <div key={board.revision} className={`board-2048 motion-${board.direction}`}>
          {board.cells.map((value, index) => {
            const valueClass = value > 2048 ? "tile-super" : `tile-v${value}`;
            return <span key={index} className={`tile-2048 ${value ? valueClass : "tile-empty"}`}>{value || ""}</span>;
          })}
        </div>
        {view.overlay && <div className="game-overlay"><strong>{view.overlay}</strong><small>Press R to restart</small></div>}
      </div>
    );
  }

  const headGlyph = board.kind === "snake" ? ({ up: "▲", down: "▼", left: "◀", right: "▶" }[board.direction]) : "";
  const glyphFor = (token: string) => {
    if (token === "head") return headGlyph;
    if (token === "tail") return "◆";
    if (token === "food" || token === "ball") return "●";
    return "";
  };

  return (
    <div className={`game-board-shell board-shell-${board.kind}`}>
      <div
        className={`pixel-board ${board.kind}-board`}
        style={{ gridTemplateColumns: `repeat(${board.width}, var(--game-cell))` }}
      >
        {board.cells.map((token, index) => <span key={index} className={`pixel-cell ${board.kind}-${token}`}>{glyphFor(token)}</span>)}
      </div>
      {view.overlay && (
        <div className={`game-overlay ${view.status === "PAUSED" ? "serve-overlay" : ""}`}>
          <strong>{view.overlay}</strong>
          <small>{view.status === "PAUSED" ? "Press Space" : "Press R to restart"}</small>
        </div>
      )}
    </div>
  );
}

export default function Home() {
  const [activeFile, setActiveFile] = useState("server.ts");
  const [typedLength, setTypedLength] = useState(230);
  const [gamesOpen, setGamesOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memoryHidden, setMemoryHidden] = useState(false);
  const { activeGame, gameView, launchGame: startGame, closeGame, restartGame, handleGameKey, handleGameKeyUp } = useTerminalGames();
  const [terminalHistory, setTerminalHistory] = useState<string[]>([
    "PS C:\\Users\\dev\\atlas-api> npm run dev",
    "",
    "[api] environment loaded: development",
    "[api] database connection established",
    "[api] server listening on http://localhost:4100",
    "",
  ]);
  const terminalRef = useRef<HTMLDivElement>(null);
  const terminalPanelRef = useRef<HTMLElement>(null);
  const editorTerminalRef = useRef<HTMLDivElement>(null);
  const terminalWasOpenRef = useRef(true);
  const [terminalHeight, setTerminalHeight] = useState<number | null>(null);

  const fullSource = sourceByFile[activeFile] ?? sourceByFile["server.ts"];
  const visibleCode = fullSource.slice(0, Math.min(typedLength, fullSource.length));

  const typeDecoy = useCallback((event: KeyboardEvent) => {
    const target = event.target;
    if (
      target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || target instanceof HTMLSelectElement
      || (target instanceof HTMLElement && target.isContentEditable)
    ) return;
    if (event.key === "F5" || event.key === "F11" || event.key === "F12") return;
    if ((event.ctrlKey || event.metaKey) && ["r", "w", "l", "t"].includes(event.key.toLowerCase())) return;
    if ([" ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Backspace", "Tab"].includes(event.key)) {
      event.preventDefault();
    }
    setTypedLength((length) => {
      if (length >= fullSource.length) return 70;
      const stride = event.key === "Enter" ? 13 : 4 + (event.key.length % 6);
      return Math.min(length + stride, fullSource.length);
    });
  }, [fullSource]);

  useEffect(() => {
    window.addEventListener("keydown", typeDecoy, { capture: true });
    return () => window.removeEventListener("keydown", typeDecoy, { capture: true });
  }, [typeDecoy]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (handleGameKey(event)) event.preventDefault();
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (handleGameKeyUp(event)) event.preventDefault();
    };
    window.addEventListener("keydown", handleKey, { capture: true });
    window.addEventListener("keyup", handleKeyUp, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKey, { capture: true });
      window.removeEventListener("keyup", handleKeyUp, { capture: true });
    };
  }, [handleGameKey, handleGameKeyUp]);

  useEffect(() => {
    terminalRef.current?.scrollTo({ top: terminalRef.current.scrollHeight });
  }, [terminalHistory, activeGame]);

  const lines = useMemo(() => visibleCode.split("\n"), [visibleCode]);

  const openFile = (name: string) => {
    if (!sourceByFile[name]) return;
    if (memoryOpen) {
      setMemoryOpen(false);
      setTerminalOpen(terminalWasOpenRef.current);
    }
    setActiveFile(name);
    setTypedLength(210);
  };

  const launchGame = (gameId: GameId, gameName: string) => {
    setMemoryOpen(false);
    startGame(gameId);
    setTerminalOpen(true);
    setTerminalHistory((history) => [
      ...history,
      `PS C:\\Users\\dev\\atlas-api> node .\\games\\${gameName}`,
      `Starting ${gameName.replace(".ts", "")} in terminal mode...`,
      "",
    ]);
  };

  const launchMemoryGame = () => {
    if (memoryOpen) return;
    terminalWasOpenRef.current = terminalOpen;
    closeGame();
    setMemoryOpen(true);
    setTerminalOpen(false);
  };

  const closeMemoryGame = () => {
    setMemoryOpen(false);
    setMemoryHidden(false);
    setTerminalOpen(terminalWasOpenRef.current);
  };

  // Esc hides the game behind the editor without unmounting it, so the LAN
  // socket stays open and the opponent sees a pause rather than a dropout.
  const hideMemoryGame = (hidden: boolean) => {
    setMemoryHidden(hidden);
    setTerminalOpen(hidden ? terminalWasOpenRef.current : false);
  };

  const beginTerminalResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const panel = terminalPanelRef.current;
    const container = editorTerminalRef.current;
    if (!panel || !container) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = panel.getBoundingClientRect().height;
    const maximumHeight = Math.max(230, container.getBoundingClientRect().height - 85);
    document.body.classList.add("resizing-terminal");

    const move = (moveEvent: PointerEvent) => {
      const nextHeight = Math.max(230, Math.min(maximumHeight, startHeight + startY - moveEvent.clientY));
      setTerminalHeight(nextHeight);
    };
    const stop = () => {
      document.body.classList.remove("resizing-terminal");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }, []);

  return (
    <main className="ide-shell" aria-label="Visual Studio Code workspace simulation">
      <header className="titlebar">
        <div className="window-mark" aria-hidden="true"><span className="codicon codicon-vscode" /></div>
        <nav className="top-menu" aria-label="Application menu">
          <button>File</button><button>Edit</button><button>Selection</button><button>View</button>
          <button>Go</button><button>Run</button><button>Terminal</button><button>Help</button>
        </nav>
        <button className="command-center" aria-label="Search workspace">
          <span className="search-glyph">⌕</span> atlas-api
        </button>
        <div className="layout-controls" aria-hidden="true"><span>▣</span><span>◫</span><span>▤</span></div>
        <div className="window-controls" aria-hidden="true"><span>—</span><span>□</span><span>×</span></div>
      </header>

      <section className="workspace">
        <aside className="activitybar" aria-label="Primary side bar">
          <button className="activity active" title="Explorer" aria-label="Explorer" onClick={() => setSidebarOpen(true)}><span className="codicon codicon-files" /></button>
          <button className="activity" title="Search" aria-label="Search"><span className="codicon codicon-search" /></button>
          <button className="activity" title="Source Control" aria-label="Source Control"><span className="codicon codicon-source-control" /><i className="badge">3</i></button>
          <button className="activity" title="Run and Debug" aria-label="Run and Debug"><span className="codicon codicon-debug-alt" /></button>
          <button className="activity" title="Extensions" aria-label="Extensions"><span className="codicon codicon-extensions" /></button>
          <div className="activity-spacer" />
          <button className="activity" title="Accounts" aria-label="Accounts"><span className="codicon codicon-account" /></button>
          <button className="activity" title="Manage" aria-label="Manage"><span className="codicon codicon-settings-gear" /></button>
        </aside>

        {sidebarOpen && (
          <aside className="sidebar" aria-label="Explorer">
            <div className="sidebar-title"><span>EXPLORER</span><button aria-label="More actions">•••</button></div>
            <div className="project-row"><span className="codicon codicon-chevron-down chevron" /><strong>ATLAS-API</strong></div>
            <div className="file-tree">
              {files.map((file, index) => {
                const isFolder = !file.name.includes(".") || [".github", "config", "src", "api", "middleware", "types", "tests"].includes(file.name);
                const isOpenFolder = ["src", "api", "middleware", "types"].includes(file.name);
                const selected = file.name === activeFile;
                return (
                  <button
                    key={`${file.name}-${index}`}
                    className={`tree-row ${selected ? "selected" : ""}`}
                    style={{ paddingLeft: `${10 + (file.indent ?? 0) * 14}px` }}
                    onClick={() => openFile(file.name)}
                  >
                    {isFolder ? <><span className={`codicon ${isOpenFolder ? "codicon-chevron-down" : "codicon-chevron-right"} tree-caret`} /><span className={`codicon ${isOpenFolder ? "codicon-folder-opened" : "codicon-folder"} folder-icon`} /></> : <><span className="tree-gap" /><FileIcon kind={file.kind} /></>}
                    <span>{file.name}</span>
                    {file.name === "server.ts" && <small>M</small>}
                  </button>
                );
              })}

              <button className={`tree-row games-row ${gamesOpen ? "open" : ""}`} onClick={() => setGamesOpen((open) => !open)}>
                <span className={`codicon ${gamesOpen ? "codicon-chevron-down" : "codicon-chevron-right"} tree-caret`} /><span className={`codicon ${gamesOpen ? "codicon-folder-opened" : "codicon-folder"} folder-icon games-folder`} /><span>games</span><em>LOCAL</em>
              </button>
              {gamesOpen && (
                <button className={`tree-row game-file ${memoryOpen ? "selected" : ""}`} onClick={launchMemoryGame} title={editorGame.hint}>
                  <span className="tree-gap" /><FileIcon kind="game" /><span>{editorGame.name}</span><em className="game-main">EDITOR</em><span className="play-indicator">▷</span>
                </button>
              )}
              {gamesOpen && gameCatalog.map((game) => (
                <button key={game.id} className={`tree-row game-file ${activeGame === game.id ? "selected" : ""}`} onClick={() => launchGame(game.id, game.name)} title={game.hint}>
                  <span className="tree-gap" /><FileIcon kind="game" /><span>{game.name}</span>{game.primary && <em className="game-main">MAIN</em>}<span className="play-indicator">▷</span>
                </button>
              ))}
            </div>
            <div className="outline-row"><span className="codicon codicon-chevron-right" /> OUTLINE</div>
            <div className="outline-row"><span className="codicon codicon-chevron-right" /> TIMELINE</div>
          </aside>
        )}

        <section className="main-pane">
          <div className="editor-tabs">
            <button className="tab active"><FileIcon kind="ts" /><span>{memoryOpen && !memoryHidden ? editorGame.name : activeFile}</span><span className="tab-dot">●</span></button>
            <div className="editor-actions"><button title="Split Editor">▯</button><button title="More Actions">•••</button></div>
          </div>
          <div className="breadcrumbs">
            <span>atlas-api</span><b>›</b>
            {memoryOpen && !memoryHidden ? <><span>games</span><b>›</b><FileIcon kind="ts" /><span>{editorGame.name}</span><b>›</b><span className="crumb-symbol">◇</span><span>runReferenceSuite</span></> : <><span>src</span><b>›</b><span>middleware</span><b>›</b><FileIcon kind="ts" /><span>{activeFile}</span><b>›</b><span className="crumb-symbol">◇</span><span>createServer</span></>}
          </div>

          <div className="editor-and-terminal" ref={editorTerminalRef}>
            {memoryOpen && <MemoryGame onExit={closeMemoryGame} hidden={memoryHidden} onHiddenChange={hideMemoryGame} />}
            {(!memoryOpen || memoryHidden) && <div className="editor-wrap" aria-label={`${activeFile} code editor`}>
              <div className="code-lines">
                {lines.map((line, index) => (
                  <div className="code-line" key={index}>
                    <span className="line-number">{index + 1}</span>
                    <code>{highlightLine(line)}</code>
                  </div>
                ))}
                <div className="fake-cursor" style={{ top: `${(lines.length - 1) * 21 + 8}px`, left: `${60 + ((lines.at(-1)?.length ?? 0) * 7.75)}px` }} />
              </div>
              <div className="minimap" aria-hidden="true">
                {Array.from({ length: 32 }).map((_, i) => <i key={i} style={{ width: `${26 + ((i * 17) % 58)}%` }} />)}
              </div>
              <div className="scroll-thumb" aria-hidden="true" />
            </div>}

            {terminalOpen && (
              <section className="terminal-panel" ref={terminalPanelRef} style={terminalHeight ? { flexBasis: terminalHeight, maxHeight: "none" } : undefined} aria-label="Integrated terminal">
                <div className="panel-resize" role="separator" aria-label="Resize terminal" aria-orientation="horizontal" onPointerDown={beginTerminalResize} onDoubleClick={() => setTerminalHeight(null)} />
                <div className="panel-head">
                  <div className="panel-tabs"><button>PROBLEMS <small>0</small></button><button>OUTPUT</button><button>DEBUG CONSOLE</button><button className="active">TERMINAL</button><button>PORTS</button></div>
                  <div className="terminal-tools"><button><span className="terminal-glyph">›_</span> powershell</button><button title="New Terminal">＋</button><button title="Split Terminal">▯</button><button title="Kill Terminal">♲</button><button title="More Actions">•••</button><button title="Maximize Panel">⌃</button><button title="Close Panel" onClick={() => setTerminalOpen(false)}>×</button></div>
                </div>
                <div className="terminal-content" ref={terminalRef}>
                  {terminalHistory.map((line, index) => <div key={`${line}-${index}`} className={line.startsWith("[") ? "log-line" : ""}>{line || "\u00a0"}</div>)}
                  {activeGame && gameView && <div className={`ascii-game game-${activeGame}`} aria-label={`${gameView.title} game`}>
                    <div className="game-title"><strong>{gameView.title}</strong><span>{gameView.score}</span><span>{gameView.status}</span></div>
                    <TerminalGameBoard view={gameView} />
                    <div className="game-meta"><span>{gameView.help}</span></div>
                    <div className="game-actions">
                      <button onClick={restartGame}>Restart</button>
                      <button onClick={closeGame}>Exit</button>
                    </div>
                  </div>}
                  <div className="prompt-line">PS C:\Users\dev\atlas-api&gt; <span className="terminal-cursor"> </span></div>
                </div>
              </section>
            )}
          </div>
        </section>
      </section>

      <footer className="statusbar">
        <div className="status-left"><button className="remote">〉〈</button><button>⑂ main*</button><button>↻</button><button>ⓧ 0</button><button>△ 0</button></div>
        <div className="status-right"><span>Ln {lines.length}, Col {(lines.at(-1)?.length ?? 0) + 1}</span><span>Spaces: 2</span><span>UTF-8</span><span>LF</span><span>{"{}"}</span><span>TypeScript React</span><span>✓ Prettier</span><span>🔔</span></div>
      </footer>
      <div className="keyboard-hint">TYPE ANYTHING — DECOY MODE ACTIVE</div>
    </main>
  );
}
