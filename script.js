'use strict';

/* ============================================================
   CONSTANTS
   ============================================================ */
const VERSION = 'mnemo_v4';
const DECK_COLORS = ['#7B6EF6','#36E8AA','#FF5C7A','#FFB547','#4FC3F7','#E040FB','#FF8A65'];

/* ============================================================
   STATE
   ============================================================ */
let S = {
  // navigation
  section: 'today',
  // calendar
  calYear: 0, calMonth: 0, calSelected: null, calHover: [],
  // journal calendar
  jYear: 0, jMonth: 0, jSelected: null,
  // decks & topics
  decks: [],
  topics: [],
  // journal
  journal: {},
  // review history: { 'YYYY-MM-DD': count }
  history: {},
  // per-topic SM2 data: { [topicId]: { easeFactor, interval, repetitions, nextReview, ratings:{again,hard,good,easy} } }
  sm2: {},
  // sessions
  todayDone: [],      // topic ids reviewed today
  // goals
  goals: [],
  dailyGoal: 20,
  // pomodoro
  pomSessions: 0,
  pomDate: '',
  // settings
  settings: {
    ease: 2.5,
    intervalMod: 100,
    newCardsPerDay: 20,
    focusMins: 25,
    breakMins: 5,
    dailyGoal: 20,
    theme: 'cosmos'
  },
  // streaks
  currentStreak: 0,
  bestStreak: 0
};

// transient (not persisted)
let T = {
  // today session
  sessQueue: [], sessIdx: 0, sessAnswerShown: false, sessResults: {again:0,hard:0,good:0,easy:0},
  // flashcard session
  fcQueue: [], fcIdx: 0, fcAnswerShown: false, fcResults: {again:0,hard:0,good:0,easy:0},
  fcTimerInterval: null, fcSeconds: 0,
  // pomodoro
  pomInterval: null, pomRunning: false, pomBreakMode: false, pomSecondsLeft: 0,
  // delete modal
  pendingDelete: null, pendingDeleteType: null,
  // editing
  editingDeckId: null, editingTopicId: null, editingDeckContext: null,
  // manual schedule
  manualDates: [],
  selectedDeckColor: DECK_COLORS[0],
  // journal autosave
  journalTimer: null,
  // csv data
  csvRows: []
};

/* ============================================================
   STORAGE
   ============================================================ */
function save() {
  try {
    localStorage.setItem(VERSION, JSON.stringify({
      decks: S.decks, topics: S.topics, journal: S.journal,
      history: S.history, sm2: S.sm2, goals: S.goals,
      dailyGoal: S.dailyGoal, pomSessions: S.pomSessions, pomDate: S.pomDate,
      settings: S.settings, todayDone: S.todayDone,
      currentStreak: S.currentStreak, bestStreak: S.bestStreak
    }));
  } catch(e) { console.warn('Save failed', e); }
}

function load() {
  try {
    const raw = localStorage.getItem(VERSION);
    if (!raw) return;
    const d = JSON.parse(raw);
    S.decks   = d.decks   || [];
    S.topics  = d.topics  || [];
    S.journal = d.journal || {};
    S.history = d.history || {};
    S.sm2     = d.sm2     || {};
    S.goals   = d.goals   || [];
    S.dailyGoal = d.dailyGoal ?? 20;
    S.pomSessions = d.pomSessions || 0;
    S.pomDate = d.pomDate || '';
    S.settings = Object.assign({ ease:2.5, intervalMod:100, newCardsPerDay:20, focusMins:25, breakMins:5, dailyGoal:20, theme:'cosmos' }, d.settings || {});
    S.todayDone = d.todayDone || [];
    S.currentStreak = d.currentStreak || 0;
    S.bestStreak = d.bestStreak || 0;
  } catch(e) { console.warn('Load failed', e); }
}

/* ============================================================
   DATE UTILITIES
   ============================================================ */
function todayStr() {
  const d = new Date();
  return fmt(d);
}
function fmt(d) {
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
function pad(n) { return String(n).padStart(2,'0'); }
function parseD(s) { const [y,m,d] = s.split('-').map(Number); return new Date(y,m-1,d); }
function addDays(s, n) { const d = parseD(s); d.setDate(d.getDate()+n); return fmt(d); }
function diffDays(a, b) { return Math.round((parseD(a)-parseD(b))/86400000); }
function displayDate(s) {
  if (!s) return 'Select a date';
  return parseD(s).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric'});
}
function shortDate(s) { return parseD(s).toLocaleDateString('en-US',{month:'short',day:'numeric'}); }
function daysFromToday(s) { return diffDays(s, todayStr()); }

/* ============================================================
   SM-2 ALGORITHM
   ============================================================ */
function sm2Init(topicId) {
  if (!S.sm2[topicId]) {
    S.sm2[topicId] = {
      easeFactor: S.settings.ease,
      interval: 1,
      repetitions: 0,
      nextReview: todayStr(),
      ratings: { again:0, hard:0, good:0, easy:0 }
    };
  }
  return S.sm2[topicId];
}

// grade: 0=again,1=hard,2=good,3=easy
function sm2Update(topicId, grade) {
  const d = sm2Init(topicId);
  d.ratings[['again','hard','good','easy'][grade]]++;

  const mod = S.settings.intervalMod / 100;

  if (grade === 0) {
    d.repetitions = 0;
    d.interval = 1;
  } else if (grade === 1) {
    d.interval = Math.max(1, Math.round(d.interval * 1.2 * mod));
  } else if (grade === 2) {
    if (d.repetitions === 0) d.interval = 1;
    else if (d.repetitions === 1) d.interval = 4;
    else d.interval = Math.round(d.interval * d.easeFactor * mod);
    d.repetitions++;
  } else { // easy
    if (d.repetitions === 0) d.interval = 4;
    else d.interval = Math.round(d.interval * d.easeFactor * 1.3 * mod);
    d.repetitions++;
    d.easeFactor = Math.min(4, d.easeFactor + 0.15);
  }

  // Ease factor adjustment
  const easeChange = [-.2, -.15, 0, .1][grade];
  d.easeFactor = Math.max(1.3, d.easeFactor + easeChange);
  d.nextReview = addDays(todayStr(), d.interval);
  return d;
}

function getNextReview(topicId) {
  return sm2Init(topicId).nextReview;
}

function isDueToday(topicId) {
  const d = sm2Init(topicId);
  return d.nextReview <= todayStr();
}

function getRetentionRate(topicId) {
  const d = S.sm2[topicId];
  if (!d) return null;
  const total = d.ratings.again + d.ratings.hard + d.ratings.good + d.ratings.easy;
  if (!total) return null;
  return Math.round(((d.ratings.good + d.ratings.easy) / total) * 100);
}

/* ============================================================
   STREAK MANAGEMENT
   ============================================================ */
function updateStreak() {
  const today = todayStr();
  const yesterday = addDays(today, -1);
  const todayCount = S.history[today] || 0;

  if (todayCount > 0) {
    // check if streak was already counted today
    const yestCount = S.history[yesterday] || 0;
    if (S.currentStreak === 0) {
      S.currentStreak = yestCount > 0 ? 2 : 1;
    }
  } else if (!S.history[yesterday]) {
    S.currentStreak = 0;
  }

  S.bestStreak = Math.max(S.bestStreak, S.currentStreak);
}

function recalcStreak() {
  // Walk backwards from today to find streak
  let streak = 0;
  let d = todayStr();
  for (let i = 0; i < 1000; i++) {
    const check = addDays(d, -i);
    if ((S.history[check] || 0) > 0) streak++;
    else if (i > 0) break;
  }
  S.currentStreak = streak;
  S.bestStreak = Math.max(S.bestStreak, streak);
}

function recordReview() {
  const today = todayStr();
  S.history[today] = (S.history[today] || 0) + 1;
  recalcStreak();
  save();
}

/* ============================================================
   NAVIGATION
   ============================================================ */
function switchSection(name) {
  S.section = name;
  document.querySelectorAll('.section').forEach(s => {
    s.classList.toggle('active', s.id === `section-${name}`);
    s.classList.toggle('hidden', s.id !== `section-${name}`);
  });
  document.querySelectorAll('.nav-item').forEach(b => {
    b.classList.toggle('active', b.dataset.section === name);
  });
  el('mobTitle').textContent = document.querySelector(`[data-section="${name}"] .nav-label`)?.textContent || name;

  // render section
  const renders = {
    today: renderToday,
    decks: renderDecks,
    calendar: renderCalendar,
    flashcards: renderFlashcardSection,
    analytics: renderAnalytics,
    journal: renderJournal,
    goals: renderGoals,
    heatmap: renderHeatmap,
    import: renderImport,
    settings: renderSettings
  };
  renders[name]?.();
}

/* ============================================================
   SECTION: TODAY
   ============================================================ */
function renderToday() {
  const today = todayStr();
  el('todayDateLabel').textContent = parseD(today).toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});

  const due = S.topics.filter(t => isDueToday(t.id));
  const done = S.todayDone.length;
  const total = due.length + done;
  const todayHistory = S.history[today] || 0;

  el('statDue').textContent = due.length;
  el('statDone').textContent = done;
  el('statStreak').textContent = S.currentStreak;

  // overall retention
  const allRates = S.topics.map(t => getRetentionRate(t.id)).filter(r => r !== null);
  el('statRetention').textContent = allRates.length ? Math.round(allRates.reduce((a,b)=>a+b,0)/allRates.length)+'%' : '—';

  // badge
  const badge = el('todayBadge');
  if (due.length > 0) { badge.textContent = due.length; badge.classList.remove('hidden'); }
  else badge.classList.add('hidden');

  // sidebar streak
  el('streakNum').textContent = S.currentStreak;
  el('mobStreak').textContent = S.currentStreak;

  // daily goal mini bar
  const goalPct = Math.min(100, (done / (S.settings.dailyGoal||20)) * 100);
  el('dgmFill').style.width = goalPct + '%';
  el('dgmNums').textContent = `${done}/${S.settings.dailyGoal||20}`;

  // start btn
  el('startSessionBtn').style.display = due.length ? '' : 'none';

  // due list
  const list = el('todayDueList');
  if (due.length === 0 && done === 0) {
    list.innerHTML = `<div class="empty-state"><div class="es-icon">✨</div><div class="es-msg">All caught up! No reviews due today.</div></div>`;
    return;
  }
  if (due.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="es-icon">🎉</div><div class="es-msg">All ${done} reviews done for today!</div></div>`;
    return;
  }

  list.innerHTML = '';
  const heading = document.createElement('div');
  heading.style.cssText = 'font-size:0.68rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:var(--ink-muted);margin-bottom:10px;';
  heading.textContent = `${due.length} card${due.length!==1?'s':''} due`;
  list.appendChild(heading);

  due.slice(0, 50).forEach(t => {
    const deck = S.decks.find(d => d.id === t.deckId) || { name:'Uncategorized', color: '#7B6EF6' };
    const sm = sm2Init(t.id);
    const div = document.createElement('div');
    div.className = 'due-item';
    div.innerHTML = `
      <div class="due-deck-dot" style="background:${deck.color}"></div>
      <div class="due-title">${esc(t.title)}</div>
      <div class="due-deck">${esc(deck.name)}</div>
      <div class="due-next">Rep #${sm.repetitions+1}</div>
    `;
    list.appendChild(div);
  });
}

/* ---- SESSION ---- */
function startSession() {
  const due = S.topics.filter(t => isDueToday(t.id));
  if (!due.length) return;
  T.sessQueue = [...due];
  T.sessIdx = 0;
  T.sessAnswerShown = false;
  T.sessResults = {again:0,hard:0,good:0,easy:0};

  el('sessionArea').classList.remove('hidden');
  el('sessionComplete').classList.add('hidden');
  el('todayDueList').classList.add('hidden');
  el('startSessionBtn').style.display = 'none';
  renderSessionCard();
}

function renderSessionCard() {
  const q = T.sessQueue[T.sessIdx];
  if (!q) return;
  const deck = S.decks.find(d => d.id === q.deckId) || { name:'Uncategorized', color:'#7B6EF6' };

  el('sessDeckTag').textContent = deck.name;
  el('sessDeckTag').style.background = deck.color + '22';
  el('sessDeckTag').style.color = deck.color;
  el('sessDeckTag').style.borderColor = deck.color + '55';
  el('sessProg').textContent = `${T.sessIdx+1} / ${T.sessQueue.length}`;
  el('sessPbFill').style.width = ((T.sessIdx / T.sessQueue.length)*100) + '%';

  el('scTypeBadge').textContent = q.type === 'cloze' ? 'Cloze' : 'Standard';

  // render question
  if (q.type === 'cloze') {
    el('scQuestion').innerHTML = q.title.replace(/\{\{([^}]+)\}\}/g, '<span style="background:var(--surface3);color:var(--surface3);border-radius:4px;padding:0 8px;cursor:default">████</span>');
  } else {
    el('scQuestion').textContent = q.title;
  }

  // reset answer
  el('scAnswer').classList.add('hidden');
  el('sessionShowRow').classList.remove('hidden');
  el('sessionRatingRow').classList.add('hidden');
  T.sessAnswerShown = false;

  // answer text
  if (q.type === 'cloze') {
    el('scAnswerText').innerHTML = q.title.replace(/\{\{([^}]+)\}\}/g, '<strong style="color:var(--green)">$1</strong>');
  } else {
    el('scAnswerText').textContent = q.content || '— No additional notes —';
  }
}

function showSessionAnswer() {
  el('scAnswer').classList.remove('hidden');
  el('sessionShowRow').classList.add('hidden');
  el('sessionRatingRow').classList.remove('hidden');
  T.sessAnswerShown = true;
}

function rateCard(rating) {
  const gradeMap = { again:0, hard:1, good:2, easy:3 };
  const q = T.sessQueue[T.sessIdx];
  sm2Update(q.id, gradeMap[rating]);
  T.sessResults[rating]++;

  // Mark reviewed today
  if (!S.todayDone.includes(q.id)) S.todayDone.push(q.id);
  recordReview();

  T.sessIdx++;
  if (T.sessIdx >= T.sessQueue.length) {
    showSessionComplete();
  } else {
    T.sessAnswerShown = false;
    renderSessionCard();
  }
}

function showSessionComplete() {
  el('sessionArea').classList.add('hidden');
  el('sessionComplete').classList.remove('hidden');
  const r = T.sessResults;
  el('scoResults').innerHTML = `
    <div class="result-stat rs-again"><div class="rs-val">${r.again}</div><div class="rs-lab">Again</div></div>
    <div class="result-stat rs-hard"><div class="rs-val">${r.hard}</div><div class="rs-lab">Hard</div></div>
    <div class="result-stat rs-good"><div class="rs-val">${r.good}</div><div class="rs-lab">Good</div></div>
    <div class="result-stat rs-easy"><div class="rs-val">${r.easy}</div><div class="rs-lab">Easy</div></div>
  `;
}

function endSession() {
  el('sessionArea').classList.add('hidden');
  el('sessionComplete').classList.add('hidden');
  el('todayDueList').classList.remove('hidden');
  renderToday();
}

/* ============================================================
   SECTION: DECKS
   ============================================================ */
function renderDecks() {
  const grid = el('decksGrid');
  const empty = el('decksEmpty');
  grid.innerHTML = '';

  if (!S.decks.length) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  S.decks.forEach(deck => {
    const topics = S.topics.filter(t => t.deckId === deck.id);
    const due = topics.filter(t => isDueToday(t.id)).length;
    const rates = topics.map(t => getRetentionRate(t.id)).filter(r => r!==null);
    const retention = rates.length ? Math.round(rates.reduce((a,b)=>a+b,0)/rates.length) : null;

    const card = document.createElement('div');
    card.className = 'deck-card';
    card.style.setProperty('--deck-color', deck.color);
    card.innerHTML = `
      <div style="position:absolute;top:0;left:0;right:0;height:4px;background:${deck.color};border-radius:var(--radius-lg) var(--radius-lg) 0 0"></div>
      <div class="dc-top">
        <div class="dc-name">${esc(deck.name)}</div>
        <div class="dc-actions">
          <button class="dc-action-btn dc-edit" data-did="${deck.id}">✏️</button>
          <button class="dc-action-btn dc-del" data-did="${deck.id}">🗑️</button>
        </div>
      </div>
      <div class="dc-desc">${esc(deck.desc||'')}</div>
      <div class="dc-stats">
        <div class="dc-stat"><div class="dc-stat-val" style="color:${deck.color}">${topics.length}</div><div class="dc-stat-lab">Cards</div></div>
        <div class="dc-stat"><div class="dc-stat-val" style="color:var(--amber)">${due}</div><div class="dc-stat-lab">Due</div></div>
        <div class="dc-stat"><div class="dc-stat-val" style="color:var(--green)">${retention !== null ? retention+'%' : '—'}</div><div class="dc-stat-lab">Retention</div></div>
      </div>
      ${due > 0 ? `<div class="dc-due-badge">${due} due</div>` : ''}
    `;
    card.addEventListener('click', e => {
      if (e.target.closest('.dc-edit')) { openEditDeck(deck.id); return; }
      if (e.target.closest('.dc-del')) { openDeleteDeck(deck.id); return; }
      openDeckDetail(deck.id);
    });
    grid.appendChild(card);
  });
}

function openNewDeck() {
  T.editingDeckId = null;
  T.selectedDeckColor = DECK_COLORS[0];
  el('deckModalTitle').textContent = 'New Deck';
  el('deckName').value = '';
  el('deckDesc').value = '';
  updateColorPicker(T.selectedDeckColor);
  openModal('deckModal');
}

function openEditDeck(id) {
  const deck = S.decks.find(d => d.id === id);
  if (!deck) return;
  T.editingDeckId = id;
  T.selectedDeckColor = deck.color;
  el('deckModalTitle').textContent = 'Edit Deck';
  el('deckName').value = deck.name;
  el('deckDesc').value = deck.desc || '';
  updateColorPicker(deck.color);
  openModal('deckModal');
}

function saveDeck() {
  const name = el('deckName').value.trim();
  if (!name) { alert('Please enter a deck name.'); return; }
  if (T.editingDeckId) {
    const i = S.decks.findIndex(d => d.id === T.editingDeckId);
    if (i !== -1) S.decks[i] = { ...S.decks[i], name, desc: el('deckDesc').value.trim(), color: T.selectedDeckColor };
  } else {
    S.decks.push({ id: uid(), name, desc: el('deckDesc').value.trim(), color: T.selectedDeckColor });
  }
  save(); closeModal('deckModal'); renderDecks(); refreshDeckSelects();
}

function openDeleteDeck(id) {
  const deck = S.decks.find(d => d.id === id);
  if (!deck) return;
  const count = S.topics.filter(t => t.deckId === id).length;
  T.pendingDelete = id; T.pendingDeleteType = 'deck';
  el('deleteMsg').textContent = `Delete deck "${deck.name}" and all ${count} topic(s)? This cannot be undone.`;
  openModal('deleteModal');
}

function openDeckDetail(id) {
  const deck = S.decks.find(d => d.id === id);
  if (!deck) return;
  T.editingDeckContext = id;
  const topics = S.topics.filter(t => t.deckId === id);
  el('ddTitle').textContent = deck.name;
  el('ddSub').textContent = `${topics.length} topics · ${deck.desc || ''}`;
  const list = el('ddTopicList');
  list.innerHTML = '';
  if (!topics.length) {
    list.innerHTML = '<div class="empty-state"><div class="es-icon">📭</div><div class="es-msg">No topics yet. Add your first topic!</div></div>';
  } else {
    topics.forEach(t => {
      const sm = sm2Init(t.id);
      const due = sm.nextReview <= todayStr();
      const row = document.createElement('div');
      row.className = 'dd-topic-row';
      row.innerHTML = `
        <div class="dd-topic-title">${esc(t.title)}${t.type==='cloze'?' <span style="font-size:0.65rem;background:var(--accent-dim);color:var(--accent);padding:1px 6px;border-radius:10px">cloze</span>':''}</div>
        <div class="dd-topic-date" style="color:${due?'var(--red)':'var(--ink-muted)'}">Due: ${sm.nextReview}</div>
        <div class="dd-topic-actions">
          <button class="dd-btn dd-edit" data-tid="${t.id}">✏️ Edit</button>
          <button class="dd-btn dd-del" data-tid="${t.id}">🗑️</button>
        </div>
      `;
      row.querySelector('.dd-edit').addEventListener('click', () => { closeModal('deckDetailModal'); openEditTopic(t.id); });
      row.querySelector('.dd-del').addEventListener('click', () => { T.pendingDelete = t.id; T.pendingDeleteType = 'topic'; el('deleteMsg').textContent = `Delete "${t.title}"? This cannot be undone.`; openModal('deleteModal'); });
      list.appendChild(row);
    });
  }
  el('ddAddTopicBtn').onclick = () => { closeModal('deckDetailModal'); openAddTopic(id); };
  el('ddStudyBtn').onclick = () => { closeModal('deckDetailModal'); studyDeck(id); };
  openModal('deckDetailModal');
}

function studyDeck(deckId) {
  switchSection('flashcards');
  el('fcDeckFilter').value = deckId;
  el('fcDateFilter').value = 'all';
  loadFlashcards();
}

/* ============================================================
   TOPIC MODAL
   ============================================================ */
function openAddTopic(deckId) {
  T.editingTopicId = null;
  T.manualDates = [];
  el('topicModalTitle').textContent = 'Add Topic';
  el('topicEditId').value = '';
  el('fTitle').value = '';
  el('fContent').value = '';
  el('fDate').value = S.calSelected || todayStr();
  el('schedPreview').textContent = '';
  el('clozeHint').classList.add('hidden');
  el('manualZone').classList.add('hidden');
  // card type
  el('cardTypeSwitch').querySelectorAll('.tsw-btn').forEach(b => b.classList.toggle('active', b.dataset.type === 'standard'));
  // sched
  el('schedSwitch').querySelectorAll('.tsw-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === 'auto'));

  refreshDeckSelects();
  el('fDeck').value = deckId || (S.decks[0]?.id || '');
  openModal('topicModal');
}

function openEditTopic(id) {
  const t = S.topics.find(x => x.id === id);
  if (!t) return;
  T.editingTopicId = id;
  T.manualDates = t.mode === 'manual' && t.reviewDates ? [...t.reviewDates] : [];
  el('topicModalTitle').textContent = 'Edit Topic';
  el('topicEditId').value = id;
  el('fTitle').value = t.title;
  el('fContent').value = t.content || '';
  el('fDate').value = t.startDate;
  el('clozeHint').classList.toggle('hidden', t.type !== 'cloze');
  el('cardTypeSwitch').querySelectorAll('.tsw-btn').forEach(b => b.classList.toggle('active', b.dataset.type === (t.type||'standard')));
  const isManual = t.mode === 'manual';
  el('schedSwitch').querySelectorAll('.tsw-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === (isManual?'manual':'auto')));
  el('manualZone').classList.toggle('hidden', !isManual);
  refreshDeckSelects();
  el('fDeck').value = t.deckId || '';
  updateSchedPreview();
  openModal('topicModal');
}

function saveTopic() {
  const title = el('fTitle').value.trim();
  const content = el('fContent').value.trim();
  const deckId = el('fDeck').value;
  const startDate = el('fDate').value;
  const type = el('cardTypeSwitch').querySelector('.active')?.dataset.type || 'standard';
  const mode = el('schedSwitch').querySelector('.active')?.dataset.mode || 'auto';

  if (!title) { alert('Please enter a title.'); return; }
  if (!deckId) { alert('Please select a deck.'); return; }
  if (!startDate) { alert('Please set a start date.'); return; }

  let reviewDates;
  if (mode === 'auto') {
    reviewDates = calcAutoReviews(startDate);
  } else {
    if (!T.manualDates.length) T.manualDates = [startDate];
    reviewDates = T.manualDates;
  }

  if (T.editingTopicId) {
    const i = S.topics.findIndex(x => x.id === T.editingTopicId);
    if (i !== -1) {
      S.topics[i] = { ...S.topics[i], title, content, deckId, startDate, type, mode, reviewDates };
      // reset SM2 nextReview to startDate if start changed
      if (S.sm2[T.editingTopicId]) S.sm2[T.editingTopicId].nextReview = startDate;
    }
  } else {
    const id = uid();
    S.topics.push({ id, title, content, deckId, startDate, type, mode, reviewDates });
    sm2Init(id);
    S.sm2[id].nextReview = startDate;
  }

  save(); closeModal('topicModal');
  if (S.section === 'decks') renderDecks();
  else if (S.section === 'calendar') renderCalPanel();
  else if (S.section === 'today') renderToday();
}

function calcAutoReviews(start) {
  const intervals = [0,1,3,7,14,28,30,60,90];
  const dates = [];
  intervals.forEach((_, i) => {
    if (i === 0) dates.push(start);
    else dates.push(addDays(dates[dates.length-1], intervals[i]));
  });
  return dates;
}

function openDeleteTopic(id) {
  const t = S.topics.find(x => x.id === id);
  if (!t) return;
  T.pendingDelete = id; T.pendingDeleteType = 'topic';
  el('deleteMsg').textContent = `Delete "${t.title}"? This cannot be undone.`;
  openModal('deleteModal');
}

function confirmDelete() {
  if (T.pendingDeleteType === 'deck') {
    S.topics = S.topics.filter(t => t.deckId !== T.pendingDelete);
    S.decks = S.decks.filter(d => d.id !== T.pendingDelete);
  } else if (T.pendingDeleteType === 'topic') {
    S.topics = S.topics.filter(t => t.id !== T.pendingDelete);
    delete S.sm2[T.pendingDelete];
    S.todayDone = S.todayDone.filter(id => id !== T.pendingDelete);
  }
  T.pendingDelete = null; T.pendingDeleteType = null;
  save(); closeModal('deleteModal');
  const r = { decks:renderDecks, calendar:renderCalendar, today:renderToday, flashcards:renderFlashcardSection };
  r[S.section]?.();
}

/* ============================================================
   SECTION: CALENDAR
   ============================================================ */
function renderCalendar() {
  renderCalGrid();
  renderCalPanel();
  renderCalUpcoming();
}

function renderCalGrid() {
  const { calYear: y, calMonth: m } = S;
  el('calMonthLbl').textContent = new Date(y,m,1).toLocaleDateString('en-US',{month:'long',year:'numeric'});
  const today = todayStr();
  const firstDow = new Date(y,m,1).getDay();
  const daysInMonth = new Date(y,m+1,0).getDate();
  const daysInPrev = new Date(y,m,0).getDate();

  // build review map
  const srMap = {};
  S.topics.forEach(t => t.reviewDates?.forEach(d => { srMap[d] = (srMap[d]||0)+1; }));

  const grid = el('calGrid');
  grid.innerHTML = '';
  for (let i = 0; i < 42; i++) {
    let ds, dayNum, otherMonth = false;
    if (i < firstDow) {
      dayNum = daysInPrev - firstDow + i + 1;
      const pm = m===0?11:m-1, py = m===0?y-1:y;
      ds = fmt(new Date(py,pm,dayNum)); otherMonth = true;
    } else if (i >= firstDow+daysInMonth) {
      dayNum = i - firstDow - daysInMonth + 1;
      const nm = m===11?0:m+1, ny = m===11?y+1:y;
      ds = fmt(new Date(ny,nm,dayNum)); otherMonth = true;
    } else {
      dayNum = i - firstDow + 1;
      ds = fmt(new Date(y,m,dayNum));
    }
    const cell = document.createElement('div');
    cell.className = 'cal-cell' + (otherMonth?' other-month':'') + (ds===today?' today':'') + (ds===S.calSelected?' selected':'') + (S.calHover.includes(ds)?' hover-hl':'');
    cell.innerHTML = `<div class="cal-day-num">${dayNum}</div><div class="cal-indicators"></div>`;
    if (srMap[ds]) {
      const ind = cell.querySelector('.cal-indicators');
      const dot = document.createElement('div');
      dot.className = 'ci-dot ci-dot-blue';
      ind.appendChild(dot);
      if (srMap[ds] > 1) {
        const b = document.createElement('span');
        b.className = 'ci-badge'; b.textContent = srMap[ds];
        ind.appendChild(b);
      }
    }
    cell.addEventListener('click', () => onCalClick(ds));
    cell.addEventListener('mouseenter', () => onCalHover(ds));
    cell.addEventListener('mouseleave', () => { S.calHover = []; renderCalGrid(); });
    grid.appendChild(cell);
  }
}

function onCalClick(ds) {
  S.calSelected = ds; S.calHover = [];
  renderCalGrid(); renderCalPanel();
}

function onCalHover(ds) {
  const topicsHere = S.topics.filter(t => t.startDate === ds);
  if (!topicsHere.length) { if (S.calHover.length) { S.calHover=[]; renderCalGrid(); } return; }
  const dates = new Set();
  topicsHere.forEach(t => t.reviewDates?.forEach(d => dates.add(d)));
  S.calHover = [...dates];
  renderCalGrid();
}

function renderCalPanel() {
  const head = el('calPanelDate');
  const topicsEl = el('calPanelTopics');
  if (!S.calSelected) { head.textContent = 'Select a date'; topicsEl.innerHTML = ''; return; }
  head.textContent = displayDate(S.calSelected);
  const due = S.topics.filter(t => t.reviewDates?.includes(S.calSelected));
  topicsEl.innerHTML = '';
  if (!due.length) {
    topicsEl.innerHTML = '<div style="font-size:0.78rem;color:var(--ink-muted)">No topics scheduled on this date.</div>';
    return;
  }
  due.forEach(t => {
    const isOrig = t.reviewDates?.[0] === S.calSelected;
    const revIdx = t.reviewDates?.indexOf(S.calSelected) ?? 0;
    const deck = S.decks.find(d => d.id === t.deckId) || { name:'Uncategorized', color:'#7B6EF6' };
    const card = document.createElement('div');
    card.className = 'cal-topic-card';
    card.style.borderLeftColor = deck.color;
    card.innerHTML = `
      <div class="ctc-title">${esc(t.title)}</div>
      <div class="ctc-meta">
        <span style="background:${deck.color}22;color:${deck.color};padding:1px 7px;border-radius:10px;font-size:0.6rem;font-weight:700">${esc(deck.name)}</span>
        <span>${isOrig ? 'Original' : `Review #${revIdx}`}</span>
      </div>
      <div class="ctc-actions">
        <button class="ctc-btn ctc-edit" data-tid="${t.id}">✏️ Edit</button>
        <button class="ctc-btn ctc-del" data-tid="${t.id}">🗑️ Delete</button>
      </div>
    `;
    card.querySelector('.ctc-edit').addEventListener('click', () => openEditTopic(t.id));
    card.querySelector('.ctc-del').addEventListener('click', () => openDeleteTopic(t.id));
    topicsEl.appendChild(card);
  });
}

function renderCalUpcoming() {
  const today = todayStr();
  const horizon = addDays(today, 30);
  const items = [];
  S.topics.forEach(t => {
    t.reviewDates?.forEach(d => {
      if (d >= today && d <= horizon) {
        const deck = S.decks.find(dk => dk.id === t.deckId) || { name:'Uncategorized', color:'#7B6EF6' };
        items.push({ date:d, title:t.title, color:deck.color });
      }
    });
  });
  items.sort((a,b) => a.date.localeCompare(b.date));
  el('cupBadge').textContent = items.length;
  const list = el('cupList');
  list.innerHTML = '';
  items.slice(0,20).forEach(item => {
    const diff = daysFromToday(item.date);
    const dayLabel = diff===0?'Today':diff===1?'Tomorrow':`In ${diff}d`;
    const div = document.createElement('div');
    div.className = 'cup-item';
    div.innerHTML = `
      <div class="cup-date">${shortDate(item.date)}</div>
      <div class="cup-day ${diff===0?'is-today':''}">${dayLabel}</div>
      <div class="cup-title-t">${esc(item.title)}</div>
    `;
    div.addEventListener('click', () => {
      const d = parseD(item.date);
      S.calYear = d.getFullYear(); S.calMonth = d.getMonth(); S.calSelected = item.date;
      renderCalendar();
    });
    list.appendChild(div);
  });
  if (!items.length) list.innerHTML = '<div style="font-size:0.78rem;color:var(--ink-muted)">No upcoming reviews in 30 days.</div>';
}

/* ============================================================
   SECTION: FLASHCARDS (Focus Mode)
   ============================================================ */
function renderFlashcardSection() {
  refreshDeckSelects();
  const sel = el('fcDeckFilter');
  // rebuild deck options
  sel.innerHTML = '<option value="all">All Decks</option>';
  S.decks.forEach(d => {
    const o = document.createElement('option');
    o.value = d.id; o.textContent = d.name;
    sel.appendChild(o);
  });
}

function loadFlashcards() {
  const deckId = el('fcDeckFilter').value;
  const dateFilter = el('fcDateFilter').value;
  const today = todayStr();
  const weekEnd = addDays(today, 7);

  let pool = S.topics;
  if (deckId !== 'all') pool = pool.filter(t => t.deckId === deckId);
  if (dateFilter === 'today') pool = pool.filter(t => isDueToday(t.id));
  else if (dateFilter === 'week') pool = pool.filter(t => sm2Init(t.id).nextReview <= weekEnd);

  if (!pool.length) {
    el('fcIdle').classList.remove('hidden');
    el('fcIdle').querySelector('.fci-msg').textContent = 'No cards match the current filters.';
    el('fcSession').classList.add('hidden');
    el('fcDone').classList.add('hidden');
    return;
  }

  // shuffle
  T.fcQueue = [...pool].sort(() => Math.random()-0.5);
  T.fcIdx = 0; T.fcAnswerShown = false;
  T.fcResults = {again:0,hard:0,good:0,easy:0};
  T.fcSeconds = 0;

  clearInterval(T.fcTimerInterval);
  T.fcTimerInterval = setInterval(() => {
    T.fcSeconds++;
    const m = Math.floor(T.fcSeconds/60), s = T.fcSeconds%60;
    el('fcTimer').textContent = `${m}:${pad(s)}`;
  }, 1000);

  el('fcIdle').classList.add('hidden');
  el('fcDone').classList.add('hidden');
  el('fcSession').classList.remove('hidden');
  renderFcCard();
}

function renderFcCard() {
  const q = T.fcQueue[T.fcIdx];
  if (!q) return;
  const deck = S.decks.find(d => d.id === q.deckId) || { name:'Uncategorized', color:'#7B6EF6' };

  el('fcDeckTag').textContent = deck.name;
  el('fcDeckTag').style.background = deck.color+'22';
  el('fcDeckTag').style.color = deck.color;
  el('fcProg').textContent = `${T.fcIdx+1} / ${T.fcQueue.length}`;
  el('fcPbFill').style.width = ((T.fcIdx/T.fcQueue.length)*100)+'%';

  if (q.type === 'cloze') {
    el('fcQ').innerHTML = q.title.replace(/\{\{([^}]+)\}\}/g, '<span style="background:var(--surface3);color:var(--surface3);border-radius:4px;padding:0 8px">████</span>');
  } else {
    el('fcQ').textContent = q.title;
  }

  if (q.type === 'cloze') {
    el('fcAText').innerHTML = q.title.replace(/\{\{([^}]+)\}\}/g, '<strong style="color:var(--green)">$1</strong>');
  } else {
    el('fcAText').textContent = q.content || '— No additional notes —';
  }

  el('fcA').classList.add('hidden');
  el('fcShowRow').classList.remove('hidden');
  el('fcRatingRow').classList.add('hidden');
  T.fcAnswerShown = false;
}

function fcShowAnswer() {
  el('fcA').classList.remove('hidden');
  el('fcShowRow').classList.add('hidden');
  el('fcRatingRow').classList.remove('hidden');
  T.fcAnswerShown = true;
}

function fcRate(rating) {
  const gradeMap = { again:0, hard:1, good:2, easy:3 };
  const q = T.fcQueue[T.fcIdx];
  sm2Update(q.id, gradeMap[rating]);
  T.fcResults[rating]++;
  if (!S.todayDone.includes(q.id)) S.todayDone.push(q.id);
  recordReview();

  T.fcIdx++;
  if (T.fcIdx >= T.fcQueue.length) {
    clearInterval(T.fcTimerInterval);
    showFcDone();
  } else {
    T.fcAnswerShown = false;
    renderFcCard();
  }
}

function showFcDone() {
  el('fcSession').classList.add('hidden');
  el('fcDone').classList.remove('hidden');
  const r = T.fcResults;
  const total = r.again+r.hard+r.good+r.easy;
  const mins = Math.floor(T.fcSeconds/60), secs = T.fcSeconds%60;
  el('fcdStats').innerHTML = `
    <div class="fcd-stat rs-again"><div class="fcd-stat-val" style="color:var(--red)">${r.again}</div><div class="fcd-stat-lab">Again</div></div>
    <div class="fcd-stat rs-hard"><div class="fcd-stat-val" style="color:var(--amber)">${r.hard}</div><div class="fcd-stat-lab">Hard</div></div>
    <div class="fcd-stat rs-good"><div class="fcd-stat-val" style="color:var(--green)">${r.good}</div><div class="fcd-stat-lab">Good</div></div>
    <div class="fcd-stat rs-easy"><div class="fcd-stat-val" style="color:var(--accent)">${r.easy}</div><div class="fcd-stat-lab">Easy</div></div>
    <div class="fcd-stat"><div class="fcd-stat-val">${mins}:${pad(secs)}</div><div class="fcd-stat-lab">Time</div></div>
  `;
}

/* ============================================================
   SECTION: ANALYTICS
   ============================================================ */
function renderAnalytics() {
  renderWeeklyChart();
  renderRetentionByDeck();
  renderConfidenceBars();
  renderForgettingChart();
  renderWeeklyDigest();
  renderWeakTopics();
}

function renderWeeklyChart() {
  const container = el('weeklyChart');
  container.innerHTML = '';
  const days = 7;
  const labels = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const today = new Date();
  const data = [];
  let maxVal = 1;
  for (let i = days-1; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate()-i);
    const ds = fmt(d);
    const count = S.history[ds] || 0;
    data.push({ label: labels[d.getDay()], count, ds });
    if (count > maxVal) maxVal = count;
  }
  data.forEach(item => {
    const pct = Math.round((item.count/maxVal)*100);
    const wrap = document.createElement('div');
    wrap.className = 'wc-bar-wrap';
    wrap.innerHTML = `
      <div class="wc-val">${item.count||''}</div>
      <div class="wc-bar" style="height:100%">
        <div class="wc-bar-fill" style="height:${pct}%"></div>
      </div>
      <div class="wc-label">${item.label}</div>
    `;
    container.appendChild(wrap);
  });
}

function renderRetentionByDeck() {
  const container = el('retentionByDeck');
  container.innerHTML = '';
  if (!S.decks.length) { container.innerHTML = '<div style="color:var(--ink-muted);font-size:0.82rem">No decks yet.</div>'; return; }
  S.decks.forEach(deck => {
    const topics = S.topics.filter(t => t.deckId === deck.id);
    const rates = topics.map(t => getRetentionRate(t.id)).filter(r => r!==null);
    const pct = rates.length ? Math.round(rates.reduce((a,b)=>a+b,0)/rates.length) : 0;
    const div = document.createElement('div');
    div.className = 'rbd-item';
    div.innerHTML = `
      <div class="rbd-dot" style="background:${deck.color}"></div>
      <div style="flex:1">
        <div style="display:flex;justify-content:space-between">
          <div class="rbd-name">${esc(deck.name)}</div>
          <div class="rbd-pct" style="color:${deck.color}">${pct}%</div>
        </div>
        <div class="rbd-bar-bg"><div class="rbd-bar-fill" style="width:${pct}%;background:${deck.color}"></div></div>
      </div>
    `;
    container.appendChild(div);
  });
}

function renderConfidenceBars() {
  const container = el('confBars');
  container.innerHTML = '';
  const totals = {again:0,hard:0,good:0,easy:0};
  Object.values(S.sm2).forEach(d => {
    totals.again += d.ratings?.again||0;
    totals.hard  += d.ratings?.hard||0;
    totals.good  += d.ratings?.good||0;
    totals.easy  += d.ratings?.easy||0;
  });
  const total = totals.again+totals.hard+totals.good+totals.easy || 1;
  const rows = [
    { label:'Again', count:totals.again, color:'var(--red)' },
    { label:'Hard',  count:totals.hard,  color:'var(--amber)' },
    { label:'Good',  count:totals.good,  color:'var(--green)' },
    { label:'Easy',  count:totals.easy,  color:'var(--accent)' }
  ];
  rows.forEach(r => {
    const pct = Math.round((r.count/total)*100);
    const div = document.createElement('div');
    div.className = 'cb-row';
    div.innerHTML = `
      <div class="cb-label" style="color:${r.color}">${r.label}</div>
      <div class="cb-bar-bg"><div class="cb-bar-fill" style="width:${pct}%;background:${r.color}"></div></div>
      <div class="cb-count">${r.count}</div>
    `;
    container.appendChild(div);
  });
}

function renderForgettingChart() {
  const container = el('forgettingChart');
  container.innerHTML = '';
  const today = todayStr();
  const data = [];
  let maxVal = 1;
  for (let i = 0; i < 14; i++) {
    const d = addDays(today, i);
    const count = S.topics.filter(t => {
      const sm = S.sm2[t.id];
      return sm && sm.nextReview === d;
    }).length;
    data.push({ d, count, label: i===0?'Today':`+${i}d` });
    if (count > maxVal) maxVal = count;
  }
  data.forEach(item => {
    const pct = Math.round((item.count/maxVal)*100);
    const urgency = item.count > 5 ? 'var(--red)' : item.count > 2 ? 'var(--amber)' : 'var(--accent)';
    const wrap = document.createElement('div');
    wrap.className = 'fg-bar-wrap';
    wrap.innerHTML = `
      <div class="fg-val">${item.count||''}</div>
      <div class="fg-bar" style="height:100%;background:var(--surface3)">
        <div style="position:absolute;bottom:0;left:0;right:0;border-radius:4px 4px 0 0;background:${urgency};height:${Math.max(pct,item.count?5:0)}%;transition:height 0.5s ease"></div>
      </div>
      <div class="fg-label">${item.label}</div>
    `;
    container.appendChild(wrap);
  });
}

function renderWeeklyDigest() {
  const container = el('weeklyDigest');
  container.innerHTML = '';
  const today = todayStr();
  let weekTotal = 0;
  let bestDay = 0, bestDayLabel = '';
  for (let i = 0; i < 7; i++) {
    const d = addDays(today, -i);
    const c = S.history[d]||0;
    weekTotal += c;
    if (c > bestDay) { bestDay = c; bestDayLabel = parseD(d).toLocaleDateString('en-US',{weekday:'short'}); }
  }
  const allRates = S.topics.map(t => getRetentionRate(t.id)).filter(r=>r!==null);
  const avgRetention = allRates.length ? Math.round(allRates.reduce((a,b)=>a+b,0)/allRates.length) : 0;
  const dueToday = S.topics.filter(t => isDueToday(t.id)).length;

  const items = [
    { icon:'📚', text:`Reviewed <span class="digest-val">${weekTotal}</span> cards this week` },
    { icon:'🏆', text:`Best day: <span class="digest-val">${bestDayLabel||'—'} (${bestDay})</span>` },
    { icon:'🎯', text:`Overall retention: <span class="digest-val">${avgRetention}%</span>` },
    { icon:'🔥', text:`Current streak: <span class="digest-val">${S.currentStreak} days</span>` },
    { icon:'⏳', text:`Due today: <span class="digest-val">${dueToday} cards</span>` },
    { icon:'📦', text:`Total cards: <span class="digest-val">${S.topics.length}</span> in ${S.decks.length} decks` }
  ];
  items.forEach(item => {
    const div = document.createElement('div');
    div.className = 'digest-item';
    div.innerHTML = `<div class="digest-icon">${item.icon}</div><div class="digest-text">${item.text}</div>`;
    container.appendChild(div);
  });
}

function renderWeakTopics() {
  const container = el('weakTopics');
  container.innerHTML = '';
  const scored = S.topics.map(t => ({
    t, rate: getRetentionRate(t.id) ?? 100
  })).sort((a,b) => a.rate - b.rate).slice(0,7);
  if (!scored.length) { container.innerHTML = '<div style="color:var(--ink-muted);font-size:0.82rem">No data yet.</div>'; return; }
  scored.forEach((item, idx) => {
    const div = document.createElement('div');
    div.className = 'weak-item';
    div.innerHTML = `
      <div class="weak-rank">#${idx+1}</div>
      <div class="weak-name">${esc(item.t.title)}</div>
      <div class="weak-pct">${item.rate}%</div>
    `;
    container.appendChild(div);
  });
}

/* ============================================================
   SECTION: JOURNAL
   ============================================================ */
let journalSaveTimer = null;

function renderJournal() {
  renderJournalMiniCal();
  renderJournalEditor();
  renderJournalRecent();
}

function renderJournalMiniCal() {
  el('jMonthLbl').textContent = new Date(S.jYear, S.jMonth, 1).toLocaleDateString('en-US',{month:'short',year:'numeric'});
  const today = todayStr();
  const firstDow = new Date(S.jYear, S.jMonth, 1).getDay();
  const daysInMonth = new Date(S.jYear, S.jMonth+1, 0).getDate();
  const daysInPrev = new Date(S.jYear, S.jMonth, 0).getDate();
  const grid = el('jMcGrid');
  grid.innerHTML = '';
  for (let i = 0; i < 35; i++) {
    let ds, dayNum, other=false;
    if (i < firstDow) {
      dayNum = daysInPrev-firstDow+i+1;
      const pm=S.jMonth===0?11:S.jMonth-1, py=S.jMonth===0?S.jYear-1:S.jYear;
      ds=fmt(new Date(py,pm,dayNum)); other=true;
    } else if (i>=firstDow+daysInMonth) {
      dayNum=i-firstDow-daysInMonth+1;
      const nm=S.jMonth===11?0:S.jMonth+1, ny=S.jMonth===11?S.jYear+1:S.jYear;
      ds=fmt(new Date(ny,nm,dayNum)); other=true;
    } else {
      dayNum=i-firstDow+1; ds=fmt(new Date(S.jYear,S.jMonth,dayNum));
    }
    const cell = document.createElement('div');
    cell.className = 'jmc-cell' + (other?' other-month':'') + (ds===today?' today':'') + (ds===S.jSelected?' selected':'') + (S.journal[ds]?.trim()?' has-entry':'');
    cell.textContent = dayNum;
    cell.addEventListener('click', () => { S.jSelected = ds; renderJournalMiniCal(); renderJournalEditor(); });
    grid.appendChild(cell);
  }
}

function renderJournalEditor() {
  const ta = el('journalTA');
  const head = el('jeaDate');
  if (!S.jSelected) { head.textContent = 'Select a date to write'; ta.value=''; ta.disabled=true; return; }
  head.textContent = displayDate(S.jSelected);
  ta.disabled = false;
  ta.value = S.journal[S.jSelected]||'';
  updateJournalStats(ta.value);
}

function updateJournalStats(text) {
  el('jWords').textContent = text.trim() ? text.trim().split(/\s+/).length + ' words' : '0 words';
  el('jChars').textContent = text.length + ' chars';
}

function renderJournalRecent() {
  const list = el('jRecentList');
  list.innerHTML = '';
  const entries = Object.entries(S.journal)
    .filter(([,v]) => v?.trim())
    .sort(([a],[b]) => b.localeCompare(a))
    .slice(0,10);
  if (!entries.length) { list.innerHTML = '<div style="font-size:0.78rem;color:var(--ink-muted)">No journal entries yet.</div>'; return; }
  entries.forEach(([ds,text]) => {
    const div = document.createElement('div');
    div.className = 'jr-item';
    div.innerHTML = `<div class="jr-date">${shortDate(ds)}</div><div class="jr-preview">${esc(text)}</div>`;
    div.addEventListener('click', () => {
      S.jSelected = ds;
      const d = parseD(ds); S.jYear = d.getFullYear(); S.jMonth = d.getMonth();
      renderJournalMiniCal(); renderJournalEditor();
    });
    list.appendChild(div);
  });
}

/* ============================================================
   SECTION: GOALS
   ============================================================ */
function renderGoals() {
  // daily goal
  const done = S.todayDone.length;
  const goal = S.settings.dailyGoal || 20;
  const pct = Math.min(100, (done/goal)*100);
  el('dgcFill').style.width = pct+'%';
  el('dgcInfo').textContent = `${done} / ${goal} cards today`;

  // streak
  el('stcStreak').textContent = S.currentStreak;
  el('stcBest').textContent = `Best: ${S.bestStreak} days`;

  // goals list
  const list = el('goalsList');
  list.innerHTML = '';
  if (!S.goals.length) {
    list.innerHTML = '<div class="empty-state" style="padding:32px"><div class="es-icon">🎯</div><div class="es-msg">No goals yet. Create one to stay motivated!</div></div>';
  } else {
    S.goals.forEach(g => {
      const deadline = g.deadline ? daysFromToday(g.deadline) : null;
      const pct = Math.min(100, ((g.progress||0)/(g.target||1))*100);
      const card = document.createElement('div');
      card.className = 'goal-card';
      card.innerHTML = `
        <div class="gc-top">
          <div class="gc-title">${esc(g.title)}</div>
          <button class="gc-del" data-gid="${g.id}">🗑️</button>
        </div>
        <div class="gc-progress-row">
          <div class="gc-bar-bg"><div class="gc-bar-fill" style="width:${pct}%"></div></div>
          <div class="gc-pct">${Math.round(pct)}%</div>
        </div>
        <div class="gc-meta">
          <span>${g.progress||0} / ${g.target} ${g.notes||''}</span>
          ${deadline!==null ? `<span style="color:${deadline<0?'var(--red)':deadline<7?'var(--amber)':'var(--ink-muted)'}">${deadline<0?`${Math.abs(deadline)}d overdue`:deadline===0?'Due today':`${deadline}d left`}</span>` : ''}
        </div>
        <div style="display:flex;gap:8px;margin-top:6px">
          <button class="btn-link" data-gid="${g.id}" data-action="inc">+1 Progress</button>
          <button class="btn-link" data-gid="${g.id}" data-action="done" style="color:var(--green)">Mark Done ✓</button>
        </div>
      `;
      card.querySelector('.gc-del').addEventListener('click', () => { S.goals = S.goals.filter(x=>x.id!==g.id); save(); renderGoals(); });
      card.querySelector('[data-action="inc"]').addEventListener('click', () => { g.progress=(g.progress||0)+1; save(); renderGoals(); });
      card.querySelector('[data-action="done"]').addEventListener('click', () => { g.progress=g.target; save(); renderGoals(); });
      list.appendChild(card);
    });
  }
}

function saveGoal() {
  const title = el('gTitle').value.trim();
  const target = parseInt(el('gTarget').value)||0;
  const deadline = el('gDeadline').value;
  const notes = el('gNotes').value.trim();
  if (!title) { alert('Enter a goal title.'); return; }
  S.goals.push({ id:uid(), title, target:target||100, deadline, notes, progress:0 });
  save(); closeModal('goalModal'); renderGoals();
}

/* ============================================================
   POMODORO
   ============================================================ */
function initPomodoro() {
  const focusSecs = (S.settings.focusMins||25) * 60;
  T.pomSecondsLeft = focusSecs;
  T.pomRunning = false; T.pomBreakMode = false;
  updatePomDisplay();
}

function updatePomDisplay() {
  const m = Math.floor(T.pomSecondsLeft/60), s = T.pomSecondsLeft%60;
  el('pomTime').textContent = `${pad(m)}:${pad(s)}`;
  el('pomModeLabel').textContent = T.pomBreakMode ? '☕ Break Time' : '🎯 Focus Session';
  el('pomToggle').textContent = T.pomRunning ? 'Pause' : 'Start';

  const today = todayStr();
  if (S.pomDate !== today) { S.pomSessions = 0; S.pomDate = today; }
  el('pomSessions').textContent = S.pomSessions;
}

function togglePom() {
  if (T.pomRunning) {
    clearInterval(T.pomInterval);
    T.pomRunning = false;
  } else {
    T.pomRunning = true;
    T.pomInterval = setInterval(() => {
      T.pomSecondsLeft--;
      if (T.pomSecondsLeft <= 0) {
        clearInterval(T.pomInterval);
        T.pomRunning = false;
        if (!T.pomBreakMode) {
          S.pomSessions++;
          S.pomDate = todayStr();
          save();
        }
        T.pomBreakMode = !T.pomBreakMode;
        T.pomSecondsLeft = T.pomBreakMode ? (S.settings.breakMins||5)*60 : (S.settings.focusMins||25)*60;
        try { new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAA...').play(); } catch(e){}
      }
      updatePomDisplay();
    }, 1000);
  }
  updatePomDisplay();
}

function resetPom() {
  clearInterval(T.pomInterval);
  T.pomRunning = false; T.pomBreakMode = false;
  T.pomSecondsLeft = (S.settings.focusMins||25)*60;
  updatePomDisplay();
}

function togglePomBreak() {
  clearInterval(T.pomInterval);
  T.pomRunning = false;
  T.pomBreakMode = !T.pomBreakMode;
  T.pomSecondsLeft = T.pomBreakMode ? (S.settings.breakMins||5)*60 : (S.settings.focusMins||25)*60;
  updatePomDisplay();
}

/* ============================================================
   SECTION: HEATMAP
   ============================================================ */
function renderHeatmap() {
  const today = new Date();
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - 364);
  // align to Sunday
  startDate.setDate(startDate.getDate() - startDate.getDay());

  const grid = el('hmGrid');
  const monthsRow = el('hmMonthsRow');
  grid.innerHTML = '';
  monthsRow.innerHTML = '';

  let totalReviews = 0, activeDays = 0, bestDay = 0;
  const allCounts = [];

  // Build 53 weeks x 7 days
  for (let week = 0; week < 53; week++) {
    for (let day = 0; day < 7; day++) {
      const d = new Date(startDate);
      d.setDate(d.getDate() + week*7 + day);
      const ds = fmt(d);
      const count = S.history[ds] || 0;
      allCounts.push(count);
      totalReviews += count;
      if (count > 0) activeDays++;
      if (count > bestDay) bestDay = count;
    }
  }

  const max = bestDay || 1;
  let currentMonth = -1;

  for (let week = 0; week < 53; week++) {
    // month labels
    const firstDayOfWeek = new Date(startDate);
    firstDayOfWeek.setDate(firstDayOfWeek.getDate() + week*7);
    const monthEl = document.createElement('div');
    monthEl.className = 'hm-month-label';
    if (firstDayOfWeek.getMonth() !== currentMonth && firstDayOfWeek.getDate() <= 7) {
      monthEl.textContent = firstDayOfWeek.toLocaleDateString('en-US',{month:'short'});
      currentMonth = firstDayOfWeek.getMonth();
    }
    monthsRow.appendChild(monthEl);

    for (let day = 0; day < 7; day++) {
      const d = new Date(startDate);
      d.setDate(d.getDate() + week*7 + day);
      const ds = fmt(d);
      const count = S.history[ds] || 0;
      const level = count === 0 ? 0 : count < max*0.25 ? 1 : count < max*0.5 ? 2 : count < max*0.75 ? 3 : 4;

      const cell = document.createElement('div');
      cell.className = `hm-cell hm-${level}`;
      cell.title = `${ds}: ${count} review${count!==1?'s':''}`;
      cell.style.gridColumn = week+1;
      cell.style.gridRow = day+1;
      grid.appendChild(cell);
    }
  }

  const avg = activeDays ? Math.round(totalReviews/activeDays) : 0;
  el('actTotal').textContent = totalReviews;
  el('actDays').textContent = activeDays;
  el('actAvg').textContent = avg;
  el('actBest').textContent = bestDay;
  el('actCurrentStreak').textContent = S.currentStreak;
  el('actBestStreak').textContent = S.bestStreak;
}

/* ============================================================
   SECTION: IMPORT / EXPORT
   ============================================================ */
function renderImport() {
  refreshDeckSelects();
  // update select options
  const csvSel = el('csvDeckSelect');
  const pasteSel = el('pasteDeckSelect');
  csvSel.innerHTML = '<option value="">Use deck column / create new</option>';
  pasteSel.innerHTML = '<option value="">-- Select Deck --</option>';
  S.decks.forEach(d => {
    [csvSel, pasteSel].forEach(sel => {
      const o = document.createElement('option');
      o.value = d.id; o.textContent = d.name;
      sel.appendChild(o);
    });
  });
}

function handleCsvFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const text = e.target.result;
    const rows = parseCsv(text);
    T.csvRows = rows;
    const preview = el('csvPreview');
    preview.style.display = 'block';
    preview.textContent = `Found ${rows.length} rows. Columns: ${Object.keys(rows[0]||{}).join(', ')}\nFirst row: ${JSON.stringify(rows[0])}`;
  };
  reader.readAsText(file);
}

function parseCsv(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (!lines.length) return [];
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g,''));
  return lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g,''));
    const obj = {};
    headers.forEach((h,i) => obj[h] = vals[i]||'');
    return obj;
  });
}

function importCsv() {
  if (!T.csvRows.length) { alert('No CSV data loaded. Drop a file first.'); return; }
  const targetDeckId = el('csvDeckSelect').value;
  let imported = 0;
  T.csvRows.forEach(row => {
    const title = row.title || row.question || row.front || '';
    const content = row.notes || row.answer || row.back || '';
    const deckName = row.deck || row.category || 'Imported';
    if (!title) return;

    let deckId = targetDeckId;
    if (!deckId) {
      let deck = S.decks.find(d => d.name.toLowerCase() === deckName.toLowerCase());
      if (!deck) {
        deck = { id:uid(), name:deckName, desc:'Imported', color:DECK_COLORS[S.decks.length%DECK_COLORS.length] };
        S.decks.push(deck);
      }
      deckId = deck.id;
    }
    const id = uid();
    const startDate = todayStr();
    S.topics.push({ id, title, content, deckId, startDate, type:'standard', mode:'auto', reviewDates:calcAutoReviews(startDate) });
    sm2Init(id);
    imported++;
  });
  save(); T.csvRows = [];
  el('csvPreview').textContent = `✅ Imported ${imported} topics.`;
  renderDecks(); refreshDeckSelects();
}

function importPasteText() {
  const text = el('pasteTA').value.trim();
  const deckId = el('pasteDeckSelect').value;
  if (!text) { alert('Paste some text first.'); return; }
  if (!deckId) { alert('Select a target deck.'); return; }
  const lines = text.split('\n').filter(l => l.trim());
  let imported = 0;
  lines.forEach(line => {
    const parts = line.split('|');
    const title = parts[0].trim();
    const content = parts[1]?.trim() || '';
    if (!title) return;
    const id = uid();
    const startDate = todayStr();
    S.topics.push({ id, title, content, deckId, startDate, type:'standard', mode:'auto', reviewDates:calcAutoReviews(startDate) });
    sm2Init(id);
    imported++;
  });
  save(); el('pasteTA').value = '';
  alert(`✅ Imported ${imported} topics.`);
  renderDecks();
}

function exportCsv() {
  const rows = [['title','notes','deck','type','startDate','nextReview','repetitions','retention']];
  S.topics.forEach(t => {
    const deck = S.decks.find(d => d.id === t.deckId);
    const sm = S.sm2[t.id];
    const ret = getRetentionRate(t.id);
    rows.push([
      `"${(t.title||'').replace(/"/g,'""')}"`,
      `"${(t.content||'').replace(/"/g,'""')}"`,
      `"${(deck?.name||'').replace(/"/g,'""')}"`,
      t.type||'standard',
      t.startDate||'',
      sm?.nextReview||'',
      sm?.repetitions||0,
      ret !== null ? ret+'%' : ''
    ]);
  });
  download('mnemo-export.csv', rows.map(r=>r.join(',')).join('\n'), 'text/csv');
}

function exportJson() {
  download('mnemo-backup.json', JSON.stringify({ decks:S.decks, topics:S.topics, journal:S.journal, history:S.history, sm2:S.sm2, goals:S.goals, settings:S.settings }, null, 2), 'application/json');
}

function printStudySheet() {
  const win = window.open('','_blank');
  let html = `<html><head><title>Mnemo Study Sheet</title><style>body{font-family:Georgia,serif;padding:40px;color:#111}h1{font-size:1.5rem;border-bottom:2px solid #333;padding-bottom:8px;margin-bottom:24px}.deck{margin-bottom:32px}.deck-name{font-size:1.1rem;font-weight:700;margin-bottom:12px;color:#333}.topic{padding:10px 0;border-bottom:1px solid #eee}.topic-title{font-weight:700;margin-bottom:4px}.topic-notes{color:#555;font-size:0.9rem}</style></head><body>`;
  html += `<h1>Mnemo Study Sheet — ${new Date().toLocaleDateString()}</h1>`;
  S.decks.forEach(deck => {
    const topics = S.topics.filter(t => t.deckId === deck.id);
    if (!topics.length) return;
    html += `<div class="deck"><div class="deck-name">${esc(deck.name)} (${topics.length})</div>`;
    topics.forEach(t => { html += `<div class="topic"><div class="topic-title">${esc(t.title)}</div>${t.content?`<div class="topic-notes">${esc(t.content)}</div>`:''}</div>`; });
    html += '</div>';
  });
  html += '</body></html>';
  win.document.write(html);
  win.document.close();
  win.print();
}

function download(filename, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content],{type}));
  a.download = filename;
  a.click();
}

/* ============================================================
   SECTION: SETTINGS
   ============================================================ */
function renderSettings() {
  el('setEase').value = S.settings.ease || 2.5;
  el('setInterval').value = S.settings.intervalMod || 100;
  el('setNewCards').value = S.settings.newCardsPerDay || 20;
  el('setFocus').value = S.settings.focusMins || 25;
  el('setBreak').value = S.settings.breakMins || 5;
  el('setDailyGoal').value = S.settings.dailyGoal || 20;
  document.querySelectorAll('.theme-opt').forEach(b => b.classList.toggle('active', b.dataset.theme === S.settings.theme));
}

function saveSettings() {
  S.settings.ease = parseFloat(el('setEase').value) || 2.5;
  S.settings.intervalMod = parseInt(el('setInterval').value) || 100;
  S.settings.newCardsPerDay = parseInt(el('setNewCards').value) || 20;
  S.settings.focusMins = parseInt(el('setFocus').value) || 25;
  S.settings.breakMins = parseInt(el('setBreak').value) || 5;
  S.settings.dailyGoal = parseInt(el('setDailyGoal').value) || 20;
  S.dailyGoal = S.settings.dailyGoal;
  save();
  initPomodoro();
  alert('✅ Settings saved!');
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  S.settings.theme = theme;
  document.querySelectorAll('.theme-opt').forEach(b => b.classList.toggle('active', b.dataset.theme === theme));
  save();
}

/* ============================================================
   MODAL HELPERS
   ============================================================ */
function openModal(id) {
  el(id).classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function closeModal(id) {
  el(id).classList.add('hidden');
  document.body.style.overflow = '';
}

/* ============================================================
   HELPER UTILITIES
   ============================================================ */
function el(id) { return document.getElementById(id); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
function esc(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function refreshDeckSelects() {
  // topic modal deck select
  const fDeck = el('fDeck');
  if (fDeck) {
    const prev = fDeck.value;
    fDeck.innerHTML = '';
    S.decks.forEach(d => {
      const o = document.createElement('option');
      o.value = d.id; o.textContent = d.name;
      fDeck.appendChild(o);
    });
    if (prev) fDeck.value = prev;
  }
  // flashcard deck filter
  const fcDeck = el('fcDeckFilter');
  if (fcDeck) {
    const prev = fcDeck.value;
    fcDeck.innerHTML = '<option value="all">All Decks</option>';
    S.decks.forEach(d => {
      const o = document.createElement('option');
      o.value = d.id; o.textContent = d.name;
      fcDeck.appendChild(o);
    });
    if (prev) fcDeck.value = prev;
  }
}

function updateColorPicker(activeColor) {
  document.querySelectorAll('.color-dot').forEach(d => {
    d.classList.toggle('active', d.dataset.color === activeColor);
  });
}

function updateSchedPreview() {
  const preview = el('schedPreview');
  if (!preview) return;
  const isManual = el('schedSwitch')?.querySelector('.active')?.dataset.mode === 'manual';
  if (!isManual) { preview.textContent = ''; return; }
  if (!T.manualDates.length) {
    const s = el('fDate')?.value;
    preview.textContent = s ? `📅 ${s}` : 'Set a start date first';
    return;
  }
  preview.textContent = T.manualDates.join(' → ');
}

/* ============================================================
   KEYBOARD SHORTCUTS
   ============================================================ */
document.addEventListener('keydown', e => {
  // Escape closes modals
  if (e.key === 'Escape') {
    ['deckModal','topicModal','deleteModal','goalModal','deckDetailModal'].forEach(closeModal);
  }

  // Flashcard shortcuts (only in flashcard section)
  if (S.section === 'flashcards') {
    const fcSession = el('fcSession');
    if (!fcSession || fcSession.classList.contains('hidden')) return;
    if (e.code === 'Space' && !T.fcAnswerShown) { e.preventDefault(); fcShowAnswer(); }
    if (T.fcAnswerShown) {
      if (e.key === '1') fcRate('again');
      if (e.key === '2') fcRate('hard');
      if (e.key === '3') fcRate('good');
      if (e.key === '4') fcRate('easy');
    }
  }

  // Today session shortcuts
  if (S.section === 'today') {
    const sess = el('sessionArea');
    if (!sess || sess.classList.contains('hidden')) return;
    if (e.code === 'Space' && !T.sessAnswerShown) { e.preventDefault(); showSessionAnswer(); }
    if (T.sessAnswerShown) {
      if (e.key === '1') rateCard('again');
      if (e.key === '2') rateCard('hard');
      if (e.key === '3') rateCard('good');
      if (e.key === '4') rateCard('easy');
    }
  }
});

/* ============================================================
   INIT — wire all event listeners
   ============================================================ */
function init() {
  load();

  // Init calendar state
  const now = new Date();
  S.calYear = now.getFullYear(); S.calMonth = now.getMonth();
  S.jYear = now.getFullYear(); S.jMonth = now.getMonth();
  S.calSelected = fmt(now); S.jSelected = fmt(now);

  // Reset todayDone if it's a new day
  const stored = localStorage.getItem('mnemo_today_date');
  if (stored !== todayStr()) {
    S.todayDone = [];
    localStorage.setItem('mnemo_today_date', todayStr());
    save();
  }

  recalcStreak();
  applyTheme(S.settings.theme || 'cosmos');

  // ---- SIDEBAR NAV ----
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      switchSection(btn.dataset.section);
      // close mobile menu
      el('sidebar').classList.remove('open');
      el('sidebarOverlay').classList.remove('active');
    });
  });

  // ---- MOBILE MENU ----
  el('mobMenuBtn').addEventListener('click', () => {
    el('sidebar').classList.toggle('open');
    el('sidebarOverlay').classList.toggle('active');
  });
  el('sidebarOverlay').addEventListener('click', () => {
    el('sidebar').classList.remove('open');
    el('sidebarOverlay').classList.remove('active');
  });

  // ---- TODAY ----
  el('startSessionBtn').addEventListener('click', startSession);

  // ---- DECKS ----
  el('newDeckBtn').addEventListener('click', openNewDeck);
  el('importDeckCsvBtn').addEventListener('click', () => switchSection('import'));
  el('saveDeckBtn').addEventListener('click', saveDeck);

  // color picker
  document.getElementById('colorRow').addEventListener('click', e => {
    const dot = e.target.closest('.color-dot');
    if (!dot) return;
    T.selectedDeckColor = dot.dataset.color;
    updateColorPicker(T.selectedDeckColor);
  });

  // ---- CALENDAR ----
  el('calPrev').addEventListener('click', () => {
    if (S.calMonth===0){S.calMonth=11;S.calYear--;} else S.calMonth--;
    renderCalendar();
  });
  el('calNext').addEventListener('click', () => {
    if (S.calMonth===11){S.calMonth=0;S.calYear++;} else S.calMonth++;
    renderCalendar();
  });
  el('calTodayBtn').addEventListener('click', () => {
    const n = new Date(); S.calYear=n.getFullYear(); S.calMonth=n.getMonth(); S.calSelected=fmt(n);
    renderCalendar();
  });
  el('calAddBtn').addEventListener('click', () => openAddTopic(S.decks[0]?.id));

  // ---- TOPIC MODAL ----
  el('saveTopicBtn').addEventListener('click', saveTopic);

  el('cardTypeSwitch').addEventListener('click', e => {
    const btn = e.target.closest('.tsw-btn');
    if (!btn) return;
    el('cardTypeSwitch').querySelectorAll('.tsw-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    el('clozeHint').classList.toggle('hidden', btn.dataset.type !== 'cloze');
  });

  el('schedSwitch').addEventListener('click', e => {
    const btn = e.target.closest('.tsw-btn');
    if (!btn) return;
    el('schedSwitch').querySelectorAll('.tsw-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    el('manualZone').classList.toggle('hidden', btn.dataset.mode !== 'manual');
    if (btn.dataset.mode === 'manual' && !T.manualDates.length) {
      const s = el('fDate')?.value;
      if (s) T.manualDates = [s];
    }
    updateSchedPreview();
  });

  el('fDate').addEventListener('change', () => {
    if (el('schedSwitch').querySelector('.active')?.dataset.mode==='manual') {
      T.manualDates = [el('fDate').value];
      updateSchedPreview();
    }
  });

  el('mSaveBtn').addEventListener('click', () => {
    const days = parseInt(el('mDays').value)||0;
    if (days < 1) { alert('Enter a positive number of days.'); return; }
    const start = el('fDate').value;
    if (!start) { alert('Set a start date first.'); return; }
    if (!T.manualDates.length) T.manualDates = [start];
    T.manualDates = [T.manualDates[0], addDays(start, days)];
    el('mDays').value = '';
    updateSchedPreview();
  });

  el('mChainBtn').addEventListener('click', () => {
    const days = parseInt(el('mDays').value)||0;
    if (days < 1) { alert('Enter a positive number of days.'); return; }
    const start = el('fDate').value;
    if (!start) { alert('Set a start date first.'); return; }
    if (!T.manualDates.length) T.manualDates = [start];
    T.manualDates.push(addDays(T.manualDates[T.manualDates.length-1], days));
    el('mDays').value = '';
    updateSchedPreview();
  });

  // ---- FLASHCARDS ----
  el('fcLoadBtn').addEventListener('click', loadFlashcards);
  el('fcAgainBtn').addEventListener('click', loadFlashcards);

  // ---- DELETE MODAL ----
  el('confirmDeleteBtn').addEventListener('click', confirmDelete);

  // ---- JOURNAL ----
  el('jPrev').addEventListener('click', () => {
    if (S.jMonth===0){S.jMonth=11;S.jYear--;} else S.jMonth--;
    renderJournalMiniCal();
  });
  el('jNext').addEventListener('click', () => {
    if (S.jMonth===11){S.jMonth=0;S.jYear++;} else S.jMonth++;
    renderJournalMiniCal();
  });

  el('journalTA').addEventListener('input', () => {
    const text = el('journalTA').value;
    updateJournalStats(text);
    clearTimeout(journalSaveTimer);
    journalSaveTimer = setTimeout(() => {
      if (S.jSelected) {
        S.journal[S.jSelected] = text;
        save();
        el('jSaved').textContent = '✓ Saved';
        setTimeout(() => { el('jSaved').textContent = ''; }, 2000);
        renderJournalRecent();
        // update mini cal dot
        document.querySelectorAll('.jmc-cell').forEach((c, i) => {
          // rough: just re-render
        });
        renderJournalMiniCal();
      }
    }, 800);
  });

  // ---- GOALS ----
  el('newGoalBtn').addEventListener('click', () => openModal('goalModal'));
  el('saveGoalBtn').addEventListener('click', saveGoal);
  el('editDailyGoalBtn').addEventListener('click', () => {
    const v = prompt('Daily card goal:', S.settings.dailyGoal||20);
    if (v && !isNaN(v)) { S.settings.dailyGoal=parseInt(v); S.dailyGoal=S.settings.dailyGoal; save(); renderGoals(); }
  });

  // ---- POMODORO ----
  initPomodoro();
  el('pomToggle').addEventListener('click', togglePom);
  el('pomReset').addEventListener('click', resetPom);
  el('pomBreakToggle').addEventListener('click', togglePomBreak);

  // ---- IMPORT/EXPORT ----
  const drop = el('importDrop');
  drop.addEventListener('click', () => el('csvInput').click());
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
  drop.addEventListener('drop', e => {
    e.preventDefault(); drop.classList.remove('drag-over');
    handleCsvFile(e.dataTransfer.files[0]);
  });
  el('csvInput').addEventListener('change', e => handleCsvFile(e.target.files[0]));
  el('csvImportBtn').addEventListener('click', importCsv);
  el('pasteImportBtn').addEventListener('click', importPasteText);
  el('exportCsvBtn').addEventListener('click', exportCsv);
  el('exportJsonBtn').addEventListener('click', exportJson);
  el('printBtn').addEventListener('click', printStudySheet);

  // ---- SETTINGS ----
  el('saveSettingsBtn').addEventListener('click', saveSettings);
  el('clearDataBtn').addEventListener('click', () => {
    if (confirm('Delete ALL data? This cannot be undone.')) {
      localStorage.removeItem(VERSION);
      location.reload();
    }
  });
  document.querySelectorAll('.theme-opt').forEach(btn => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
  });

  // ---- Start ----
  switchSection('today');
}

document.addEventListener('DOMContentLoaded', init);