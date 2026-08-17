'use strict';

// Tests cibles: victoire civils, Mr White qui devine juste, reconnexion.
const WebSocket = require('ws');

const BASE = process.env.BASE || 'ws://127.0.0.1:8099/ws';
const scenario = process.argv[2] || 'civils';
const NAMES = ['Un', 'Deux', 'Trois', 'Quatre', 'Cinq'];

const bots = [];
let code = null;
let finished = false;

function makeBot(name, index, on_join) {
  const bot = { name, index, id: null, token: null, ws: null, priv: null, state: null, vote_key: null, clue_round: -1 };
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
      if (on_join) on_join(bot);
    }
    if (msg.type === 'you') bot.priv = msg;
    if (msg.type === 'room') { bot.state = msg; step(bot, msg); }
    if (msg.type === 'error') console.log(`  [err ${name}]`, msg.message);
  });
  bots.push(bot);
  return bot;
}

function godRole(player_id) {
  const bot = bots.find((b) => b.id === player_id);
  return bot && bot.priv ? bot.priv.role : null;
}

function pickTarget(state, voter_id) {
  const candidates = state.players.filter((p) => {
    if (!p.alive || p.id === voter_id) return false;
    if (state.tie_between) return state.tie_between.includes(p.id);
    return true;
  });
  if (!candidates.length) return null;
  const wanted = scenario === 'mrwhite' ? 'mr_white' : null;
  if (wanted) {
    const hit = candidates.find((p) => godRole(p.id) === wanted);
    if (hit) return hit;
  }
  const infiltre = candidates.find((p) => godRole(p.id) !== 'civil');
  return infiltre || candidates[0];
}

function step(bot, state) {
  if (finished) return;
  const send = (payload) => bot.ws.send(JSON.stringify(payload));
  const mine = state.players.find((p) => p.id === bot.id);
  if (!mine) return;

  if (state.phase === 'lobby' && bot.index === 0 && state.players.length === NAMES.length && !bot.started) {
    bot.started = true;
    send({ type: 'update_settings', settings: { auto_roles: false, undercover_count: 1, mr_white_count: 1, discussion_seconds: 0, reveal_role: true } });
    setTimeout(() => send({ type: 'start_game' }), 60);
    return;
  }
  if (state.phase === 'reveal' && !mine.ready) return void setTimeout(() => send({ type: 'ready' }), 30);
  if (state.phase === 'clues' && state.turn_id === bot.id && bot.clue_round !== state.round) {
    bot.clue_round = state.round;
    return void setTimeout(() => send({ type: 'submit_clue', text: `indice${state.round}` }), 25);
  }
  if (state.phase === 'discussion' && state.host_id === bot.id) {
    return void setTimeout(() => send({ type: 'open_vote' }), 40);
  }
  if (state.phase === 'vote' && mine.alive && !mine.has_voted) {
    if (state.tie_between && state.tie_between.includes(bot.id)) return;
    const key = `${state.round}-${state.tie_between ? 'tie' : 'main'}`;
    if (bot.vote_key === key) return;
    bot.vote_key = key;
    const target = pickTarget(state, bot.id);
    if (target) setTimeout(() => send({ type: 'cast_vote', target_id: target.id }), 30 + bot.index * 10);
    return;
  }
  if (state.phase === 'mr_white_guess' && state.mr_white_guess && state.mr_white_guess.player_id === bot.id) {
    const civil_word = bots.map((b) => b.priv).find((p) => p && p.role === 'civil');
    const answer = scenario === 'mrwhite' && civil_word ? civil_word.word : 'nawak';
    return void setTimeout(() => send({ type: 'mr_white_guess', text: answer }), 40);
  }
  if (state.phase === 'ended' && bot.index === 0) {
    finished = true;
    console.log(`  winner=${state.winner} | civil=${state.words.civil} | undercover=${state.words.undercover}`);
    state.players.forEach((p) => console.log(`   ${p.name.padEnd(7)} ${String(p.role).padEnd(11)} ${p.score} pts`));
    const expected = scenario === 'mrwhite' ? 'mr_white' : 'civils';
    const ok = state.winner === expected;
    console.log(ok ? `  OK: scenario ${scenario} valide` : `  FAIL: attendu ${expected}, recu ${state.winner}`);
    setTimeout(() => { bots.forEach((b) => b.ws.close()); process.exit(ok ? 0 : 1); }, 200);
  }
}

console.log(`scenario: ${scenario}`);
makeBot(NAMES[0], 0, () => {
  NAMES.slice(1).forEach((name, i) => setTimeout(() => makeBot(name, i + 1), 50 * (i + 1)));
});

setTimeout(() => {
  console.log('  TIMEOUT phase =', bots[0].state && bots[0].state.phase);
  process.exit(1);
}, 70000);
