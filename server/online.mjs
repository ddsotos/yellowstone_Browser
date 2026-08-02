import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createServer as createViteServer } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dataDir = process.env.ONLINE_DATA_DIR
  ? path.resolve(process.env.ONLINE_DATA_DIR)
  : path.join(root, "local-data");
const storePath = path.join(dataDir, "online-state.json");
const disconnectGraceMs = 5000;
const port = Number(process.env.ONLINE_PORT ?? process.env.PORT ?? 9293);

const json = (response, status, value) => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
};

const readBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const normalizeName = (value) => String(value ?? "").trim().slice(0, 24);

const nowIso = () => new Date().toISOString();

const emptyStore = () => ({
  version: 1,
  sessions: {},
  games: {},
  activeGameId: null,
  updatedAt: nowIso(),
});

let store = emptyStore();
let enginePromise;
const clients = new Set();

const loadEngine = async (vite) => {
  if (!enginePromise) {
    enginePromise = Promise.all([
      vite.ssrLoadModule("/src/game/game.ts"),
      vite.ssrLoadModule("/src/game/bot.ts"),
      vite.ssrLoadModule("/src/game/value.ts"),
      vite.ssrLoadModule("/src/game/v2Tracking.ts"),
    ]).then(([game, bot, value, v2]) => ({ game, bot, value, v2 }));
  }
  return enginePromise;
};

const saveStore = async () => {
  await mkdir(dataDir, { recursive: true });
  store.updatedAt = nowIso();
  await writeFile(storePath, JSON.stringify(store, null, 2), "utf8");
};

const loadStore = async () => {
  if (!existsSync(storePath)) return;
  store = JSON.parse(await readFile(storePath, "utf8"));
};

const broadcast = () => {
  const payload = `data: ${JSON.stringify(publicLobby())}\n\n`;
  for (const client of clients) client.write(payload);
};

const changed = async () => {
  await saveStore();
  broadcast();
};

const sessionIsConnected = (session) =>
  Boolean(session?.connected) ||
  (session?.disconnectedAt &&
    Date.now() - new Date(session.disconnectedAt).getTime() < disconnectGraceMs);

const removeWaitingSessionSeats = (sessionId) => {
  let didChange = false;
  for (const game of Object.values(store.games)) {
    if (game.status !== "waiting") continue;
    if (game.hostSessionId === sessionId) {
      delete store.games[game.id];
      if (store.activeGameId === game.id) store.activeGameId = null;
      didChange = true;
      continue;
    }
    const seats = game.seats.map((seat) =>
      seat?.kind === "human" && seat.sessionId === sessionId ? null : seat,
    );
    if (seats.some((seat, index) => seat !== game.seats[index])) {
      game.seats = seats;
      game.revision += 1;
      didChange = true;
    }
  }
  return didChange;
};

const pruneDisconnectedWaitingSeats = () => {
  let didChange = false;
  for (const session of Object.values(store.sessions)) {
    if (!session.connected) {
      didChange = removeWaitingSessionSeats(session.id) || didChange;
    }
  }
  return didChange;
};

const markSessionsDisconnectedAfterRestart = () => {
  let didChange = false;
  for (const session of Object.values(store.sessions)) {
    if (session.connected) {
      session.connected = false;
      session.disconnectedAt = nowIso();
      didChange = true;
    }
  }
  return didChange;
};

const shuffledSeats = (seats) => {
  const result = seats.map((seat, index) =>
    seat ?? { index, kind: "cpu", name: `CPU ${index + 1}` },
  );
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result.map((seat, index) => ({
    ...seat,
    index,
    name: seat.kind === "cpu" ? `CPU ${index + 1}` : seat.name,
  }));
};

const requireSession = (sessionId) => {
  const session = store.sessions[sessionId];
  if (!session) throw new Error("ログインしてください。");
  session.connected = true;
  session.disconnectedAt = null;
  session.lastSeenAt = nowIso();
  return session;
};

const publicLobby = () => ({
  activeGameId: store.activeGameId,
  games: Object.values(store.games).map((game) => ({
    id: game.id,
    name: game.name,
    status: game.status,
    hostSessionId: game.hostSessionId,
    createdAt: game.createdAt,
    startedAt: game.startedAt,
    cpuDifficulty: game.cpuDifficulty,
    seats: game.seats.map((seat) =>
      seat
        ? {
            index: seat.index,
            kind: seat.kind,
            name: seat.name,
            sessionId: seat.kind === "human" ? seat.sessionId : null,
            connected:
              seat.kind === "human"
                ? sessionIsConnected(store.sessions[seat.sessionId])
                : true,
          }
        : null,
    ),
    state: game.state,
    history: game.history,
    v2Tracking: game.v2Tracking,
    lastTurns: game.lastTurns ?? Array.from({ length: 4 }, () => null),
    revision: game.revision,
  })),
});

const publicSession = (session) => ({
  id: session.id,
  name: session.name,
});

const ensureNameAvailable = (name, sessionId) => {
  const duplicate = Object.values(store.sessions).find(
    (session) =>
      session.name === name &&
      session.id !== sessionId &&
      sessionIsConnected(session),
  );
  if (duplicate) throw new Error("同じ名前のプレイヤーが接続中です。");
};

const createSession = async ({ name, sessionId }) => {
  const cleanName = normalizeName(name);
  if (!cleanName) throw new Error("名前を入力してください。");
  pruneDisconnectedWaitingSeats();
  ensureNameAvailable(cleanName, sessionId);
  const existing = sessionId ? store.sessions[sessionId] : null;
  const session = existing ?? { id: randomUUID(), createdAt: nowIso() };
  session.name = cleanName;
  session.connected = true;
  session.disconnectedAt = null;
  session.lastSeenAt = nowIso();
  store.sessions[session.id] = session;
  await changed();
  return session;
};

const createGame = async (session, body) => {
  if (store.activeGameId) throw new Error("初期版では同時に作れるゲームは1つです。");
  const id = randomUUID();
  const game = {
    id,
    name: normalizeName(body.name) || `${session.name} table`,
    status: "waiting",
    hostSessionId: session.id,
    createdAt: nowIso(),
    startedAt: null,
    cpuDifficulty: body.cpuDifficulty === "expert" ? "expert" : "standard",
    seats: [
      { index: 0, kind: "human", name: session.name, sessionId: session.id },
      null,
      null,
      null,
    ],
    state: null,
    history: [],
    v2Tracking: null,
    lastTurns: Array.from({ length: 4 }, () => null),
    revision: 0,
  };
  store.games[id] = game;
  store.activeGameId = id;
  await changed();
  return game;
};

const findGame = (gameId) => {
  const game = store.games[gameId];
  if (!game) throw new Error("ゲームが見つかりません。");
  return game;
};

const findSeat = (game, sessionId) =>
  game.seats.find((seat) => seat?.kind === "human" && seat.sessionId === sessionId);

const joinGame = async (session, body) => {
  const game = findGame(body.gameId);
  if (game.status !== "waiting") throw new Error("開始済みのゲームには参加できません。");
  const existing = findSeat(game, session.id);
  if (existing) return game;
  const index = game.seats.findIndex((seat) => !seat);
  if (index < 0) throw new Error("満席です。");
  game.seats[index] = { index, kind: "human", name: session.name, sessionId: session.id };
  game.revision += 1;
  await changed();
  return game;
};

const kickSeat = async (session, body) => {
  const game = findGame(body.gameId);
  if (game.hostSessionId !== session.id) throw new Error("ホストだけが削除できます。");
  if (game.status !== "waiting") throw new Error("開始後は削除できません。");
  const seatIndex = Number(body.seatIndex);
  if (seatIndex <= 0 || seatIndex >= 4) throw new Error("この席は削除できません。");
  game.seats[seatIndex] = null;
  game.revision += 1;
  await changed();
  return game;
};

const deleteGame = async (session, body) => {
  const game = findGame(body.gameId);
  if (game.hostSessionId !== session.id) {
    throw new Error("Only the host can delete this game.");
  }
  delete store.games[game.id];
  if (store.activeGameId === game.id) store.activeGameId = null;
  await changed();
  return game;
};

const rememberCompletedTurn = (game, playerIndex) => {
  const completed = game.v2Tracking?.history?.at(-1);
  if (!completed || completed.playerIndex !== playerIndex) return;
  const lastTurns = game.lastTurns ?? Array.from({ length: 4 }, () => null);
  lastTurns[playerIndex] = {
    playerIndex,
    cards: completed.cards,
    negativeCardDelta: Math.max(0, completed.negativeCardDelta),
  };
  game.lastTurns = lastTurns;
};

const runCpuTurns = async (engine, game) => {
  const cpuNames = new Set(
    game.seats.filter((seat) => seat?.kind === "cpu").map((seat) => seat.index),
  );
  while (
    game.state?.phase !== "game_over" &&
    cpuNames.has(game.state.currentPlayerIndex)
  ) {
    const playerIndex = game.state.currentPlayerIndex;
    while (
      game.state.phase !== "game_over" &&
      game.state.currentPlayerIndex === playerIndex
    ) {
      const action = engine.bot.chooseHeuristicAction(game.state);
      if (!action) {
        throw new Error(`CPU seat ${playerIndex} has no legal action`);
      }
      const applied = engine.value.applyActionTrackingHistory(
        game.state,
        action,
        game.history,
      );
      game.v2Tracking = engine.v2.observeV2Action(
        game.v2Tracking,
        game.state,
        action,
        applied.state,
      );
      game.state = applied.state;
      game.history = applied.history;
    }
    rememberCompletedTurn(game, playerIndex);
  }
};

const startGame = async (engine, session, body) => {
  const game = findGame(body.gameId);
  if (game.hostSessionId !== session.id) throw new Error("ホストだけが開始できます。");
  if (game.status !== "waiting") throw new Error("開始済みです。");
  game.seats = shuffledSeats(game.seats);
  game.state = engine.game.createInitialState(4);
  game.history = [];
  game.v2Tracking = engine.v2.createV2Tracking(4);
  game.lastTurns = Array.from({ length: 4 }, () => null);
  game.status = "active";
  game.startedAt = nowIso();
  game.revision += 1;
  await runCpuTurns(engine, game);
  await changed();
  return game;
};

const submitTurn = async (engine, session, body) => {
  const game = findGame(body.gameId);
  if (game.status !== "active") throw new Error("ゲームが開始されていません。");
  const seat = findSeat(game, session.id);
  if (!seat) throw new Error("このゲームに参加していません。");
  if (game.state.currentPlayerIndex !== seat.index) throw new Error("あなたの手番ではありません。");
  const actions = Array.isArray(body.actions) ? body.actions : [];
  if (!actions.length) throw new Error("手が空です。");
  const expectedRevision = Number(body.revision);
  if (expectedRevision !== game.revision) throw new Error("盤面が更新されています。");
  const playerIndex = game.state.currentPlayerIndex;
  for (const action of actions) {
    if (
      game.state.phase === "game_over" ||
      game.state.currentPlayerIndex !== playerIndex
    ) {
      throw new Error("手順が現在の手番を超えています。");
    }
    const applied = engine.value.applyActionTrackingHistory(
      game.state,
      action,
      game.history,
    );
    game.v2Tracking = engine.v2.observeV2Action(
      game.v2Tracking,
      game.state,
      action,
      applied.state,
    );
    game.state = applied.state;
    game.history = applied.history;
  }
  if (game.state.currentPlayerIndex === playerIndex && game.state.phase !== "game_over") {
    throw new Error("補充まで含めて手番を完了してください。");
  }
  rememberCompletedTurn(game, playerIndex);
  game.revision += 1;
  await runCpuTurns(engine, game);
  await changed();
  return game;
};

const route = async (request, response, vite) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (!url.pathname.startsWith("/api/online")) return false;
  try {
    if (request.method === "GET" && url.pathname === "/api/online/health") {
      json(response, 200, {
        ok: true,
        pid: process.pid,
        port,
        storePath,
        updatedAt: store.updatedAt,
      });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/online/events") {
      const session = requireSession(url.searchParams.get("sessionId"));
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      clients.add(response);
      response.write(`event: session\ndata: ${JSON.stringify(publicSession(session))}\n\n`);
      response.write(`data: ${JSON.stringify(publicLobby())}\n\n`);
      request.on("close", async () => {
        clients.delete(response);
        const current = store.sessions[session.id];
        if (current) {
          current.connected = false;
          current.disconnectedAt = nowIso();
          current.lastSeenAt = nowIso();
          removeWaitingSessionSeats(session.id);
          await changed();
        }
      });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/online/bootstrap") {
      const sessionId = url.searchParams.get("sessionId");
      const session = sessionId ? store.sessions[sessionId] : null;
      if (session) requireSession(sessionId);
      json(response, 200, {
        session: session ? publicSession(session) : null,
        lobby: publicLobby(),
      });
      return true;
    }

    if (request.method !== "POST") {
      json(response, 405, { error: "method not allowed" });
      return true;
    }

    const body = await readBody(request);
    const engine = await loadEngine(vite);
    if (url.pathname === "/api/online/login") {
      const session = await createSession(body);
      json(response, 200, { session: publicSession(session), lobby: publicLobby() });
      return true;
    }

    const session = requireSession(body.sessionId);
    let game;
    if (url.pathname === "/api/online/create") game = await createGame(session, body);
    else if (url.pathname === "/api/online/join") game = await joinGame(session, body);
    else if (url.pathname === "/api/online/kick") game = await kickSeat(session, body);
    else if (url.pathname === "/api/online/delete") game = await deleteGame(session, body);
    else if (url.pathname === "/api/online/start") game = await startGame(engine, session, body);
    else if (url.pathname === "/api/online/submit-turn") game = await submitTurn(engine, session, body);
    else {
      json(response, 404, { error: "not found" });
      return true;
    }
    json(response, 200, { game, lobby: publicLobby() });
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
  return true;
};

await loadStore();
const disconnectedAfterRestart = markSessionsDisconnectedAfterRestart();
const prunedWaitingSeats = pruneDisconnectedWaitingSeats();
if (disconnectedAfterRestart || prunedWaitingSeats) {
  await saveStore();
}
const vite = await createViteServer({
  root,
  server: { middlewareMode: true },
  appType: "spa",
});

const server = createServer(async (request, response) => {
  if (await route(request, response, vite)) return;
  vite.middlewares(request, response);
});

server.listen(port, "0.0.0.0", () => {
  const fp = createHash("sha1").update(storePath).digest("hex").slice(0, 8);
  console.log(`Yellowstone online server http://localhost:${port}`);
  console.log(`Local store ${storePath} (${fp})`);
});
