'use strict';

/* ==================================================================
   Undercover client
   ================================================================== */

const el = (id) => document.getElementById(id);

const dom = {
  link_status: el('link-status'),
  room_badge: el('room-badge'),
  room_code: el('room-badge-code'),
  copy_link: el('btn-copy-link'),
  rules_btn: el('btn-rules'),
  rules_modal: el('modal-rules'),
  rules_close: el('btn-rules-close'),
  toasts: el('toast-stack'),

  screen_home: el('screen-home'),
  screen_lobby: el('screen-lobby'),
  screen_game: el('screen-game'),
  screen_end: el('screen-end'),

  input_name: el('input-name'),
  input_code: el('input-code'),
  btn_create: el('btn-create'),
  btn_join: el('btn-join'),
  home_error: el('home-error'),
  stat_pairs: el('stat-pairs'),
  stat_themes: el('stat-themes'),

  lobby_roster: el('lobby-roster'),
  lobby_count: el('lobby-count'),
  lobby_hint: el('lobby-hint'),
  btn_start: el('btn-start'),
  settings_form: el('settings-form'),
  settings_lock: el('settings-lock'),
  set_auto_roles: el('set-auto-roles'),
  manual_roles: el('manual-roles'),
  out_undercover: el('out-undercover'),
  out_mrwhite: el('out-mrwhite'),
  roles_preview: el('roles-preview'),
  set_timer: el('set-timer'),
  out_timer: el('out-timer'),
  set_typed_clues: el('set-typed-clues'),
  set_reveal_role: el('set-reveal-role'),
  theme_chips: el('theme-chips'),
  themes_hint: el('themes-hint'),
  btn_themes_all: el('btn-themes-all'),
  btn_themes_none: el('btn-themes-none'),

  status_round: el('status-round'),
  status_phase: el('status-phase'),
  status_timer: el('status-timer'),
  status_theme: el('status-theme'),
  table_wrap: document.querySelector('.table-wrap'),
  suspects: el('suspects'),
  action_title: el('action-title'),
  action_meta: el('action-meta'),
  action_body: el('action-body'),
  clue_log: el('clue-log'),
  log_meta: el('log-meta'),
  chat_log: el('chat-log'),
  chat_text: el('chat-text'),
  chat_send: el('chat-send'),

  verdict_eyebrow: el('verdict-eyebrow'),
  verdict_title: el('verdict-title'),
  verdict_text: el('verdict-text'),
  verdict_civil: el('verdict-civil'),
  verdict_undercover: el('verdict-undercover'),
  verdict_theme: el('verdict-theme'),
  reveal_list: el('reveal-list'),
  btn_again: el('btn-again'),
  btn_lobby: el('btn-lobby')
};

const PHASE_LABEL = {
  lobby: 'Salon',
  reveal: 'Distribution',
  clues: 'Indices',
  discussion: 'Débat',
  vote: 'Vote',
  vote_result: 'Verdict',
  mr_white_guess: 'Dernière chance',
  ended: 'Dossier clos'
};

const ROLE_LABEL = {
  civil: 'Civil',
  undercover: 'Undercover',
  mr_white: 'Mr White'
};

let socket = null;
let room = null;
let me = null;
let themes_catalog = [];
let vote_pick = null;
let reconnect_delay = 800;
let reconnect_timer = null;
let manual_close = false;
let last_phase = null;
let chat_seen = new Set();
let autofocus_key = null;
let scroll_key = null;

const suspect_nodes = new Map();

/* ------------------------------------------------------------------ */
/* Session storage                                                     */
/* ------------------------------------------------------------------ */

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem('undercover_session') || 'null');
  } catch (err) {
    return null;
  }
}

function saveSession(data) {
  try {
    localStorage.setItem('undercover_session', JSON.stringify(data));
  } catch (err) { /* noop */ }
}

function clearSession() {
  try { localStorage.removeItem('undercover_session'); } catch (err) { /* noop */ }
}

function savedName() {
  try { return localStorage.getItem('undercover_name') || ''; } catch (err) { return ''; }
}

function rememberName(name) {
  try { localStorage.setItem('undercover_name', name); } catch (err) { /* noop */ }
}

/* ------------------------------------------------------------------ */
/* Networking                                                          */
/* ------------------------------------------------------------------ */

function setLinkStatus(state, text) {
  dom.link_status.dataset.state = state;
  dom.link_status.textContent = text;
}

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  setLinkStatus('wait', 'connexion');
  socket = new WebSocket(`${protocol}://${location.host}/ws`);

  socket.addEventListener('open', () => {
    reconnect_delay = 800;
    setLinkStatus('on', 'en ligne');
    const session = loadSession();
    if (session && session.code && session.player_id) {
      sendMessage({ type: 'rejoin', code: session.code, player_id: session.player_id, token: session.token });
    }
  });

  socket.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch (err) { return; }
    handleServerMessage(msg);
  });

  socket.addEventListener('close', () => {
    setLinkStatus('off', 'hors ligne');
    if (manual_close) return;
    clearTimeout(reconnect_timer);
    reconnect_timer = setTimeout(connect, reconnect_delay);
    reconnect_delay = Math.min(reconnect_delay * 1.7, 8000);
  });

  socket.addEventListener('error', () => setLinkStatus('off', 'erreur reseau'));
}

function sendMessage(payload) {
  if (!socket || socket.readyState !== 1) {
    toast('Connexion en cours, réessaie dans un instant.', 'error');
    return;
  }
  socket.send(JSON.stringify(payload));
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'hello':
      themes_catalog = msg.themes || [];
      buildThemeChips();
      dom.stat_themes.textContent = String(themes_catalog.length);
      dom.stat_pairs.textContent = String(themes_catalog.reduce((a, t) => a + t.count, 0));
      break;
    case 'joined': {
      saveSession({ code: msg.code, player_id: msg.player_id, token: msg.token });
      history.replaceState(null, '', `/r/${msg.code}`);
      dom.room_badge.hidden = false;
      dom.room_code.textContent = msg.code;
      hideHomeError();
      break;
    }
    case 'room':
      room = msg;
      render();
      break;
    case 'you':
      me = msg;
      render();
      break;
    case 'chat':
      appendChat(msg.message);
      break;
    case 'chat_history':
      dom.chat_log.innerHTML = '';
      chat_seen = new Set();
      (msg.messages || []).forEach(appendChat);
      break;
    case 'toast':
      toast(msg.message, msg.kind);
      break;
    case 'error':
      if (!room) showHomeError(msg.message);
      else toast(msg.message, 'error');
      break;
    case 'kicked':
      clearSession();
      room = null;
      me = null;
      history.replaceState(null, '', '/');
      dom.room_badge.hidden = true;
      render();
      toast(msg.message, 'error');
      break;
    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function toast(message, kind) {
  const node = document.createElement('div');
  node.className = 'toast';
  node.dataset.kind = kind || 'info';
  node.textContent = message;
  dom.toasts.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 300);
  }, 4200);
}

function showHomeError(message) {
  dom.home_error.textContent = message;
  dom.home_error.hidden = false;
}

function hideHomeError() {
  dom.home_error.hidden = true;
}

function initials(name) {
  const parts = String(name).trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function playerById(id) {
  if (!room) return null;
  return room.players.find((p) => p.id === id) || null;
}

function isHost() {
  return Boolean(room && me && room.host_id === me.id);
}

function myPlayer() {
  return me ? playerById(me.id) : null;
}

function pad2(value) {
  return value < 10 ? `0${value}` : String(value);
}

function captureFocus() {
  const node = document.activeElement;
  if (!node || !node.id) return null;
  const inside = dom.action_body.contains(node);
  if (!inside) return null;
  return {
    id: node.id,
    value: node.value,
    start: node.selectionStart,
    end: node.selectionEnd
  };
}

function restoreFocus(snapshot) {
  if (!snapshot) return;
  const node = el(snapshot.id);
  if (!node) return;
  if (typeof snapshot.value === 'string' && !node.value) node.value = snapshot.value;
  node.focus();
  try { node.setSelectionRange(snapshot.start, snapshot.end); } catch (err) { /* noop */ }
}

/* ------------------------------------------------------------------ */
/* Render dispatch                                                     */
/* ------------------------------------------------------------------ */

function render() {
  const phase = room ? room.phase : null;

  if (!room) {
    showScreen('home');
    dom.room_badge.hidden = true;
    return;
  }

  dom.room_badge.hidden = false;
  dom.room_code.textContent = room.code;

  if (phase === 'lobby') {
    showScreen('lobby');
    renderLobby();
  } else if (phase === 'ended') {
    showScreen('end');
    renderEnd();
  } else {
    showScreen('game');
    renderGame();
  }

  if (phase !== last_phase) {
    last_phase = phase;
    if (phase === 'vote') vote_pick = null;
  }
}

function showScreen(name) {
  dom.screen_home.hidden = name !== 'home';
  dom.screen_lobby.hidden = name !== 'lobby';
  dom.screen_game.hidden = name !== 'game';
  dom.screen_end.hidden = name !== 'end';
}

/* ------------------------------------------------------------------ */
/* Lobby                                                               */
/* ------------------------------------------------------------------ */

function buildThemeChips() {
  if (!themes_catalog.length || dom.theme_chips.childElementCount) return;
  themes_catalog.forEach((theme) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.theme = theme.nom;
    chip.setAttribute('aria-pressed', 'false');
    chip.textContent = theme.nom;
    chip.addEventListener('click', () => {
      if (!isHost()) return;
      const current = new Set(room.settings.themes || []);
      if (current.has(theme.nom)) current.delete(theme.nom);
      else current.add(theme.nom);
      sendMessage({ type: 'update_settings', settings: { themes: Array.from(current) } });
    });
    dom.theme_chips.appendChild(chip);
  });
}

function renderLobby() {
  const host = isHost();
  const count = room.players.length;

  dom.lobby_count.textContent = `${count} / ${room.max_players}`;
  dom.lobby_roster.innerHTML = '';

  room.players.forEach((player, index) => {
    const li = document.createElement('li');
    li.className = 'roster-item';
    li.dataset.host = player.is_host ? '1' : '0';
    li.dataset.me = me && player.id === me.id ? '1' : '0';
    li.dataset.off = player.connected ? '0' : '1';

    const num = document.createElement('span');
    num.className = 'matricule';
    num.textContent = pad2(index + 1);

    const name = document.createElement('span');
    name.className = 'roster-name';
    name.textContent = player.name;

    const tags = document.createElement('span');
    tags.className = 'roster-tags';
    if (player.is_host) tags.appendChild(makeTag('hote', 'host'));
    if (me && player.id === me.id) tags.appendChild(makeTag('toi', 'me'));
    if (!player.connected) tags.appendChild(makeTag('absent', 'off'));
    if (player.score) tags.appendChild(makeTag(`${player.score} pts`, 'score'));
    if (host && me && player.id !== me.id) {
      const kick = document.createElement('button');
      kick.type = 'button';
      kick.className = 'kick-btn';
      kick.textContent = 'retirer';
      kick.addEventListener('click', () => sendMessage({ type: 'kick', target_id: player.id }));
      tags.appendChild(kick);
    }

    li.append(num, name, tags);
    dom.lobby_roster.appendChild(li);
  });

  const enough = count >= room.min_players;
  dom.btn_start.disabled = !host || !enough;
  dom.btn_start.textContent = host ? 'Lancer la manche' : 'En attente de l\'hôte';
  dom.lobby_hint.textContent = enough
    ? (host ? 'Tout le monde est là ? Lance la manche.' : 'L\'hôte lance la manche quand vous êtes prêts.')
    : `Il manque ${room.min_players - count} joueur(s). Partage le lien du dossier.`;

  dom.settings_form.disabled = !host;
  dom.settings_lock.textContent = host ? 'tu décides' : 'hôte uniquement';

  const s = room.settings;
  dom.set_auto_roles.checked = s.auto_roles;
  dom.manual_roles.hidden = s.auto_roles;
  dom.out_undercover.textContent = String(s.undercover_count);
  dom.out_mrwhite.textContent = String(s.mr_white_count);
  dom.set_timer.value = String(s.discussion_seconds);
  dom.out_timer.textContent = s.discussion_seconds === 0 ? 'libre' : `${s.discussion_seconds} s`;
  dom.set_typed_clues.checked = s.typed_clues;
  dom.set_reveal_role.checked = s.reveal_role;

  const selected = new Set(s.themes || []);
  Array.from(dom.theme_chips.children).forEach((chip) => {
    chip.setAttribute('aria-pressed', selected.has(chip.dataset.theme) ? 'true' : 'false');
  });
  dom.themes_hint.textContent = selected.size
    ? `${selected.size} thème(s) coché(s) dans le tirage.`
    : 'Aucun thème coché : tirage dans les 500 paires.';

  dom.roles_preview.textContent = rolePreview(count, s);
}

function makeTag(text, kind) {
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.dataset.kind = kind;
  tag.textContent = text;
  return tag;
}

function autoCounts(player_count) {
  if (player_count <= 4) return { undercover_count: 1, mr_white_count: 0 };
  if (player_count <= 6) return { undercover_count: 1, mr_white_count: 1 };
  if (player_count <= 9) return { undercover_count: 2, mr_white_count: 1 };
  if (player_count <= 12) return { undercover_count: 3, mr_white_count: 1 };
  return { undercover_count: 3, mr_white_count: 2 };
}

function rolePreview(count, settings) {
  if (count < room.min_players) return 'Répartition affichée à partir de 3 joueurs.';
  const base = settings.auto_roles ? autoCounts(count) : settings;
  let undercover = Math.max(0, Math.min(base.undercover_count, count - 2));
  let mr_white = Math.max(0, Math.min(base.mr_white_count, count - 2 - undercover));
  if (undercover + mr_white === 0) undercover = 1;
  const civils = count - undercover - mr_white;
  return `${count} joueurs : ${civils} civils, ${undercover} undercover, ${mr_white} Mr White.`;
}

/* ------------------------------------------------------------------ */
/* Game                                                               */
/* ------------------------------------------------------------------ */

function renderGame() {
  dom.status_round.textContent = String(room.round);
  dom.status_phase.textContent = room.phase === 'vote' && room.tie_between
    ? 'Vote décisif'
    : (PHASE_LABEL[room.phase] || room.phase);
  dom.status_theme.textContent = `${room.alive_count} en jeu`;

  renderSuspects();
  const snapshot = captureFocus();
  renderAction();
  restoreFocus(snapshot);
  renderClueLog();
  updateLamp();
  updateTimer();
  maybeScrollToAction();
}

function maybeScrollToAction() {
  if (window.innerWidth > 760) return;
  const mine = myPlayer();
  if (!mine || !mine.alive) return;
  let key = null;
  if (room.phase === 'clues' && room.turn_id === me.id) key = `clue-${room.round}`;
  if (room.phase === 'vote' && !mine.has_voted && vote_pick) {
    key = `vote-${room.round}-${vote_pick}`;
  }
  if (room.phase === 'mr_white_guess' && room.mr_white_guess && room.mr_white_guess.player_id === me.id) {
    key = `guess-${room.round}`;
  }
  if (!key || scroll_key === key) return;
  scroll_key = key;
  const anchor = document.querySelector('.panel-action');
  if (!anchor) return;
  setTimeout(() => anchor.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
}

function suspectStateFor(player) {
  if (!player.alive) return 'dead';
  if (room.phase === 'clues' && room.turn_id === player.id) return 'speaking';
  if (room.phase === 'clues') return 'waiting';
  return 'idle';
}

function renderSuspects() {
  const seen = new Set();

  room.players.forEach((player, index) => {
    seen.add(player.id);
    let node = suspect_nodes.get(player.id);
    if (!node) {
      node = document.createElement('li');
      node.className = 'suspect';
      node.dataset.id = player.id;
      node.innerHTML = `
        <div class="suspect-photo"></div>
        <div class="suspect-name"></div>
        <div class="suspect-line"></div>
        <div class="suspect-clue"></div>
        <div class="suspect-votes"></div>`;
      node.addEventListener('click', () => onSuspectClick(player.id));
      suspect_nodes.set(player.id, node);
    }

    node.querySelector('.suspect-photo').textContent = initials(player.name);
    node.querySelector('.suspect-name').textContent = player.name;
    node.querySelector('.suspect-line').textContent = suspectLine(player, index);
    node.querySelector('.suspect-clue').textContent = lastClueOf(player.id);

    const state = suspectStateFor(player);
    node.dataset.state = state;
    node.dataset.dead = player.alive ? '0' : '1';
    node.dataset.off = player.connected ? '0' : '1';
    node.dataset.stamp = player.role ? ROLE_LABEL[player.role] : 'Éliminé';

    const pickable = canVoteFor(player);
    node.dataset.pickable = pickable ? '1' : '0';
    node.dataset.picked = vote_pick === player.id ? '1' : '0';

    const votes_box = node.querySelector('.suspect-votes');
    votes_box.innerHTML = '';
    if (room.phase === 'vote_result' || room.phase === 'ended') {
      const received = (room.votes || []).filter((entry) => entry[1] === player.id).length;
      for (let i = 0; i < received; i += 1) {
        const pip = document.createElement('span');
        pip.className = 'vote-pip';
        votes_box.appendChild(pip);
      }
    }

    dom.suspects.appendChild(node);
  });

  suspect_nodes.forEach((node, id) => {
    if (!seen.has(id)) {
      node.remove();
      suspect_nodes.delete(id);
    }
  });
}

function suspectLine(player, index) {
  if (!player.alive) return `éliminé ${player.role ? '/ ' + ROLE_LABEL[player.role] : ''}`;
  if (!player.connected) return 'déconnecté';
  if (room.phase === 'reveal') return player.ready ? 'fiche lue' : 'lit sa fiche';
  if (room.phase === 'clues') {
    if (room.turn_id === player.id) return 'au micro';
    return player.has_clue ? 'indice donné' : 'en attente';
  }
  if (room.phase === 'vote') {
    if (room.tie_between && room.tie_between.includes(player.id)) return 'à égalité';
    return player.has_voted ? 'a voté' : 'hésite encore';
  }
  if (room.phase === 'discussion' && !room.settings.typed_clues) {
    const order = speakOrderOf(player.id);
    if (order) return order === 1 ? 'parle en 1er' : `parle en ${order}e`;
  }
  return `matricule ${pad2(index + 1)}`;
}

function speakOrderOf(player_id) {
  const order = (room.round_order || []).filter((id) => {
    const p = playerById(id);
    return p && p.alive;
  });
  const index = order.indexOf(player_id);
  return index === -1 ? null : index + 1;
}

function lastClueOf(player_id) {
  const clues = room.clue_history.filter((c) => c.player_id === player_id && c.round === room.round);
  if (!clues.length) return '';
  return clues[clues.length - 1].text;
}

function canVoteFor(player) {
  if (room.phase !== 'vote') return false;
  const mine = myPlayer();
  if (!mine || !mine.alive) return false;
  if (mine.has_voted) return false;
  if (!player.alive || player.id === me.id) return false;
  if (room.tie_between) {
    if (room.tie_between.includes(me.id)) return false;
    return room.tie_between.includes(player.id);
  }
  return true;
}

function onSuspectClick(player_id) {
  const player = playerById(player_id);
  if (!player || !canVoteFor(player)) return;
  vote_pick = vote_pick === player_id ? null : player_id;
  renderSuspects();
  renderAction();
  maybeScrollToAction();
}

function updateLamp() {
  let target_id = null;
  if (room.phase === 'clues') target_id = room.turn_id;
  if ((room.phase === 'vote_result' || room.phase === 'mr_white_guess') && room.last_eliminated) {
    target_id = room.last_eliminated.id;
  }
  const wrap = dom.table_wrap;
  if (!target_id) {
    wrap.style.setProperty('--beam-x', '50%');
    wrap.dataset.lamp = 'off';
    return;
  }
  const node = suspect_nodes.get(target_id);
  if (!node) return;
  const wrap_box = wrap.getBoundingClientRect();
  const node_box = node.getBoundingClientRect();
  const center = node_box.left + node_box.width / 2 - wrap_box.left;
  const percent = Math.max(4, Math.min(96, (center / wrap_box.width) * 100));
  wrap.style.setProperty('--beam-x', `${percent.toFixed(2)}%`);
  wrap.dataset.lamp = 'on';
}

/* ------------------------------------------------------------------ */
/* Action panel                                                        */
/* ------------------------------------------------------------------ */

function renderAction() {
  const mine = myPlayer();
  dom.action_body.innerHTML = '';
  dom.action_meta.textContent = '';

  if (room.phase === 'reveal') return renderRevealPanel(mine);
  if (room.phase === 'clues') return renderCluesPanel(mine);
  if (room.phase === 'discussion') return renderDiscussionPanel(mine);
  if (room.phase === 'vote') return renderVotePanel(mine);
  if (room.phase === 'vote_result') return renderResultPanel();
  if (room.phase === 'mr_white_guess') return renderGuessPanel(mine);
}

function addText(html) {
  const p = document.createElement('p');
  p.className = 'action-text';
  p.innerHTML = html;
  dom.action_body.appendChild(p);
  return p;
}

function addButton(label, kind, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = kind === 'primary' ? 'primary-btn' : 'secondary-btn';
  button.textContent = label;
  button.addEventListener('click', handler);
  dom.action_body.appendChild(button);
  return button;
}

function buildDossier() {
  const box = document.createElement('div');
  box.className = 'dossier';
  box.dataset.open = '0';
  const is_mr_white = me && me.role === 'mr_white';
  const word_text = me && me.word ? me.word : 'Aucun mot';
  const role_text = me && me.role ? ROLE_LABEL[me.role] : 'Camp non communiqué';

  box.innerHTML = `
    <span class="dossier-label">Fiche confidentielle</span>
    <span class="dossier-word">${escapeHtml(word_text)}</span>
    <span class="dossier-role" data-alert="${is_mr_white ? '1' : '0'}">${escapeHtml(is_mr_white ? 'Tu es Mr White' : role_text)}</span>
    <span class="dossier-seal"><span>Maintiens pour lire</span><strong>Scellé</strong></span>`;

  const open = () => { box.dataset.open = '1'; };
  const close = () => { box.dataset.open = '0'; };
  box.addEventListener('pointerdown', (event) => { event.preventDefault(); open(); });
  box.addEventListener('pointerup', close);
  box.addEventListener('pointerleave', close);
  box.addEventListener('pointercancel', close);
  box.addEventListener('keydown', (event) => { if (event.key === ' ' || event.key === 'Enter') open(); });
  box.addEventListener('keyup', close);
  box.tabIndex = 0;
  dom.action_body.appendChild(box);
  return box;
}

function renderRevealPanel(mine) {
  dom.action_title.textContent = 'Ta fiche';
  const ready_count = room.players.filter((p) => p.ready).length;
  dom.action_meta.textContent = `${ready_count} / ${room.players.length} prêts`;
  buildDossier();
  if (me && me.role === 'mr_white') {
    addText('Tu n\'as pas de mot. Écoute les indices, imite le groupe, et si on t\'élimine tu auras une chance de deviner le mot des civils.');
  } else if (room.settings.reveal_role) {
    addText('Ton mot et ton camp sont sur la fiche. Ne le lâche pas.');
  } else {
    addText('Tu connais ton mot, pas ton camp. Il est peut-être celui de la majorité, peut-être pas.');
  }
  if (mine && !mine.ready) {
    addButton('J\'ai lu ma fiche', 'primary', () => sendMessage({ type: 'ready' }));
  } else {
    addText('En attente des autres joueurs.');
  }
}

function renderCluesPanel(mine) {
  const my_turn = room.turn_id === (me && me.id);
  dom.action_title.textContent = my_turn ? 'À toi de parler' : 'Tour de table';
  const current = playerById(room.turn_id);
  dom.action_meta.textContent = current ? `au micro : ${current.name}` : '';

  buildDossier();

  if (my_turn) {
    const form = document.createElement('div');
    form.className = 'clue-form';
    form.innerHTML = `
      <input id="clue-input" type="text" maxlength="40" placeholder="Un mot, pas une définition" autocomplete="off">
      <button id="clue-send" class="primary-btn" type="button">Déposer</button>`;
    dom.action_body.appendChild(form);
    const input = el('clue-input');
    const submit = () => {
      const text = input.value.trim();
      if (!text) return;
      sendMessage({ type: 'submit_clue', text });
      input.value = '';
    };
    el('clue-send').addEventListener('click', submit);
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(); });
    const key = `clue-${room.round}-${me.id}`;
    if (autofocus_key !== key) {
      autofocus_key = key;
      setTimeout(() => input.focus(), 30);
    }
  } else if (mine && !mine.alive) {
    addText('Tu es hors jeu. Tu peux suivre la manche et commenter dans la salle.');
  } else {
    addText(current ? `<strong>${escapeHtml(current.name)}</strong> cherche son indice.` : 'Tour en cours.');
  }

  const queue = document.createElement('div');
  queue.className = 'turn-queue';
  const order = room.clue_history.length ? room.clue_history : [];
  const alive_order = room.players.filter((p) => p.alive);
  alive_order.forEach((player, index) => {
    const clue = order.filter((c) => c.round === room.round && c.player_id === player.id).slice(-1)[0];
    const row = document.createElement('div');
    row.className = 'queue-item';
    row.dataset.current = room.turn_id === player.id ? '1' : '0';
    row.dataset.done = clue ? '1' : '0';
    row.innerHTML = `<span>${pad2(index + 1)}</span><span>${escapeHtml(player.name)}</span><span class="queue-clue">${escapeHtml(clue ? clue.text : '...')}</span>`;
    queue.appendChild(row);
  });
  dom.action_body.appendChild(queue);

  if (isHost() && current && !current.connected) {
    addButton(`Passer le tour de ${current.name}`, 'secondary', () => sendMessage({ type: 'skip_turn' }));
  }
}

function renderDiscussionPanel(mine) {
  dom.action_title.textContent = 'Débat';
  dom.action_meta.textContent = room.settings.discussion_seconds ? 'chrono lancé' : 'sans chrono';
  buildDossier();
  if (!room.settings.typed_clues) {
    addText('Mode vocal : donnez vos indices à voix haute dans l\'ordre ci-dessous, puis débattez.');
    const queue = document.createElement('div');
    queue.className = 'turn-queue';
    const order = (room.round_order || []).map((id) => playerById(id)).filter((p) => p && p.alive);
    order.forEach((player, index) => {
      const row = document.createElement('div');
      row.className = 'queue-item';
      row.dataset.current = index === 0 ? '1' : '0';
      row.dataset.done = '0';
      const mark = me && player.id === me.id ? ' (toi)' : '';
      row.innerHTML = `<span>${pad2(index + 1)}</span><span>${escapeHtml(player.name)}${mark}</span><span class="queue-clue">${index === 0 ? 'commence' : ''}</span>`;
      queue.appendChild(row);
    });
    dom.action_body.appendChild(queue);
  } else {
    addText('Tous les indices sont déposés. Accusez, défendez, cherchez la fausse note. Le vote suit.');
  }
  if (isHost()) addButton('Ouvrir le vote', 'primary', () => sendMessage({ type: 'open_vote' }));
  else addText('L\'hôte ouvre le vote quand le débat est fini.');
  if (mine && !mine.alive) addText('Tu es éliminé : tu peux parler, mais tu ne votes plus.');
}

function renderVotePanel(mine) {
  dom.action_title.textContent = room.tie_between ? 'Vote décisif' : 'Vote';
  const alive = room.players.filter((p) => p.alive);
  const voters = room.tie_between
    ? alive.filter((p) => !room.tie_between.includes(p.id))
    : alive;
  dom.action_meta.textContent = `${voters.filter((p) => p.has_voted).length} / ${voters.length} votes`;

  if (room.tie_between) {
    const names = room.tie_between.map((id) => (playerById(id) || {}).name).filter(Boolean).join(' et ');
    addText(`Égalité entre <strong>${escapeHtml(names)}</strong>. Les autres joueurs tranchent, sinon personne ne sort.`);
  }

  if (!mine || !mine.alive) {
    addText('Tu es hors jeu, tu regardes le vote se dérouler.');
  } else if (room.tie_between && room.tie_between.includes(me.id)) {
    addText('Tu es concerné par l\'égalité : tu ne votes pas ce tour.');
  } else if (mine.has_voted) {
    addText('Ton vote est enregistré. On attend les autres.');
  } else {
    const picked = vote_pick ? playerById(vote_pick) : null;
    addText(picked
      ? `Tu désignes <strong>${escapeHtml(picked.name)}</strong>. Confirme pour valider.`
      : 'Clique sur une fiche pour désigner un suspect.');
    const button = addButton(picked ? `Voter contre ${picked.name}` : 'Choisis un suspect', 'primary', () => {
      if (!vote_pick) return;
      sendMessage({ type: 'cast_vote', target_id: vote_pick });
    });
    button.disabled = !vote_pick;
  }

  buildDossier();

  if (isHost() && room.vote_count > 0) {
    addButton('Clore le vote maintenant', 'secondary', () => sendMessage({ type: 'force_vote_end' }));
  }
}

function renderResultPanel() {
  dom.action_title.textContent = 'Verdict';
  const info = room.last_eliminated;
  if (!info) {
    addText('Depouillement en cours.');
    return;
  }
  if (info.tie) {
    addText('Égalité maintenue : personne n\'est éliminé, on repart sur un tour d\'indices.');
  } else {
    addText(`<strong>${escapeHtml(info.name)}</strong> est éliminé. Rôle réel : <strong>${escapeHtml(ROLE_LABEL[info.role] || '?')}</strong>.`);
  }
  if (room.mr_white_guess && room.mr_white_guess.correct !== null) {
    const guess = room.mr_white_guess;
    addText(guess.correct
      ? `Mr White a deviné le mot : <strong>${escapeHtml(guess.value)}</strong>.`
      : `Mr White a proposé <strong>${escapeHtml(guess.value || 'rien')}</strong>, ce n'était pas le bon mot.`);
  }
  const tally = document.createElement('div');
  tally.className = 'tally';
  const counts = new Map();
  (room.votes || []).forEach(([, target]) => counts.set(target, (counts.get(target) || 0) + 1));
  Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .forEach(([target_id, count]) => {
      const player = playerById(target_id);
      const row = document.createElement('div');
      row.className = 'tally-row';
      row.innerHTML = `<span>${escapeHtml(player ? player.name : '?')}</span><span>${count} voix</span>`;
      tally.appendChild(row);
    });
  if (counts.size) dom.action_body.appendChild(tally);
  addText('La suite arrive automatiquement.');
}

function renderGuessPanel(mine) {
  dom.action_title.textContent = 'Dernière chance';
  const guess = room.mr_white_guess;
  const target = guess ? playerById(guess.player_id) : null;
  dom.action_meta.textContent = target ? target.name : '';

  if (me && guess && guess.player_id === me.id) {
    addText('Tu es Mr White et tu viens de sortir. Devine le mot des civils pour renverser la manche.');
    const form = document.createElement('div');
    form.className = 'clue-form';
    form.innerHTML = `
      <input id="guess-input" type="text" maxlength="40" placeholder="Le mot des civils" autocomplete="off">
      <button id="guess-send" class="primary-btn" type="button">Proposer</button>`;
    dom.action_body.appendChild(form);
    const input = el('guess-input');
    const submit = () => {
      const text = input.value.trim();
      if (!text) return;
      sendMessage({ type: 'mr_white_guess', text });
      input.value = '';
    };
    el('guess-send').addEventListener('click', submit);
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(); });
    const key = `guess-${room.round}`;
    if (autofocus_key !== key) {
      autofocus_key = key;
      setTimeout(() => input.focus(), 30);
    }
  } else {
    addText(`<strong>${escapeHtml(target ? target.name : 'Mr White')}</strong> était Mr White. Il tente de deviner votre mot.`);
    if (mine) buildDossier();
  }
}

/* ------------------------------------------------------------------ */
/* Clue log + chat                                                     */
/* ------------------------------------------------------------------ */

function renderClueLog() {
  dom.clue_log.innerHTML = '';
  if (!room.clue_history.length) {
    const empty = document.createElement('p');
    empty.className = 'log-empty';
    empty.textContent = 'Aucun indice déposé pour le moment.';
    dom.clue_log.appendChild(empty);
    dom.log_meta.textContent = '';
    return;
  }
  dom.log_meta.textContent = `${room.clue_history.length} entrées`;

  const rounds = new Map();
  room.clue_history.forEach((clue) => {
    if (!rounds.has(clue.round)) rounds.set(clue.round, []);
    rounds.get(clue.round).push(clue);
  });

  Array.from(rounds.keys()).sort((a, b) => b - a).forEach((round_number) => {
    const block = document.createElement('div');
    const title = document.createElement('p');
    title.className = 'log-round-title';
    title.textContent = `Manche ${round_number}`;
    block.appendChild(title);
    rounds.get(round_number).forEach((clue) => {
      const line = document.createElement('div');
      line.className = 'log-line';
      line.innerHTML = `<strong>${escapeHtml(clue.name)}</strong><em>${escapeHtml(clue.text)}</em>`;
      block.appendChild(line);
    });
    dom.clue_log.appendChild(block);
  });
}

function appendChat(entry) {
  if (!entry || chat_seen.has(entry.id)) return;
  chat_seen.add(entry.id);
  const line = document.createElement('p');
  line.className = 'chat-line';
  line.dataset.kind = entry.kind;
  line.dataset.dead = entry.alive ? '0' : '1';
  if (entry.kind === 'system') {
    line.textContent = entry.text;
  } else {
    line.innerHTML = `<strong>${escapeHtml(entry.name || '?')}</strong> ${escapeHtml(entry.text)}`;
  }
  const near_bottom = dom.chat_log.scrollHeight - dom.chat_log.scrollTop - dom.chat_log.clientHeight < 60;
  dom.chat_log.appendChild(line);
  if (near_bottom) dom.chat_log.scrollTop = dom.chat_log.scrollHeight;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ------------------------------------------------------------------ */
/* End screen                                                          */
/* ------------------------------------------------------------------ */

function renderEnd() {
  const winner = room.winner;
  const titles = {
    civils: 'Les civils l\'emportent',
    infiltres: 'Les infiltrés l\'emportent',
    mr_white: 'Mr White renverse la table'
  };
  const texts = {
    civils: 'Tous les infiltrés ont été démasqués. Le mot de la majorité a tenu.',
    infiltres: 'Les infiltrés sont aussi nombreux que les civils : la salle est retournée.',
    mr_white: 'Éliminé, Mr White a deviné le mot des civils et rafle la manche à lui seul.'
  };
  dom.verdict_title.textContent = titles[winner] || 'Manche terminee';
  dom.verdict_text.textContent = texts[winner] || '';
  dom.verdict_eyebrow.textContent = `Dossier ${room.code} / manche ${room.round}`;
  dom.verdict_civil.textContent = room.words ? room.words.civil : '-';
  dom.verdict_undercover.textContent = room.words ? room.words.undercover : '-';
  dom.verdict_theme.textContent = room.theme_used ? `theme : ${room.theme_used}` : '';

  dom.reveal_list.innerHTML = '';
  const sorted = room.players.slice().sort((a, b) => b.score - a.score);
  sorted.forEach((player, index) => {
    const row = document.createElement('li');
    row.className = 'reveal-row';
    row.dataset.role = player.role || 'civil';
    row.innerHTML = `
      <span class="rv-idx">${pad2(index + 1)}</span>
      <span class="rv-name">${escapeHtml(player.name)}${me && player.id === me.id ? ' (toi)' : ''}</span>
      <span class="rv-word">${escapeHtml(player.word || 'aucun mot')}</span>
      <span class="rv-role">${escapeHtml(ROLE_LABEL[player.role] || '?')}</span>
      <span class="rv-score">${player.score}</span>`;
    dom.reveal_list.appendChild(row);
  });

  const host = isHost();
  dom.btn_again.disabled = !host;
  dom.btn_lobby.disabled = !host;
  dom.btn_again.textContent = host ? 'Manche suivante' : 'L\'hôte relance';
}

/* ------------------------------------------------------------------ */
/* Timer                                                               */
/* ------------------------------------------------------------------ */

function updateTimer() {
  if (!room || !room.deadline_ts) {
    dom.status_timer.hidden = true;
    return;
  }
  const remain = Math.max(0, room.deadline_ts - Date.now());
  const seconds = Math.ceil(remain / 1000);
  dom.status_timer.hidden = false;
  dom.status_timer.textContent = `${Math.floor(seconds / 60)}:${pad2(seconds % 60)}`;
  dom.status_timer.dataset.low = seconds <= 10 ? '1' : '0';
}

setInterval(() => {
  if (room && room.deadline_ts && !dom.screen_game.hidden) updateTimer();
}, 250);

window.addEventListener('resize', () => {
  if (room && !dom.screen_game.hidden) updateLamp();
});

/* ------------------------------------------------------------------ */
/* Home actions                                                        */
/* ------------------------------------------------------------------ */

function currentName() {
  return dom.input_name.value.trim();
}

dom.btn_create.addEventListener('click', () => {
  const name = currentName();
  if (name.length < 2) return showHomeError('Choisis un pseudo de 2 caractères minimum.');
  rememberName(name);
  hideHomeError();
  sendMessage({ type: 'create_room', name });
});

dom.btn_join.addEventListener('click', () => {
  const name = currentName();
  const code = dom.input_code.value.trim().toUpperCase();
  if (name.length < 2) return showHomeError('Choisis un pseudo de 2 caractères minimum.');
  if (code.length !== 4) return showHomeError('Le code d\'une partie fait 4 caractères.');
  rememberName(name);
  hideHomeError();
  sendMessage({ type: 'join_room', name, code });
});

dom.input_code.addEventListener('input', () => {
  dom.input_code.value = dom.input_code.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

[dom.input_name, dom.input_code].forEach((input) => {
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    if (dom.input_code.value.trim().length === 4) dom.btn_join.click();
    else dom.btn_create.click();
  });
});

dom.copy_link.addEventListener('click', async () => {
  if (!room) return;
  const url = `${location.origin}/r/${room.code}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Lien du dossier copié.');
  } catch (err) {
    toast(url);
  }
});

/* ------------------------------------------------------------------ */
/* Lobby controls                                                      */
/* ------------------------------------------------------------------ */

dom.btn_start.addEventListener('click', () => sendMessage({ type: 'start_game' }));

dom.set_auto_roles.addEventListener('change', () => {
  sendMessage({ type: 'update_settings', settings: { auto_roles: dom.set_auto_roles.checked } });
});

dom.set_typed_clues.addEventListener('change', () => {
  sendMessage({ type: 'update_settings', settings: { typed_clues: dom.set_typed_clues.checked } });
});

dom.set_reveal_role.addEventListener('change', () => {
  sendMessage({ type: 'update_settings', settings: { reveal_role: dom.set_reveal_role.checked } });
});

dom.set_timer.addEventListener('input', () => {
  const value = Number(dom.set_timer.value);
  dom.out_timer.textContent = value === 0 ? 'libre' : `${value} s`;
});

dom.set_timer.addEventListener('change', () => {
  sendMessage({ type: 'update_settings', settings: { discussion_seconds: Number(dom.set_timer.value) } });
});

document.querySelectorAll('.step-btn').forEach((button) => {
  button.addEventListener('click', () => {
    if (!room || !isHost()) return;
    const key = button.dataset.step;
    const delta = Number(button.dataset.delta);
    const next = Math.max(0, (room.settings[key] || 0) + delta);
    sendMessage({ type: 'update_settings', settings: { [key]: next, auto_roles: false } });
  });
});

dom.btn_themes_all.addEventListener('click', () => {
  if (!isHost()) return;
  sendMessage({ type: 'update_settings', settings: { themes: themes_catalog.map((t) => t.nom) } });
});

dom.btn_themes_none.addEventListener('click', () => {
  if (!isHost()) return;
  sendMessage({ type: 'update_settings', settings: { themes: [] } });
});

/* ------------------------------------------------------------------ */
/* Chat + end controls                                                 */
/* ------------------------------------------------------------------ */

function sendChat() {
  const text = dom.chat_text.value.trim();
  if (!text) return;
  sendMessage({ type: 'chat', text });
  dom.chat_text.value = '';
}

dom.chat_send.addEventListener('click', sendChat);
dom.chat_text.addEventListener('keydown', (event) => { if (event.key === 'Enter') sendChat(); });

dom.btn_again.addEventListener('click', () => sendMessage({ type: 'new_round' }));
dom.btn_lobby.addEventListener('click', () => sendMessage({ type: 'back_to_lobby' }));

dom.rules_btn.addEventListener('click', () => { dom.rules_modal.hidden = false; });
dom.rules_close.addEventListener('click', () => { dom.rules_modal.hidden = true; });
dom.rules_modal.addEventListener('click', (event) => {
  if (event.target === dom.rules_modal) dom.rules_modal.hidden = true;
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') dom.rules_modal.hidden = true;
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

(function boot() {
  dom.input_name.value = savedName();
  const match = location.pathname.match(/^\/r\/([A-Za-z0-9]{1,8})$/);
  if (match) dom.input_code.value = match[1].toUpperCase();
  showScreen('home');
  connect();
  window.addEventListener('beforeunload', () => { manual_close = true; });
}());
