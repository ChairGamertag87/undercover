'use strict';

// Tests cibles: ordre de passage en mode vocal, relance unanime des mots,
// vote contre soi-meme.
const WebSocket = require('ws');

const BASE = process.env.BASE || 'ws://127.0.0.1:8099/ws';
const NAMES = ['Un', 'Deux', 'Trois', 'Quatre'];

const bots = [];
const errors = [];
let code = null;

function makeBot(name, index) {
  return new Promise((resolve) => {
    const bot = { name, index, id: null, token: null, ws: null, priv: null, state: null, waiters: [] };
    const ws = new WebSocket(BASE);
    bot.ws = ws;
    ws.on('open', () => {
      if (index === 0) ws.send(JSON.stringify({ type: 'create_room', name }));
      else ws.send(JSON.stringify({ type: 'join_room', name, code }));
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'joined') {
        bot.id = msg.player_id;
        bot.token = msg.token;
        if (index === 0) code = msg.code;
        resolve(bot);
      }
      if (msg.type === 'you') bot.priv = msg;
      if (msg.type === 'room') {
        bot.state = msg;
        bot.waiters = bot.waiters.filter((w) => {
          if (!w.test(msg)) return true;
          w.resolve(msg);
          return false;
        });
      }
      if (msg.type === 'error') {
        errors.push(`[${name}] ${msg.message}`);
        console.log(`  [err ${name}]`, msg.message);
      }
    });
    bots.push(bot);
  });
}

function send(bot, payload) {
  bot.ws.send(JSON.stringify(payload));
}

function waitState(bot, label, test) {
  return new Promise((resolve, reject) => {
    if (bot.state && test(bot.state)) return resolve(bot.state);
    const timer = setTimeout(() => reject(new Error(`timeout: ${label} (phase=${bot.state && bot.state.phase})`)), 8000);
    bot.waiters.push({ test, resolve: (s) => { clearTimeout(timer); resolve(s); } });
  });
}

function assert(cond, label) {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`  OK: ${label}`);
}

async function main() {
  const host = await makeBot(NAMES[0], 0);
  for (let i = 1; i < NAMES.length; i += 1) await makeBot(NAMES[i], i);
  await waitState(host, 'lobby complet', (s) => s.phase === 'lobby' && s.players.length === NAMES.length);

  send(host, {
    type: 'update_settings',
    settings: { auto_roles: false, undercover_count: 1, mr_white_count: 0, typed_clues: false, discussion_seconds: 0, reveal_role: true }
  });
  await waitState(host, 'settings appliques', (s) => s.settings.typed_clues === false);
  send(host, { type: 'start_game' });

  /* --- 1. mode vocal : ordre de passage expose --- */
  let state = await waitState(host, 'phase reveal', (s) => s.phase === 'reveal');
  assert(Array.isArray(state.round_order) && state.round_order.length === NAMES.length, 'round_order expose des la distribution');

  bots.forEach((b) => send(b, { type: 'ready' }));
  state = await waitState(host, 'debat direct en mode vocal', (s) => s.phase === 'discussion');
  assert(state.round_order.length === NAMES.length, 'round_order disponible pendant le debat vocal');
  const known_ids = new Set(state.players.map((p) => p.id));
  assert(state.round_order.every((id) => known_ids.has(id)), 'round_order ne contient que des joueurs de la salle');

  /* --- 2. relance unanime des mots --- */
  const first_words = { civil: null };
  const a_civil = bots.find((b) => b.priv && b.priv.role === 'civil');
  first_words.civil = a_civil.priv.word;

  send(bots[1], { type: 'restart_words' });
  send(bots[2], { type: 'restart_words' });
  send(bots[3], { type: 'restart_words' });
  state = await waitState(host, '3 votes de relance', (s) => (s.restart_votes || []).length === 3);
  assert(state.phase === 'discussion', 'pas de relance tant que le vote n\'est pas unanime');

  send(bots[1], { type: 'restart_words' });
  state = await waitState(host, 'annulation d\'un vote', (s) => (s.restart_votes || []).length === 2);
  send(bots[1], { type: 'restart_words' });
  await waitState(host, 'vote repose', (s) => (s.restart_votes || []).length === 3);

  send(host, { type: 'restart_words' });
  state = await waitState(host, 'relance effective', (s) => s.phase === 'reveal');
  assert(state.round === 1, 'la manche repart a la manche 1');
  assert((state.restart_votes || []).length === 0, 'les votes de relance sont remis a zero');
  console.log(`  info: mot civil avant relance "${first_words.civil}"`);

  /* --- 3. vote contre soi-meme --- */
  bots.forEach((b) => send(b, { type: 'ready' }));
  await waitState(host, 'retour au debat', (s) => s.phase === 'discussion');
  send(host, { type: 'open_vote' });
  await waitState(host, 'vote ouvert', (s) => s.phase === 'vote');

  const target = bots.find((b) => b.priv && b.priv.role === 'undercover');
  assert(Boolean(target), 'un undercover identifiable (reveal_role)');
  send(target, { type: 'cast_vote', target_id: target.id });
  state = await waitState(host, 'auto-vote enregistre', (s) => s.vote_count === 1);
  assert(errors.length === 0, 'l\'auto-vote ne declenche aucune erreur serveur');

  bots.filter((b) => b !== target).forEach((b) => send(b, { type: 'cast_vote', target_id: target.id }));
  state = await waitState(host, 'fin de manche', (s) => s.phase === 'ended');
  assert(state.last_eliminated && state.last_eliminated.id === target.id, 'le joueur auto-vote est bien elimine');
  assert(state.winner === 'civils', 'les civils gagnent apres elimination de l\'undercover');
  assert(errors.length === 0, 'aucune erreur serveur sur tout le scenario');

  console.log('OK');
  bots.forEach((b) => b.ws.close());
  process.exit(0);
}

main().catch((err) => {
  console.error(err.message);
  bots.forEach((b) => { try { b.ws.close(); } catch (e) { /* noop */ } });
  process.exit(1);
});

setTimeout(() => {
  console.error('TIMEOUT global');
  process.exit(1);
}, 60000);
