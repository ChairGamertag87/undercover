'use strict';

const WebSocket = require('ws');
const BASE = process.env.BASE || 'ws://127.0.0.1:8099/ws';

function client(name) {
  const bot = { name, id: null, token: null, code: null, state: null, priv: null, ws: null, handlers: [] };
  const open = () => new Promise((resolve) => {
    const ws = new WebSocket(BASE);
    bot.ws = ws;
    ws.on('open', resolve);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'joined') { bot.id = msg.player_id; bot.token = msg.token; bot.code = msg.code; }
      if (msg.type === 'room') bot.state = msg;
      if (msg.type === 'you') bot.priv = msg;
      if (msg.type === 'error') console.log(`  [err ${name}] ${msg.message}`);
      bot.handlers.forEach((fn) => fn(msg));
    });
  });
  bot.open = open;
  bot.send = (payload) => bot.ws.send(JSON.stringify(payload));
  return bot;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(bot, predicate, label, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (bot.state && predicate(bot.state)) return bot.state;
    await wait(80);
  }
  throw new Error(`timeout waiting for ${label}`);
}

(async () => {
  const a = client('Alpha');
  const b = client('Bravo');
  const c = client('Charlie');

  await a.open();
  a.send({ type: 'create_room', name: 'Alpha' });
  await waitFor(a, (s) => s.players.length === 1, 'room created');
  const code = a.code;
  console.log('room', code);

  await b.open();
  b.send({ type: 'join_room', name: 'Bravo', code });
  await c.open();
  c.send({ type: 'join_room', name: 'Charlie', code });
  await waitFor(a, (s) => s.players.length === 3, '3 players');

  // refus attendu: 4 caracteres inconnus
  const ghost = client('Ghost');
  await ghost.open();
  ghost.send({ type: 'join_room', name: 'Ghost', code: 'ZZZZ' });
  await wait(200);

  a.send({ type: 'update_settings', settings: { discussion_seconds: 0, reveal_role: true } });
  await wait(150);
  a.send({ type: 'start_game' });
  await waitFor(a, (s) => s.phase === 'reveal', 'reveal');
  [a, b, c].forEach((bot) => bot.send({ type: 'ready' }));
  await waitFor(a, (s) => s.phase === 'clues', 'clues');
  console.log('phase clues ok, roles:', [a, b, c].map((x) => `${x.name}=${x.priv.role}`).join(' '));

  // Bravo coupe sa connexion pendant la partie
  const saved = { code, player_id: b.id, token: b.token };
  b.ws.close();
  await wait(400);
  const off = a.state.players.find((p) => p.id === saved.player_id);
  console.log('Bravo connecte apres coupure ?', off.connected, '| toujours en jeu ?', off.alive);

  const b2 = client('Bravo');
  await b2.open();
  b2.send({ type: 'rejoin', code: saved.code, player_id: saved.player_id, token: saved.token });
  await waitFor(b2, (s) => s.phase === 'clues', 'rejoin');
  const back = b2.state.players.find((p) => p.id === saved.player_id);
  console.log('reconnexion ok:', back.connected, '| mot retrouve:', JSON.stringify(b2.priv.word));

  // rejoin avec mauvais token
  const bad = client('Faux');
  await bad.open();
  bad.send({ type: 'rejoin', code: saved.code, player_id: saved.player_id, token: 'mauvais' });
  await wait(250);

  // dérouler la manche jusqu'a la fin
  const trio = [a, b2, c];
  for (let guard = 0; guard < 40; guard += 1) {
    const s = a.state;
    if (s.phase === 'ended') break;
    if (s.phase === 'clues') {
      const bot = trio.find((x) => x.id === s.turn_id);
      if (bot) bot.send({ type: 'submit_clue', text: `indice-${s.round}` });
    } else if (s.phase === 'discussion') {
      a.send({ type: 'open_vote' });
    } else if (s.phase === 'vote') {
      trio.forEach((bot) => {
        const mine = s.players.find((p) => p.id === bot.id);
        if (!mine || !mine.alive || mine.has_voted) return;
        if (s.tie_between && s.tie_between.includes(bot.id)) return;
        const target = s.players.find((p) => {
          if (!p.alive || p.id === bot.id) return false;
          if (s.tie_between) return s.tie_between.includes(p.id);
          return p.role !== 'civil' || true;
        });
        if (target) bot.send({ type: 'cast_vote', target_id: target.id });
      });
    } else if (s.phase === 'mr_white_guess' && s.mr_white_guess) {
      const bot = trio.find((x) => x.id === s.mr_white_guess.player_id);
      if (bot) bot.send({ type: 'mr_white_guess', text: 'non' });
    }
    await wait(500);
  }
  await waitFor(a, (s) => s.phase === 'ended', 'ended', 20000);
  console.log('manche terminee, gagnant:', a.state.winner, '| scores:', a.state.players.map((p) => `${p.name}:${p.score}`).join(' '));

  // manche suivante par un non-hote (doit etre ignore) puis par l'hote
  c.send({ type: 'new_round' });
  await wait(300);
  console.log('phase apres tentative non-hote:', a.state.phase);
  a.send({ type: 'new_round' });
  await waitFor(a, (s) => s.phase === 'reveal', 'nouvelle manche');
  console.log('nouvelle manche lancee, scores conserves:', a.state.players.map((p) => `${p.name}:${p.score}`).join(' '));

  [a, b2, c, ghost, bad].forEach((x) => { try { x.ws.close(); } catch (e) {} });
  console.log('OK');
  process.exit(0);
})().catch((err) => { console.error('FAIL', err.message); process.exit(1); });
