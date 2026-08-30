'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8080);
const BIND_HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');

const MAX_ROOMS = 400;
const MAX_PLAYERS = 16;
const MIN_PLAYERS = 3;
const ROOM_IDLE_MS = 3 * 60 * 60 * 1000;
const MR_WHITE_GUESS_MS = 45000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const POINTS = { civil: 2, undercover: 10, mr_white: 6 };

/* ------------------------------------------------------------------ */
/* Word data                                                           */
/* Deux formats de theme acceptes, cumulables dans un meme fichier :   */
/*   "paires": [{civil, undercover}, ...]  paires fixes                */
/*   "mots":   ["a", "b", ...]  deux mots distincts tires du theme     */
/* ------------------------------------------------------------------ */

const data_files = process.env.PAIRS_FILE
  ? [process.env.PAIRS_FILE]
  : fs.readdirSync(DATA_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => path.join(DATA_DIR, f));

const themes = [];
for (const file of data_files) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const t of raw.themes || []) {
    if (!t || typeof t.nom !== 'string') continue;
    const paires = Array.isArray(t.paires)
      ? t.paires.filter((p) => p && typeof p.civil === 'string' && typeof p.undercover === 'string')
      : [];
    const mots = Array.isArray(t.mots)
      ? t.mots.filter((m) => typeof m === 'string' && m.trim().length)
      : [];
    if (!paires.length && mots.length < 2) continue;
    let theme = themes.find((x) => x.nom === t.nom);
    if (!theme) {
      theme = { nom: t.nom, paires: [], mots: [] };
      themes.push(theme);
    }
    theme.paires.push(...paires);
    theme.mots.push(...mots);
  }
}
if (!themes.length) {
  console.error('[data] aucun theme utilisable dans', data_files.join(', '));
  process.exit(1);
}

function themeCount(t) {
  return t.paires.length + (t.mots.length >= 2 ? t.mots.length : 0);
}

const theme_names = themes.map((t) => t.nom);
const total_entries = themes.reduce((acc, t) => acc + themeCount(t), 0);
console.log(`[data] loaded ${themes.length} themes / ${total_entries} entries from ${data_files.length} file(s)`);

/* ------------------------------------------------------------------ */
/* Utils                                                               */
/* ------------------------------------------------------------------ */

function randomInt(max) {
  return crypto.randomInt(max);
}

function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

function makeId() {
  return crypto.randomBytes(9).toString('base64url');
}

function normalizeWord(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function cleanText(value, max_len) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max_len);
}

function autoRoleCounts(player_count) {
  if (player_count <= 4) return { undercover_count: 1, mr_white_count: 0 };
  if (player_count <= 6) return { undercover_count: 1, mr_white_count: 1 };
  if (player_count <= 9) return { undercover_count: 2, mr_white_count: 1 };
  if (player_count <= 12) return { undercover_count: 3, mr_white_count: 1 };
  return { undercover_count: 3, mr_white_count: 2 };
}

/* ------------------------------------------------------------------ */
/* Rooms                                                               */
/* ------------------------------------------------------------------ */

const rooms = new Map();

function defaultSettings() {
  return {
    themes: [],
    auto_roles: true,
    undercover_count: 1,
    mr_white_count: 0,
    reveal_role: false,
    discussion_seconds: 90,
    typed_clues: true
  };
}

function generateRoomCode() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    let code = '';
    for (let i = 0; i < 4; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  return null;
}

function createRoom() {
  const code = generateRoomCode();
  if (!code) return null;
  const room = {
    code,
    created_at: Date.now(),
    touched_at: Date.now(),
    host_id: null,
    phase: 'lobby',
    settings: defaultSettings(),
    players: new Map(),
    seat_order: [],
    round: 0,
    round_order: [],
    turn_pointer: 0,
    clue_history: [],
    votes: new Map(),
    restart_votes: new Set(),
    tie_between: null,
    tie_attempt: 0,
    deadline_ts: null,
    timer: null,
    last_eliminated: null,
    mr_white_guess: null,
    winner: null,
    pair: null,
    civil_word: null,
    undercover_word: null,
    theme_used: null,
    chat: []
  };
  rooms.set(code, room);
  console.log(`[room] created ${code} (${rooms.size} active)`);
  return room;
}

function clearRoomTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
  room.deadline_ts = null;
}

function destroyRoom(room) {
  clearRoomTimer(room);
  rooms.delete(room.code);
  console.log(`[room] destroyed ${room.code} (${rooms.size} active)`);
}

function alivePlayers(room) {
  return room.seat_order.map((id) => room.players.get(id)).filter((p) => p && p.alive);
}

function orderedPlayers(room) {
  return room.seat_order.map((id) => room.players.get(id)).filter(Boolean);
}

function pickHost(room) {
  const connected = orderedPlayers(room).find((p) => p.connected);
  const fallback = orderedPlayers(room)[0];
  room.host_id = (connected || fallback || {}).id || null;
}

/* ------------------------------------------------------------------ */
/* Serialization                                                       */
/* ------------------------------------------------------------------ */

function publicPlayer(room, player) {
  const ended = room.phase === 'ended';
  const out = {
    id: player.id,
    name: player.name,
    is_host: room.host_id === player.id,
    connected: player.connected,
    alive: player.alive,
    score: player.score,
    ready: player.ready,
    has_voted: room.votes.has(player.id),
    has_clue: room.clue_history.some((c) => c.round === room.round && c.player_id === player.id)
  };
  if (ended || (!player.alive && player.revealed)) {
    out.role = player.role;
  }
  if (ended) {
    out.word = player.word;
  }
  return out;
}

function roomState(room) {
  const alive = alivePlayers(room);
  const turn_player = room.phase === 'clues' ? room.round_order[room.turn_pointer] : null;
  return {
    type: 'room',
    code: room.code,
    phase: room.phase,
    round: room.round,
    host_id: room.host_id,
    settings: room.settings,
    players: orderedPlayers(room).map((p) => publicPlayer(room, p)),
    turn_id: turn_player || null,
    round_order: room.round_order,
    clue_history: room.clue_history,
    votes: room.phase === 'vote_result' || room.phase === 'ended' ? Array.from(room.votes.entries()) : [],
    vote_count: room.votes.size,
    restart_votes: Array.from(room.restart_votes),
    alive_count: alive.length,
    tie_between: room.tie_between,
    deadline_ts: room.deadline_ts,
    last_eliminated: room.last_eliminated,
    mr_white_guess: room.mr_white_guess,
    winner: room.winner,
    theme_used: room.phase === 'ended' ? room.theme_used : null,
    words: room.phase === 'ended' ? { civil: room.civil_word, undercover: room.undercover_word } : null,
    min_players: MIN_PLAYERS,
    max_players: MAX_PLAYERS
  };
}

function privateState(room, player) {
  const show_role = room.settings.reveal_role || player.role === 'mr_white' || room.phase === 'ended';
  return {
    type: 'you',
    id: player.id,
    name: player.name,
    is_host: room.host_id === player.id,
    alive: player.alive,
    role: show_role ? player.role : null,
    word: player.word,
    civil_word_hint: null
  };
}

function send(ws, payload) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (err) {
    console.error('[ws] send failed', err.message);
  }
}

function broadcast(room) {
  const state = roomState(room);
  room.players.forEach((player) => {
    if (!player.ws) return;
    send(player.ws, state);
    send(player.ws, privateState(room, player));
  });
}

function broadcastRaw(room, payload) {
  room.players.forEach((player) => send(player.ws, payload));
}

function toast(ws, message, kind) {
  send(ws, { type: 'toast', message, kind: kind || 'info' });
}

function fail(ws, message) {
  send(ws, { type: 'error', message });
}

/* ------------------------------------------------------------------ */
/* Game flow                                                           */
/* ------------------------------------------------------------------ */

function drawFromTheme(theme) {
  const mots_usable = theme.mots.length >= 2 ? theme.mots.length : 0;
  const roll = randomInt(theme.paires.length + mots_usable);
  if (roll < theme.paires.length) return theme.paires[roll];
  const first = randomInt(theme.mots.length);
  let second = randomInt(theme.mots.length - 1);
  if (second >= first) second += 1;
  return { civil: theme.mots[first], undercover: theme.mots[second] };
}

function pickPair(selected_themes) {
  const pool = selected_themes && selected_themes.length
    ? themes.filter((t) => selected_themes.includes(t.nom))
    : themes;
  const usable = pool.length ? pool : themes;
  const theme = usable[randomInt(usable.length)];
  return { theme: theme.nom, pair: drawFromTheme(theme) };
}

function resolvedCounts(room, player_count) {
  let undercover_count = room.settings.undercover_count;
  let mr_white_count = room.settings.mr_white_count;
  if (room.settings.auto_roles) {
    const auto = autoRoleCounts(player_count);
    undercover_count = auto.undercover_count;
    mr_white_count = auto.mr_white_count;
  }
  undercover_count = Math.max(0, Math.min(undercover_count, player_count - 2));
  mr_white_count = Math.max(0, Math.min(mr_white_count, player_count - 2 - undercover_count));
  if (undercover_count + mr_white_count === 0) undercover_count = 1;
  return { undercover_count, mr_white_count };
}

function startGame(room) {
  const roster = orderedPlayers(room);
  if (roster.length < MIN_PLAYERS) return 'Il faut au moins 3 joueurs pour lancer la partie.';

  const counts = resolvedCounts(room, roster.length);
  const picked = pickPair(room.settings.themes);
  const flip = randomInt(2) === 1;
  room.theme_used = picked.theme;
  room.pair = picked.pair;
  room.civil_word = flip ? picked.pair.undercover : picked.pair.civil;
  room.undercover_word = flip ? picked.pair.civil : picked.pair.undercover;

  const roles = [];
  for (let i = 0; i < counts.mr_white_count; i += 1) roles.push('mr_white');
  for (let i = 0; i < counts.undercover_count; i += 1) roles.push('undercover');
  while (roles.length < roster.length) roles.push('civil');
  const shuffled_roles = shuffle(roles);

  roster.forEach((player, index) => {
    player.role = shuffled_roles[index];
    player.word = player.role === 'mr_white' ? null : (player.role === 'undercover' ? room.undercover_word : room.civil_word);
    player.alive = true;
    player.ready = false;
    player.revealed = false;
  });

  let order = shuffle(roster.map((p) => p.id));
  for (let guard = 0; guard < 12; guard += 1) {
    const first = room.players.get(order[0]);
    if (first && first.role !== 'mr_white') break;
    order = shuffle(order);
  }

  room.seat_order = order;
  room.round = 1;
  room.round_order = order.slice();
  room.turn_pointer = 0;
  room.clue_history = [];
  room.votes = new Map();
  room.restart_votes = new Set();
  room.tie_between = null;
  room.tie_attempt = 0;
  room.last_eliminated = null;
  room.mr_white_guess = null;
  room.winner = null;
  room.phase = 'reveal';
  clearRoomTimer(room);
  console.log(`[game] ${room.code} started with ${roster.length} players (${counts.undercover_count} undercover, ${counts.mr_white_count} mr white)`);
  return null;
}

function beginClues(room) {
  room.phase = 'clues';
  room.votes = new Map();
  room.tie_between = null;
  room.tie_attempt = 0;
  room.round_order = room.seat_order.filter((id) => {
    const p = room.players.get(id);
    return p && p.alive;
  });
  room.turn_pointer = 0;
  clearRoomTimer(room);
  if (!room.settings.typed_clues) {
    beginDiscussion(room);
  }
}

function advanceClueTurn(room) {
  room.turn_pointer += 1;
  while (room.turn_pointer < room.round_order.length) {
    const player = room.players.get(room.round_order[room.turn_pointer]);
    if (player && player.alive) return;
    room.turn_pointer += 1;
  }
  beginDiscussion(room);
}

function beginDiscussion(room) {
  clearRoomTimer(room);
  room.phase = 'discussion';
  const seconds = Number(room.settings.discussion_seconds) || 0;
  if (seconds > 0) {
    room.deadline_ts = Date.now() + seconds * 1000;
    room.timer = setTimeout(() => {
      if (room.phase !== 'discussion') return;
      beginVote(room);
      broadcast(room);
    }, seconds * 1000 + 250);
  }
}

function beginVote(room) {
  clearRoomTimer(room);
  room.phase = 'vote';
  room.votes = new Map();
}

function tallyVotes(room) {
  const tally = new Map();
  room.votes.forEach((target_id) => {
    tally.set(target_id, (tally.get(target_id) || 0) + 1);
  });
  let best = -1;
  let leaders = [];
  tally.forEach((count, target_id) => {
    if (count > best) {
      best = count;
      leaders = [target_id];
    } else if (count === best) {
      leaders.push(target_id);
    }
  });
  return { leaders, best };
}

function resolveVote(room) {
  const result = tallyVotes(room);
  if (!result.leaders.length) {
    room.last_eliminated = null;
    nextRound(room);
    return;
  }
  if (result.leaders.length > 1) {
    room.tie_attempt += 1;
    const tie_breakers = alivePlayers(room).filter((p) => p.connected && !result.leaders.includes(p.id));
    if (room.tie_attempt >= 2 || !tie_breakers.length) {
      room.last_eliminated = { id: null, name: null, role: null, tie: true };
      room.phase = 'vote_result';
      room.tie_between = null;
      clearRoomTimer(room);
      room.timer = setTimeout(() => {
        if (room.phase !== 'vote_result') return;
        nextRound(room);
        broadcast(room);
      }, 6000);
      return;
    }
    room.tie_between = result.leaders;
    room.phase = 'vote';
    room.votes = new Map();
    return;
  }

  const target = room.players.get(result.leaders[0]);
  if (!target) {
    nextRound(room);
    return;
  }
  target.alive = false;
  target.revealed = true;
  room.last_eliminated = { id: target.id, name: target.name, role: target.role, tie: false };
  room.tie_between = null;
  room.phase = 'vote_result';
  clearRoomTimer(room);

  if (target.role === 'mr_white') {
    room.phase = 'mr_white_guess';
    room.mr_white_guess = { player_id: target.id, name: target.name, value: null, correct: null };
    room.deadline_ts = Date.now() + MR_WHITE_GUESS_MS;
    room.timer = setTimeout(() => {
      if (room.phase !== 'mr_white_guess') return;
      room.mr_white_guess.value = '';
      room.mr_white_guess.correct = false;
      clearRoomTimer(room);
      room.phase = 'vote_result';
      afterEliminationDelay(room);
      broadcast(room);
    }, MR_WHITE_GUESS_MS + 500);
    return;
  }

  afterEliminationDelay(room);
}

function afterEliminationDelay(room) {
  clearRoomTimer(room);
  room.timer = setTimeout(() => {
    if (room.phase !== 'vote_result') return;
    if (!checkEnd(room)) nextRound(room);
    broadcast(room);
  }, 6500);
}

function checkEnd(room) {
  const alive = alivePlayers(room);
  const civils = alive.filter((p) => p.role === 'civil');
  const infiltres = alive.filter((p) => p.role !== 'civil');
  if (infiltres.length === 0) {
    endGame(room, 'civils');
    return true;
  }
  if (civils.length <= infiltres.length) {
    endGame(room, 'infiltres');
    return true;
  }
  return false;
}

function endGame(room, winner) {
  clearRoomTimer(room);
  room.phase = 'ended';
  room.winner = winner;
  orderedPlayers(room).forEach((player) => {
    player.revealed = true;
    if (winner === 'civils' && player.role === 'civil') player.score += POINTS.civil;
    if (winner === 'infiltres' && player.role === 'undercover') player.score += POINTS.undercover;
    if (winner === 'infiltres' && player.role === 'mr_white') player.score += POINTS.mr_white;
    if (winner === 'mr_white' && player.role === 'mr_white') player.score += POINTS.mr_white + POINTS.undercover;
  });
  console.log(`[game] ${room.code} ended, winner=${winner}`);
}

function nextRound(room) {
  room.round += 1;
  room.last_eliminated = null;
  room.mr_white_guess = null;
  beginClues(room);
}

function resetToLobby(room) {
  clearRoomTimer(room);
  room.phase = 'lobby';
  room.round = 0;
  room.clue_history = [];
  room.votes = new Map();
  room.restart_votes = new Set();
  room.tie_between = null;
  room.tie_attempt = 0;
  room.last_eliminated = null;
  room.mr_white_guess = null;
  room.winner = null;
  room.pair = null;
  room.civil_word = null;
  room.undercover_word = null;
  room.theme_used = null;
  orderedPlayers(room).forEach((player) => {
    player.role = null;
    player.word = null;
    player.alive = true;
    player.ready = false;
    player.revealed = false;
  });
  const still_here = room.seat_order.filter((id) => {
    const p = room.players.get(id);
    return p && p.connected;
  });
  const gone = room.seat_order.filter((id) => !still_here.includes(id));
  gone.forEach((id) => room.players.delete(id));
  room.seat_order = still_here;
  if (!room.players.has(room.host_id)) pickHost(room);
}

/* ------------------------------------------------------------------ */
/* Message handling                                                    */
/* ------------------------------------------------------------------ */

function attachPlayer(room, ws, player) {
  if (player.ws && player.ws !== ws) {
    send(player.ws, { type: 'kicked', message: 'Session reprise depuis un autre onglet.' });
    try { player.ws.close(4000, 'replaced'); } catch (err) { /* noop */ }
  }
  player.ws = ws;
  player.connected = true;
  ws.room_code = room.code;
  ws.player_id = player.id;
  room.touched_at = Date.now();
  send(ws, {
    type: 'joined',
    code: room.code,
    player_id: player.id,
    token: player.token,
    name: player.name
  });
  send(ws, { type: 'chat_history', messages: room.chat.slice(-40) });
}

function handleCreate(ws, msg) {
  if (rooms.size >= MAX_ROOMS) return fail(ws, 'Serveur saturé, réessaie dans quelques minutes.');
  const name = cleanText(msg.name, 18);
  if (name.length < 2) return fail(ws, 'Choisis un pseudo de 2 caractères minimum.');
  const room = createRoom();
  if (!room) return fail(ws, 'Impossible de générer un code de partie.');
  const player = {
    id: makeId(),
    token: makeId(),
    name,
    ws: null,
    connected: false,
    alive: true,
    ready: false,
    role: null,
    word: null,
    revealed: false,
    score: 0
  };
  room.players.set(player.id, player);
  room.seat_order.push(player.id);
  room.host_id = player.id;
  attachPlayer(room, ws, player);
  broadcast(room);
}

function handleJoin(ws, msg) {
  const code = cleanText(msg.code, 8).toUpperCase();
  const name = cleanText(msg.name, 18);
  const room = rooms.get(code);
  if (!room) return fail(ws, `Aucune partie active avec le code ${code}.`);
  if (name.length < 2) return fail(ws, 'Choisis un pseudo de 2 caractères minimum.');
  if (room.players.size >= MAX_PLAYERS) return fail(ws, 'Cette partie est complète.');
  if (room.phase !== 'lobby') return fail(ws, 'La partie a déjà commencé. Attends la fin de la manche.');
  const taken = orderedPlayers(room).some((p) => p.name.toLowerCase() === name.toLowerCase());
  if (taken) return fail(ws, 'Ce pseudo est déjà pris dans la partie.');
  const player = {
    id: makeId(),
    token: makeId(),
    name,
    ws: null,
    connected: false,
    alive: true,
    ready: false,
    role: null,
    word: null,
    revealed: false,
    score: 0
  };
  room.players.set(player.id, player);
  room.seat_order.push(player.id);
  attachPlayer(room, ws, player);
  pushChat(room, null, `${name} rejoint la partie.`, 'system');
  broadcast(room);
}

function handleRejoin(ws, msg) {
  const code = cleanText(msg.code, 8).toUpperCase();
  const room = rooms.get(code);
  if (!room) return fail(ws, 'Partie introuvable, elle a peut-être expiré.');
  const player = room.players.get(String(msg.player_id || ''));
  if (!player || player.token !== msg.token) return fail(ws, 'Session expirée, rejoins avec le code.');
  attachPlayer(room, ws, player);
  broadcast(room);
}

function pushChat(room, player, text, kind) {
  const entry = {
    id: makeId(),
    from: player ? player.id : null,
    name: player ? player.name : null,
    text,
    kind: kind || 'player',
    alive: player ? player.alive : true,
    ts: Date.now()
  };
  room.chat.push(entry);
  if (room.chat.length > 200) room.chat.shift();
  broadcastRaw(room, { type: 'chat', message: entry });
}

function handleSettings(room, player, msg) {
  if (room.host_id !== player.id) return;
  if (room.phase !== 'lobby') return;
  const patch = msg.settings || {};
  const s = room.settings;
  if (Array.isArray(patch.themes)) {
    s.themes = patch.themes.filter((name) => theme_names.includes(name)).slice(0, themes.length);
  }
  if (typeof patch.auto_roles === 'boolean') s.auto_roles = patch.auto_roles;
  if (Number.isInteger(patch.undercover_count)) s.undercover_count = Math.max(0, Math.min(6, patch.undercover_count));
  if (Number.isInteger(patch.mr_white_count)) s.mr_white_count = Math.max(0, Math.min(4, patch.mr_white_count));
  if (typeof patch.reveal_role === 'boolean') s.reveal_role = patch.reveal_role;
  if (typeof patch.typed_clues === 'boolean') s.typed_clues = patch.typed_clues;
  if (Number.isInteger(patch.discussion_seconds)) {
    s.discussion_seconds = Math.max(0, Math.min(600, patch.discussion_seconds));
  }
}

function handleMessage(ws, data) {
  let msg;
  try {
    msg = JSON.parse(data);
  } catch (err) {
    return fail(ws, 'Message illisible.');
  }
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'create_room') return handleCreate(ws, msg);
  if (msg.type === 'join_room') return handleJoin(ws, msg);
  if (msg.type === 'rejoin') return handleRejoin(ws, msg);
  if (msg.type === 'pong') return;

  const room = rooms.get(ws.room_code);
  if (!room) return fail(ws, 'Tu n\'es dans aucune partie.');
  const player = room.players.get(ws.player_id);
  if (!player) return fail(ws, 'Joueur inconnu dans cette partie.');
  room.touched_at = Date.now();

  switch (msg.type) {
    case 'update_settings': {
      handleSettings(room, player, msg);
      broadcast(room);
      break;
    }
    case 'start_game': {
      if (room.host_id !== player.id) return fail(ws, 'Seul l\'hôte peut lancer la partie.');
      if (room.phase !== 'lobby') return fail(ws, 'La partie est déjà en cours.');
      const error = startGame(room);
      if (error) return fail(ws, error);
      broadcast(room);
      break;
    }
    case 'ready': {
      if (room.phase !== 'reveal') return;
      player.ready = true;
      const all_ready = orderedPlayers(room).every((p) => p.ready || !p.connected);
      if (all_ready) beginClues(room);
      broadcast(room);
      break;
    }
    case 'submit_clue': {
      if (room.phase !== 'clues') return fail(ws, 'Ce n\'est pas la phase des indices.');
      if (room.round_order[room.turn_pointer] !== player.id) return fail(ws, 'Ce n\'est pas ton tour.');
      const text = cleanText(msg.text, 40);
      if (!text) return fail(ws, 'Écris un indice avant de valider.');
      room.clue_history.push({
        round: room.round,
        player_id: player.id,
        name: player.name,
        text
      });
      advanceClueTurn(room);
      broadcast(room);
      break;
    }
    case 'skip_turn': {
      if (room.host_id !== player.id) return;
      if (room.phase !== 'clues') return;
      const current = room.players.get(room.round_order[room.turn_pointer]);
      if (current) {
        room.clue_history.push({
          round: room.round,
          player_id: current.id,
          name: current.name,
          text: '(passé)'
        });
      }
      advanceClueTurn(room);
      broadcast(room);
      break;
    }
    case 'open_vote': {
      if (room.host_id !== player.id) return;
      if (room.phase !== 'discussion' && room.phase !== 'clues') return;
      beginVote(room);
      broadcast(room);
      break;
    }
    case 'cast_vote': {
      if (room.phase !== 'vote') return fail(ws, 'Le vote n\'est pas ouvert.');
      if (!player.alive) return fail(ws, 'Les joueurs éliminés ne votent pas.');
      const target = room.players.get(String(msg.target_id || ''));
      if (!target || !target.alive) return fail(ws, 'Cible invalide.');
      if (target.id === player.id) return fail(ws, 'Impossible de voter pour toi.');
      if (room.tie_between) {
        if (room.tie_between.includes(player.id)) {
          return fail(ws, 'Tu es à égalité, tu ne votes pas dans ce second tour.');
        }
        if (!room.tie_between.includes(target.id)) {
          return fail(ws, 'Le second vote est limité aux joueurs à égalité.');
        }
      }
      room.votes.set(player.id, target.id);
      const eligible = alivePlayers(room).filter((p) => {
        if (!p.connected) return false;
        if (room.tie_between && room.tie_between.includes(p.id)) return false;
        return true;
      });
      if (eligible.length && eligible.every((p) => room.votes.has(p.id))) {
        resolveVote(room);
      }
      broadcast(room);
      break;
    }
    case 'force_vote_end': {
      if (room.host_id !== player.id) return;
      if (room.phase !== 'vote') return;
      if (!room.votes.size) return fail(ws, 'Aucun vote enregistré pour le moment.');
      resolveVote(room);
      broadcast(room);
      break;
    }
    case 'restart_words': {
      const allowed = ['reveal', 'clues', 'discussion', 'vote'];
      if (!allowed.includes(room.phase)) return;
      if (!player.alive) return fail(ws, 'Les joueurs éliminés ne participent pas à la relance.');
      if (room.restart_votes.has(player.id)) {
        room.restart_votes.delete(player.id);
      } else {
        room.restart_votes.add(player.id);
        pushChat(room, null, `${player.name} demande une relance des mots (${room.restart_votes.size} pour).`, 'system');
      }
      const eligible = alivePlayers(room).filter((p) => p.connected);
      if (eligible.length && eligible.every((p) => room.restart_votes.has(p.id))) {
        pushChat(room, null, 'Relance votée à l\'unanimité : nouveaux mots, nouveaux rôles.', 'system');
        const error = startGame(room);
        if (error) resetToLobby(room);
      }
      broadcast(room);
      break;
    }
    case 'mr_white_guess': {
      if (room.phase !== 'mr_white_guess') return;
      if (!room.mr_white_guess || room.mr_white_guess.player_id !== player.id) return;
      const value = cleanText(msg.text, 40);
      const correct = normalizeWord(value) === normalizeWord(room.civil_word);
      room.mr_white_guess.value = value;
      room.mr_white_guess.correct = correct;
      clearRoomTimer(room);
      if (correct) {
        endGame(room, 'mr_white');
      } else {
        room.phase = 'vote_result';
        afterEliminationDelay(room);
      }
      broadcast(room);
      break;
    }
    case 'new_round': {
      if (room.host_id !== player.id) return;
      if (room.phase !== 'ended') return;
      resetToLobby(room);
      const error = startGame(room);
      if (error) {
        broadcast(room);
        return fail(ws, error);
      }
      broadcast(room);
      break;
    }
    case 'back_to_lobby': {
      if (room.host_id !== player.id) return;
      resetToLobby(room);
      broadcast(room);
      break;
    }
    case 'kick': {
      if (room.host_id !== player.id) return;
      if (room.phase !== 'lobby') return fail(ws, 'Exclusion possible uniquement dans le salon.');
      const target = room.players.get(String(msg.target_id || ''));
      if (!target || target.id === player.id) return;
      send(target.ws, { type: 'kicked', message: 'L\'hôte t\'a retiré de la partie.' });
      if (target.ws) try { target.ws.close(4001, 'kicked'); } catch (err) { /* noop */ }
      room.players.delete(target.id);
      room.seat_order = room.seat_order.filter((id) => id !== target.id);
      pushChat(room, null, `${target.name} a été retiré de la partie.`, 'system');
      broadcast(room);
      break;
    }
    case 'chat': {
      const text = cleanText(msg.text, 240);
      if (!text) return;
      pushChat(room, player, text, 'player');
      break;
    }
    case 'rename': {
      if (room.phase !== 'lobby') return;
      const name = cleanText(msg.name, 18);
      if (name.length < 2) return fail(ws, 'Pseudo trop court.');
      player.name = name;
      broadcast(room);
      break;
    }
    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* HTTP static server                                                  */
/* ------------------------------------------------------------------ */

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function serveFile(res, file_path) {
  fs.readFile(file_path, (err, buffer) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(file_path).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME_TYPES[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300'
    });
    res.end(buffer);
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
    return;
  }
  const url = new URL(req.url, 'http://internal');
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, themes: themes.length, pairs: total_entries }));
    return;
  }
  if (pathname === '/api/themes') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      themes: themes.map((t) => ({ nom: t.nom, count: themeCount(t) })),
      total: total_entries
    }));
    return;
  }

  if (pathname === '/' || /^\/r\/[^/]*$/.test(pathname)) {
    serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
    return;
  }

  const target = path.join(PUBLIC_DIR, pathname.replace(/^\/+/, ''));
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('Forbidden');
    return;
  }
  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
      return;
    }
    serveFile(res, target);
  });
});

/* ------------------------------------------------------------------ */
/* WebSocket wiring                                                    */
/* ------------------------------------------------------------------ */

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

wss.on('connection', (ws) => {
  ws.is_alive = true;
  ws.on('pong', () => { ws.is_alive = true; });
  ws.on('message', (data) => handleMessage(ws, data.toString()));
  ws.on('close', () => {
    const room = rooms.get(ws.room_code);
    if (!room) return;
    const player = room.players.get(ws.player_id);
    if (!player || player.ws !== ws) return;
    player.connected = false;
    player.ws = null;
    if (room.phase === 'lobby') {
      room.players.delete(player.id);
      room.seat_order = room.seat_order.filter((id) => id !== player.id);
      pushChat(room, null, `${player.name} a quitté la partie.`, 'system');
    }
    if (room.host_id === player.id) pickHost(room);
    if (!room.players.size) {
      destroyRoom(room);
      return;
    }
    if (room.phase === 'clues' && room.round_order[room.turn_pointer] === player.id) {
      // keep the turn, host can skip it manually
    }
    broadcast(room);
  });
  ws.on('error', (err) => console.error('[ws] socket error', err.message));
  send(ws, { type: 'hello', themes: themes.map((t) => ({ nom: t.nom, count: themeCount(t) })) });
});

const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.is_alive === false) {
      try { ws.terminate(); } catch (err) { /* noop */ }
      return;
    }
    ws.is_alive = false;
    try { ws.ping(); } catch (err) { /* noop */ }
  });
}, 30000);

const janitor = setInterval(() => {
  const now = Date.now();
  rooms.forEach((room) => {
    const has_connected = orderedPlayers(room).some((p) => p.connected);
    if (!has_connected && now - room.touched_at > 10 * 60 * 1000) destroyRoom(room);
    else if (now - room.touched_at > ROOM_IDLE_MS) destroyRoom(room);
  });
}, 60000);

server.listen(PORT, BIND_HOST, () => {
  console.log(`[http] undercover server listening on http://${BIND_HOST}:${PORT}`);
});

function shutdown() {
  console.log('[http] shutting down');
  clearInterval(heartbeat);
  clearInterval(janitor);
  wss.clients.forEach((ws) => { try { ws.close(1001, 'server shutdown'); } catch (err) { /* noop */ } });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
