'use strict';

// Simulation d'une partie complete: 6 joueurs, indices, votes, fin de manche.
const WebSocket = require('ws');

const BASE = process.env.BASE || 'ws://127.0.0.1:8099/ws';
const NAMES = ['Clement', 'Sabine', 'Marco', 'Lea', 'Yanis', 'Nour'];

const clients = [];
let room_code = null;
let done = false;

function log(...args) { console.log('[sim]', ...args); }

function makeClient(name, index) {
  const ws = new WebSocket(BASE);
  const client = { ws, name, index, id: null, state: null, priv: null, voted_round: -1, clue_round: -1, ready: false };
  ws.on('open', () => {
    if (index === 0) ws.send(JSON.stringify({ type: 'create_room', name }));
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'joined') {
      client.id = msg.player_id;
      if (index === 0) {
        room_code = msg.code;
        log('room created', room_code);
        NAMES.slice(1).forEach((other, i) => setTimeout(() => makeClient(other, i + 1), 60 * (i + 1)));
      }
    }
    if (msg.type === 'error') log(`ERROR(${name}):`, msg.message);
    if (msg.type === 'you') client.priv = msg;
    if (msg.type === 'room') {
      client.state = msg;
      react(client, msg);
    }
  });
  ws.on('close', () => { /* noop */ });
  clients.push(client);
  if (index > 0) {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join_room', name, code: room_code })));
  }
  return client;
}

function react(client, state) {
  if (done) return;
  const ws = client.ws;
  const send = (payload) => ws.send(JSON.stringify(payload));
  const mine = state.players.find((p) => p.id === client.id);
  if (!mine) return;

  if (state.phase === 'lobby') {
    if (client.index === 0 && state.players.length === NAMES.length && !client.started) {
      client.started = true;
      setTimeout(() => {
        send({ type: 'update_settings', settings: { auto_roles: false, undercover_count: 1, mr_white_count: 1, discussion_seconds: 0 } });
        setTimeout(() => send({ type: 'start_game' }), 80);
      }, 120);
    }
    return;
  }

  if (state.phase === 'reveal' && !mine.ready) {
    setTimeout(() => send({ type: 'ready' }), 40 + client.index * 15);
    return;
  }

  if (state.phase === 'clues' && state.turn_id === client.id && client.clue_round !== state.round) {
    client.clue_round = state.round;
    const word = client.priv && client.priv.word ? client.priv.word : 'improvise';
    setTimeout(() => send({ type: 'submit_clue', text: `${word.split(' ')[0].slice(0, 6)}-${state.round}` }), 40);
    return;
  }

  if (state.phase === 'discussion' && state.host_id === client.id) {
    setTimeout(() => send({ type: 'open_vote' }), 60);
    return;
  }

  if (state.phase === 'vote' && mine.alive && !mine.has_voted) {
    const blocked = state.tie_between && state.tie_between.includes(client.id);
    if (blocked) return;
    const vote_key = `${state.round}-${state.tie_between ? 'tie' : 'main'}`;
    if (client.vote_key === vote_key) return;
    client.vote_key = vote_key;
    const pool = state.players.filter((p) => {
      if (!p.alive || p.id === client.id) return false;
      if (state.tie_between) return state.tie_between.includes(p.id);
      return true;
    });
    if (!pool.length) return;
    const target = pool[0];
    setTimeout(() => send({ type: 'cast_vote', target_id: target.id }), 40 + client.index * 12);
    return;
  }

  if (state.phase === 'mr_white_guess' && state.mr_white_guess && state.mr_white_guess.player_id === client.id) {
    setTimeout(() => send({ type: 'mr_white_guess', text: 'reponse fausse volontaire' }), 60);
    return;
  }

  if (state.phase === 'ended' && client.index === 0 && !done) {
    done = true;
    log('winner:', state.winner);
    log('mot civil:', state.words.civil, '| mot undercover:', state.words.undercover, '| theme:', state.theme_used);
    state.players.forEach((p) => log(`  ${p.name.padEnd(9)} ${String(p.role).padEnd(11)} ${String(p.word || '-').padEnd(22)} ${p.score} pts`));
    log('indices deposes:', state.clue_history.length);
    setTimeout(() => {
      clients.forEach((c) => c.ws.close());
      process.exit(0);
    }, 300);
  }
}

makeClient(NAMES[0], 0);

setTimeout(() => {
  if (!done) {
    log('TIMEOUT, phase finale =', clients[0].state && clients[0].state.phase);
    process.exit(1);
  }
}, 70000);
