(() => {
  'use strict';
  const { api, toast, esc } = window.QB;
  const $ = (id) => document.getElementById(id);

  const boot = JSON.parse($('boot').textContent);
  const STATUSES = ['todo', 'in_progress', 'review', 'done'];
  const PRIORITIES = ['critical', 'high', 'medium', 'low'];
  const STATUS_LABELS = { todo: 'Da fare', in_progress: 'In corso', review: 'Da verificare', done: 'Completato' };
  const PRIORITY_LABELS = { critical: 'Critica', high: 'Alta', medium: 'Media', low: 'Bassa' };
  const SOURCE_LABELS = { web: 'Sito', discord: 'Discord', system: 'Sistema' };
  const DOTS = { todo: 'bg-slate-400', in_progress: 'bg-orange-400', review: 'bg-violet-400', done: 'bg-emerald-400' };
  const BADGES = {
    critical: 'bg-red-400/10 text-red-300', high: 'bg-orange-400/10 text-orange-300',
    medium: 'bg-blue-400/10 text-blue-300', low: 'bg-slate-400/10 text-slate-400',
  };
  const SYNC = {
    none: ['○ Non pubblicato', 'text-slate-500'], pending: ['◌ In attesa', 'text-amber-300'],
    synced: ['◉ Sincronizzato', 'text-emerald-300'], error: ['⚠ Errore', 'text-red-300'], missing: ['⊘ Post eliminato', 'text-red-300'],
  };
  const FIELD_NAMES = {
    title: 'Titolo', description: 'Descrizione', checklist: 'Checklist', priority: 'Priorità', status: 'Stato',
    category: 'Categoria', assignee: 'Assegnatario', build: 'Build', due_date: 'Scadenza', mode: 'Sincronizzazione', thread: 'Post Discord',
  };

  // ------------------------------------------------------------------ stato
  const S = {
    project: boot.project, me: boot.me, members: boot.members, builds: boot.builds,
    tasks: new Map(boot.tasks.map((t) => [t.id, t])),
    selected: null, history: [],
    filters: { q: '', status: '', priority: '', category: '', owner: '' },
    dialog: null, // { task, base, version }
  };
  const list = () => [...S.tasks.values()].sort((a, b) => a.seq - b.seq);

  // ------------------------------------------------------------------ permessi (solo per la UI: il server ricontrolla tutto)
  const isAdmin = () => S.me.isAdmin;
  const canApprove = () => S.me.isAdmin || (S.me.role === 'tester' && S.me.canApprove);
  const DEV_MOVES = new Set(['todo>in_progress', 'in_progress>todo', 'in_progress>review', 'review>in_progress']);
  const APPROVER_MOVES = new Set(['review>done', 'review>in_progress', 'review>todo', 'done>in_progress']);
  function canMove(t, to) {
    if (t.archived || t.status === to) return false;
    if (isAdmin()) return true;
    const key = `${t.status}>${to}`;
    if (S.me.role === 'developer') return t.assignee?.id === S.me.userId && DEV_MOVES.has(key);
    if (S.me.role === 'tester') return canApprove() && APPROVER_MOVES.has(key);
    return false;
  }
  function editable(t) {
    if (t.archived) return [];
    if (isAdmin()) return ['title', 'description', 'checklist', 'priority', 'category', 'assignee_id', 'due_date', 'build_id', 'status'];
    if (S.me.role === 'developer' && t.assignee?.id === S.me.userId) return ['description', 'checklist', 'status'];
    if (S.me.role === 'tester') {
      return t.author?.id === S.me.userId && t.status === 'todo' ? ['title', 'description', 'checklist', 'category', 'status'] : ['status'];
    }
    return [];
  }

  // ------------------------------------------------------------------ utilità
  const initials = (n) => (n || '?').slice(0, 2).toUpperCase();
  const today = () => new Date().toLocaleDateString('sv-SE');
  const fmtDate = (iso) => new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
  const overdue = (t) => t.due_date && t.status !== 'done' && t.due_date < today();
  const valueLabel = (field, v) => {
    if (v === null || v === undefined || v === '') return '—';
    if (field === 'status') return STATUS_LABELS[v] || v;
    if (field === 'priority') return PRIORITY_LABELS[v] || v;
    return v;
  };
  const sel = () => (S.selected ? S.tasks.get(S.selected) : null);

  function visible(t) {
    const f = S.filters;
    if (f.status && t.status !== f.status) return false;
    if (f.priority && t.priority !== f.priority) return false;
    if (f.category && t.category !== f.category) return false;
    if (f.owner === 'none' && t.assignee) return false;
    if (f.owner && f.owner !== 'none' && String(t.assignee?.id) !== f.owner) return false;
    if (f.q) {
      const hay = `${t.title} ${t.description} ${t.code}`.toLowerCase();
      if (!hay.includes(f.q.toLowerCase())) return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ rendering
  function renderStats() {
    const all = list();
    const done = all.filter((t) => t.status === 'done').length;
    const pct = all.length ? Math.round((done / all.length) * 100) : 0;
    const cards = [
      ['Task totali', all.length, 'Obiettivi del progetto'],
      ['In lavorazione', all.filter((t) => t.status === 'in_progress').length, 'Attività del team'],
      ['Da verificare', all.filter((t) => t.status === 'review').length, 'In attesa di approvazione'],
      ['Avanzamento', `${pct}%`, `${done} task completati`],
    ];
    $('stats').innerHTML = cards.map((c) => `
      <div class="rounded-xl border border-edge bg-panel p-5">
        <p class="text-xs text-muted">${c[0]}</p>
        <p class="mt-3 text-3xl font-semibold tracking-tight text-white">${c[1]}</p>
        <p class="mt-2 text-[11px] text-muted">${c[2]}</p>
      </div>`).join('');
  }

  function renderRelease() {
    const rel = S.builds.find((b) => !b.released);
    const name = $('releaseName'); const bar = $('sideProgress'); const label = $('sideLabel');
    if (!name || !bar || !label) return;
    if (!rel) { name.textContent = 'Nessuna build pianificata'; label.textContent = ''; bar.parentElement.classList.add('hidden'); return; }
    const mine = list().filter((t) => t.build?.id === rel.id);
    const done = mine.filter((t) => t.status === 'done').length;
    name.textContent = rel.name;
    bar.parentElement.classList.remove('hidden');
    bar.style.width = `${mine.length ? Math.round((done / mine.length) * 100) : 0}%`;
    label.textContent = `${done} di ${mine.length} task completati`;
  }

  function syncBadge(t) {
    if (!S.project.discord.configured && !t.discord.linked) return '';
    const [text, cls] = SYNC[t.discord.status] || SYNC.none;
    return `<span class="${cls}">${text}</span>`;
  }

  function renderBoard() {
    const vis = list().filter(visible);
    $('filterCount').textContent = vis.length === S.tasks.size ? '' : `${vis.length} di ${S.tasks.size} task`;
    $('board').innerHTML = STATUSES.map((st, i) => {
      const col = vis.filter((t) => t.status === st);
      return `
      <section class="min-h-[300px] rounded-xl border border-edge/70 bg-[#14171c] p-3" aria-label="${STATUS_LABELS[st]}">
        <div class="mb-4 flex items-center gap-2 px-1 py-2">
          <span class="h-2 w-2 rounded-full ${DOTS[st]}"></span>
          <h2 class="text-xs font-semibold">${STATUS_LABELS[st]}</h2>
          <span class="ml-auto rounded-md bg-white/5 px-2 py-0.5 text-[11px] text-muted">${col.length}</span>
        </div>
        ${col.map((t) => `
          <button data-select="${t.id}" aria-pressed="${S.selected === t.id}" class="mb-3 block w-full rounded-lg border ${S.selected === t.id ? 'border-accent/70' : 'border-edge'} bg-panel p-4 text-left transition hover:border-slate-500">
            <span class="text-[10px] tracking-wide text-slate-500">${esc(t.code)}</span>
            <h3 class="mb-4 mt-2 text-sm font-semibold leading-5 text-slate-100">${esc(t.title)}</h3>
            <div class="flex flex-wrap gap-1.5">
              <span class="rounded-md px-2 py-1 text-[10px] ${BADGES[t.priority]}">${PRIORITY_LABELS[t.priority]}</span>
              ${t.category ? `<span class="rounded-md bg-white/5 px-2 py-1 text-[10px] text-muted">${esc(t.category)}</span>` : ''}
              ${t.due_date ? `<span class="rounded-md px-2 py-1 text-[10px] ${overdue(t) ? 'bg-red-400/10 text-red-300' : 'bg-white/5 text-muted'}">${esc(t.due_date)}</span>` : ''}
            </div>
            <div class="mt-4 flex items-center justify-between gap-1 border-t border-edge pt-3 text-[10px] text-muted">
              <span class="flex min-w-0 items-center gap-1.5">
                <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-700/60 text-[9px] text-slate-300">${t.assignee ? esc(initials(t.assignee.name)) : '–'}</span>
                <span class="truncate">${t.assignee ? esc(t.assignee.name) : 'Non assegnato'}</span>
              </span>
              ${syncBadge(t)}
            </div>
          </button>`).join('')}
        ${col.length ? '' : '<p class="py-8 text-center text-xs text-slate-600">Nessun task</p>'}
        ${i === 0 && S.me.canCreate ? '<button data-new class="w-full rounded-lg border border-dashed border-edge py-3 text-xs text-muted hover:text-white">+ Aggiungi task</button>' : ''}
      </section>`;
    }).join('');
  }

  const selectBox = (id, label, options, value, disabled, action) => `
    <div><label for="${id}" class="mb-2 block text-xs text-muted">${label}</label>
    <select id="${id}" data-change="${action}" ${disabled ? 'disabled' : ''} class="w-full rounded-lg border border-edge bg-canvas p-3 text-xs">
      ${options.map(([v, l, dis]) => `<option value="${esc(v)}" ${String(v) === String(value ?? '') ? 'selected' : ''} ${dis ? 'disabled' : ''}>${esc(l)}</option>`).join('')}
    </select></div>`;

  function discordSection(t) {
    const d = S.project.discord;
    if (!d.configured && !t.discord.linked) {
      return isAdmin() ? `<p class="text-[11px] leading-5 text-slate-500">Questo progetto non è collegato a un forum Discord. Puoi collegarlo dalle <a class="underline" href="/p/${esc(S.project.slug)}/settings">impostazioni</a>, oppure usare Questboard senza Discord.</p>` : '';
    }
    const [text, cls] = SYNC[t.discord.status] || SYNC.none;
    const buttons = [];
    if (isAdmin() && !t.archived) {
      if (t.discord.status === 'missing') buttons.push(['repost', '↗ Ripubblica su Discord']);
      else if (!t.discord.linked) buttons.push(['publish', t.discord.status === 'error' ? '↻ Riprova la pubblicazione' : '↗ Pubblica su Discord']);
      else if (t.discord.status === 'error') buttons.push(['retry', '↻ Riprova la sincronizzazione']);
    }
    return `
      <div class="mb-3 flex items-center justify-between"><p class="text-xs font-semibold">Discord</p><span class="text-[11px] ${cls}">${text}</span></div>
      ${t.discord.error ? `<p class="mb-3 rounded-lg border border-edge bg-canvas p-3 text-[11px] leading-5 ${t.discord.status === 'pending' ? 'text-amber-200' : 'text-red-300'}">${esc(t.discord.error)}</p>` : ''}
      ${t.discord.url ? `<a href="${esc(t.discord.url)}" target="_blank" rel="noopener noreferrer" class="mb-3 block text-xs text-orange-400 underline">Apri il post sul forum</a>` : ''}
      ${buttons.map(([a, l]) => `<button data-act="${a}" class="mb-2 w-full rounded-lg border border-edge bg-white/5 px-3 py-3 text-xs font-semibold hover:bg-white/10">${l}</button>`).join('')}
      ${!d.botAvailable && isAdmin() ? '<p class="text-[10px] leading-5 text-amber-300/80">Bot non configurato (DISCORD_BOT_TOKEN): nessun messaggio verrà inviato.</p>' : ''}`;
  }

  function describeChange(field, c) {
    if (field === 'checklist' || field === 'description') return `${FIELD_NAMES[field]}: ${esc(c.to)}`;
    if (field === 'thread') return 'Post creato su Discord';
    return `${FIELD_NAMES[field] || esc(field)}: ${esc(valueLabel(field, c.from))} → ${esc(valueLabel(field, c.to))}`;
  }
  function renderHistory() {
    if (!S.history.length) return '<p class="text-xs text-slate-500">Nessuna modifica registrata.</p>';
    const TYPE = {
      created: 'Task creato', archived: 'Task archiviato', restored: 'Task ripristinato', sync_requested: 'Sincronizzazione Discord richiesta',
      discord_published: 'Pubblicato su Discord', discord_linked: 'Collegato al post Discord esistente', discord_missing: 'Post Discord eliminato',
    };
    return `<ol class="space-y-3">${S.history.map((ev) => {
      const changes = Object.entries(ev.changes || {}).filter(([k]) => !(ev.type === 'created' && k === 'title')).map(([k, c]) => describeChange(k, c));
      return `<li class="border-l border-edge pl-3 text-[11px] leading-5">
        <p class="text-slate-300"><span class="font-semibold">${esc(ev.actor?.name || 'Sistema')}</span>
          <span class="ml-1 rounded bg-white/5 px-1.5 py-0.5 text-[9px] text-muted">${SOURCE_LABELS[ev.source] || ev.source}</span></p>
        ${TYPE[ev.type] ? `<p class="text-muted">${TYPE[ev.type]}</p>` : ''}
        ${changes.map((c) => `<p class="text-muted">${c}</p>`).join('')}
        <p class="text-slate-600">${fmtDate(ev.created_at)}</p></li>`;
    }).join('')}</ol>`;
  }

  function renderDetail() {
    const box = $('detail');
    const t = sel();
    if (!t) { box.innerHTML = '<p class="text-sm text-muted">Seleziona un task dalla board per vederne il dettaglio.</p>'; return; }
    const ed = editable(t);
    const done = t.checklist.filter((i) => i.done).length;
    box.innerHTML = `
    <div class="grid gap-6 md:grid-cols-2 2xl:grid-cols-1">
      <section class="min-w-0">
        <p class="text-xs font-semibold text-muted">Dettaglio task</p>
        <div class="mt-5 flex items-center justify-between">
          <span class="text-[10px] text-slate-500">${esc(t.code)}${t.archived ? ' · archiviato' : ''}</span>
          <span class="rounded-md px-2 py-1 text-[10px] ${BADGES[t.priority]}">${PRIORITY_LABELS[t.priority]}</span>
        </div>
        <h2 class="mt-3 text-xl font-semibold leading-7 text-white">${esc(t.title)}</h2>
        <p class="pre-wrap mt-3 text-sm leading-6 text-muted">${esc(t.description) || '<span class="text-slate-600">Nessuna descrizione</span>'}</p>

        ${t.checklist.length ? `
        <div class="mt-5"><p class="mb-2 text-xs text-muted">Criteri di completamento · ${done}/${t.checklist.length}</p>
          <ul class="space-y-1">${t.checklist.map((i) => `
            <li><label class="flex items-start gap-2 rounded-md px-1 py-1 text-sm ${i.done ? 'text-slate-500 line-through' : 'text-slate-200'}">
              <input type="checkbox" data-check="${esc(i.id)}" class="mt-1" ${i.done ? 'checked' : ''} ${ed.includes('checklist') ? '' : 'disabled'}>
              <span class="pre-wrap">${esc(i.text)}</span></label></li>`).join('')}</ul></div>` : ''}

        <div class="mt-5 grid grid-cols-2 gap-3">
          ${selectBox('d-status', 'Stato', STATUSES.map((s) => [s, STATUS_LABELS[s], s !== t.status && !canMove(t, s)]), t.status, !ed.includes('status'), 'status')}
          ${selectBox('d-priority', 'Priorità', PRIORITIES.map((p) => [p, PRIORITY_LABELS[p]]), t.priority, !ed.includes('priority'), 'priority')}
        </div>
        <div class="mt-3">${selectBox('d-assignee', 'Responsabile',
          [['', 'Non assegnato'], ...S.members.map((m) => [m.id, m.name])], t.assignee?.id, !ed.includes('assignee_id'), 'assignee_id')}</div>

        <dl class="mt-5 grid grid-cols-2 gap-x-3 gap-y-2 text-[11px]">
          <dt class="text-muted">Categoria</dt><dd class="text-right text-slate-300">${esc(t.category) || '—'}</dd>
          <dt class="text-muted">Scadenza</dt><dd class="text-right ${overdue(t) ? 'text-red-300' : 'text-slate-300'}">${esc(t.due_date) || '—'}</dd>
          <dt class="text-muted">Build</dt><dd class="text-right text-slate-300">${t.build ? esc(t.build.name) : '—'}</dd>
          <dt class="text-muted">Autore</dt><dd class="text-right text-slate-300">${t.author ? esc(t.author.name) : '—'}</dd>
          <dt class="text-muted">Creato</dt><dd class="text-right text-slate-300">${fmtDate(t.created_at)}</dd>
          <dt class="text-muted">Aggiornato</dt><dd class="text-right text-slate-300">${fmtDate(t.updated_at)}</dd>
        </dl>

        <div class="mt-5 flex flex-wrap gap-2">
          ${ed.some((f) => f !== 'status') ? '<button data-act="edit" class="rounded-lg border border-edge px-4 py-2 text-xs font-semibold hover:bg-white/5">Modifica</button>' : ''}
          ${isAdmin() ? `<button data-act="${t.archived ? 'restore' : 'archive'}" class="rounded-lg border border-edge px-4 py-2 text-xs hover:bg-white/5">${t.archived ? 'Ripristina' : 'Archivia'}</button>` : ''}
        </div>
      </section>

      <section class="min-w-0 border-t border-edge pt-5 md:border-t-0 md:pt-0 2xl:border-t 2xl:pt-5">
        ${discordSection(t)}
        <p class="mb-3 mt-6 text-xs font-semibold">Storico</p>
        <div id="history" class="max-h-96 overflow-y-auto pr-1">${renderHistory()}</div>
      </section>
    </div>`;
  }

  function renderFilters() {
    const cat = $('categoryFilter'); const own = $('ownerFilter');
    const cats = [...new Set([...S.project.categories, ...list().map((t) => t.category).filter(Boolean)])];
    cat.innerHTML = `<option value="">Tutte le categorie</option>${cats.map((c) => `<option ${S.filters.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}`;
    own.innerHTML = `<option value="">Tutto il team</option><option value="none" ${S.filters.owner === 'none' ? 'selected' : ''}>Non assegnati</option>${
      S.members.map((m) => `<option value="${m.id}" ${S.filters.owner === String(m.id) ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}`;
  }

  function renderAll() { renderStats(); renderRelease(); renderBoard(); renderDetail(); }

  // ------------------------------------------------------------------ selezione / storico
  async function loadHistory(id) {
    try {
      const r = await api('GET', `/api/tasks/${id}/history`);
      if (S.selected === id) { S.history = r.events; const h = $('history'); if (h) h.innerHTML = renderHistory(); }
    } catch { /* lo storico non e bloccante */ }
  }
  function select(id, { push = true } = {}) {
    S.selected = id;
    S.history = [];
    renderBoard(); renderDetail();
    const t = sel();
    if (t) {
      loadHistory(id);
      if (push) history.pushState({ id }, '', `/p/${S.project.slug}/tasks/${encodeURIComponent(t.code)}`);
    }
  }

  // ------------------------------------------------------------------ aggiornamenti dal server
  function applyTask(dto) {
    if (!dto || dto.project_id !== S.project.id) return;
    const old = S.tasks.get(dto.id);
    if (old && dto.version < old.version) return; // pacchetto in ritardo
    if (dto.archived) {
      S.tasks.delete(dto.id);
      if (S.selected === dto.id) { S.selected = null; S.history = []; toast(`${dto.code} è stato archiviato`); }
    } else {
      S.tasks.set(dto.id, dto);
    }
    // se la modifica remota riguarda il task aperto nel dialog: segnala il conflitto
    if (S.dialog?.task?.id === dto.id && S.dialog.version !== dto.version) $('conflictBanner').classList.remove('hidden');
    renderAll();
  }
  function applySnapshot(snap) {
    S.project = snap.project; S.me = snap.me; S.members = snap.members; S.builds = snap.builds;
    S.tasks = new Map(snap.tasks.map((t) => [t.id, t]));
    if (S.selected && !S.tasks.has(S.selected)) S.selected = null;
    renderFilters(); renderAll();
    if (S.selected) loadHistory(S.selected);
  }
  const resync = () => new Promise((resolve) => {
    socket.emit('snapshot', { projectId: S.project.id }, (res) => {
      if (res?.ok) applySnapshot(res.snapshot); else window.location.href = '/';
      resolve();
    });
  });

  // ------------------------------------------------------------------ azioni
  async function patch(t, changes) {
    try {
      const r = await api('PATCH', `/api/tasks/${t.id}`, { version: t.version, changes });
      applyTask(r.task);
    } catch (e) {
      if (e.code === 'conflict' && e.current) {
        applyTask(e.current);
        toast('Il task è stato modificato da qualcun altro: ho caricato i dati aggiornati, ripeti la modifica se serve.', 'warn');
      } else toast(e.message, 'error');
      renderDetail();
    }
  }
  async function post(path, t, body) {
    try {
      const r = await api('POST', `/api/tasks/${t.id}/${path}`, body);
      applyTask(r.task);
      if (path === 'archive' || path === 'restore') toast(path === 'archive' ? 'Task archiviato' : 'Task ripristinato');
      else toast('Sincronizzazione Discord richiesta');
    } catch (e) {
      if (e.code === 'conflict' && e.current) applyTask(e.current);
      toast(e.message, 'error');
    }
  }

  // ------------------------------------------------------------------ dialog crea/modifica
  const F = {
    form: $('taskForm'), title: $('f-title'), description: $('f-description'), checklist: $('f-checklist'),
    priority: $('f-priority'), assignee: $('f-assignee'), category: $('f-category'), build: $('f-build'), due: $('f-due'),
  };
  function fillSelects(t) {
    F.assignee.innerHTML = `<option value="">Non assegnato</option>${S.members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}`;
    const cats = [...S.project.categories]; if (t?.category && !cats.includes(t.category)) cats.push(t.category);
    F.category.innerHTML = `<option value="">—</option>${cats.map((c) => `<option>${esc(c)}</option>`).join('')}`;
    F.build.innerHTML = `<option value="">Nessuna</option>${S.builds.filter((b) => !b.released || b.id === t?.build?.id)
      .map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}`;
  }
  function fillForm(t) {
    F.title.value = t?.title || '';
    F.description.value = t?.description || '';
    F.checklist.value = (t?.checklist || []).map((i) => i.text).join('\n');
    F.priority.value = t?.priority || 'medium';
    F.assignee.value = t?.assignee?.id ?? '';
    F.category.value = t?.category || '';
    F.build.value = t?.build?.id ?? '';
    F.due.value = t?.due_date || '';
  }
  const checklistLines = () => F.checklist.value.split('\n').map((s) => s.trim()).filter(Boolean);
  function checklistFromLines(existing) {
    const pool = [...existing];
    return checklistLines().map((text) => {
      const k = pool.findIndex((i) => i.text === text);
      if (k >= 0) { const [it] = pool.splice(k, 1); return { id: it.id, text, done: it.done }; }
      return { text, done: false };
    });
  }
  function formValues(existingChecklist) {
    return {
      title: F.title.value.trim(), description: F.description.value, checklist: checklistFromLines(existingChecklist),
      priority: F.priority.value, assignee_id: F.assignee.value || null, category: F.category.value,
      build_id: F.build.value || null, due_date: F.due.value || null,
    };
  }
  function clearFormErrors() {
    $('taskFormError').textContent = '';
    F.form.querySelectorAll('[data-error-for]').forEach((p) => { p.textContent = ''; });
    $('conflictBanner').classList.add('hidden');
  }
  function openDialog(task) {
    if (!task && !S.me.canCreate) return;
    clearFormErrors();
    fillSelects(task);
    fillForm(task);
    const ed = task ? editable(task) : ['title', 'description', 'checklist', 'priority', 'category'].concat(isAdmin() ? ['assignee_id', 'due_date', 'build_id'] : []);
    const map = { title: F.title, description: F.description, checklist: F.checklist, priority: F.priority, assignee_id: F.assignee, category: F.category, build_id: F.build, due_date: F.due };
    for (const [key, el] of Object.entries(map)) el.disabled = !ed.includes(key);
    S.dialog = task ? { task, base: formValues(task.checklist), version: task.version } : { task: null };
    $('taskDialogTitle').textContent = task ? `Modifica ${task.code}` : (isAdmin() ? 'Nuovo task' : 'Nuova segnalazione');
    $('taskDialogHint').textContent = task ? 'Vengono inviati solo i campi che modifichi.' : (isAdmin() ? 'Un obiettivo chiaro per la prossima build.' : 'Descrivi il problema e come riprodurlo.');
    $('taskSubmit').textContent = task ? 'Salva modifiche' : (isAdmin() ? 'Crea task' : 'Invia segnalazione');
    $('taskDialog').showModal();
    F.title.focus();
  }
  async function submitDialog(e) {
    e.preventDefault();
    clearFormErrors();
    const btn = $('taskSubmit'); btn.disabled = true;
    try {
      if (!S.dialog.task) {
        const body = formValues([]);
        if (!isAdmin()) { delete body.assignee_id; delete body.build_id; delete body.due_date; }
        const r = await api('POST', `/api/projects/${S.project.id}/tasks`, body);
        S.tasks.set(r.task.id, r.task);
        $('taskDialog').close();
        ['search', 'statusFilter', 'priorityFilter', 'categoryFilter', 'ownerFilter'].forEach((id) => { $(id).value = ''; });
        S.filters = { q: '', status: '', priority: '', category: '', owner: '' };
        select(r.task.id);
        renderAll();
        toast(`${r.task.code} creato`);
      } else {
        const cur = S.tasks.get(S.dialog.task.id) || S.dialog.task;
        const now = formValues(S.dialog.task.checklist);
        const changes = {};
        for (const k of Object.keys(now)) {
          if (F.form.querySelector(`[name="${k}"]`)?.disabled) continue;
          if (JSON.stringify(now[k]) !== JSON.stringify(S.dialog.base[k])) changes[k] = now[k];
        }
        if (!Object.keys(changes).length) { $('taskDialog').close(); return; }
        const r = await api('PATCH', `/api/tasks/${cur.id}`, { version: S.dialog.version, changes });
        applyTask(r.task);
        $('taskDialog').close();
        toast('Task aggiornato');
      }
    } catch (err) {
      if (err.code === 'conflict' && err.current) {
        applyTask(err.current);
        $('conflictBanner').classList.remove('hidden');
        $('taskFormError').textContent = 'Non ho sovrascritto nulla. Carica la versione aggiornata per vedere cosa è cambiato.';
      } else {
        F.form.querySelectorAll('[data-error-for]').forEach((p) => { p.textContent = err.fields?.[p.dataset.errorFor] || ''; });
        $('taskFormError').textContent = err.message;
      }
    } finally { btn.disabled = false; }
  }
  $('loadLatest').addEventListener('click', () => {
    const cur = S.tasks.get(S.dialog.task.id);
    if (!cur) { $('taskDialog').close(); return; }
    clearFormErrors();
    fillSelects(cur); fillForm(cur);
    S.dialog = { task: cur, base: formValues(cur.checklist), version: cur.version };
  });
  F.form.addEventListener('submit', submitDialog);
  $('taskDialog').addEventListener('close', () => { S.dialog = null; });

  // ------------------------------------------------------------------ eventi UI
  document.addEventListener('click', (e) => {
    if (e.target.closest('#newTaskBtn, [data-new]')) { openDialog(null); return; }
    const card = e.target.closest('[data-select]');
    if (card) { select(Number(card.dataset.select)); return; }
    const act = e.target.closest('[data-act]');
    if (act) {
      const t = sel(); if (!t) return;
      const a = act.dataset.act;
      if (a === 'edit') openDialog(t);
      else if (a === 'archive' || a === 'restore') post(a, t, { version: t.version });
      else if (a === 'publish' || a === 'retry' || a === 'repost') post(a, t);
    }
  });
  $('detail').addEventListener('change', (e) => {
    const t = sel(); if (!t) return;
    const target = e.target;
    if (target.dataset.check) {
      patch(t, { checklist: t.checklist.map((i) => (i.id === target.dataset.check ? { ...i, done: target.checked } : i)) });
    } else if (target.dataset.change) {
      const k = target.dataset.change;
      const v = k === 'assignee_id' ? (target.value ? Number(target.value) : null) : target.value;
      patch(t, { [k]: v });
    }
  });
  const bindFilter = (id, key, evt = 'change') => $(id).addEventListener(evt, (e) => { S.filters[key] = e.target.value; renderBoard(); });
  bindFilter('search', 'q', 'input'); bindFilter('statusFilter', 'status'); bindFilter('priorityFilter', 'priority');
  bindFilter('categoryFilter', 'category'); bindFilter('ownerFilter', 'owner');
  window.addEventListener('popstate', () => {
    const m = /\/tasks\/([^/]+)$/.exec(location.pathname);
    const t = m && list().find((x) => x.code === decodeURIComponent(m[1]));
    select(t ? t.id : null, { push: false });
  });

  // ------------------------------------------------------------------ Socket.IO
  const conn = $('connState');
  function setConn(state) {
    conn.classList.remove('hidden', 'text-emerald-300', 'text-amber-300');
    if (state === 'on') { conn.textContent = '● Tempo reale attivo'; conn.classList.add('text-emerald-300'); }
    else { conn.textContent = '○ Riconnessione…'; conn.classList.add('text-amber-300'); }
  }
  setConn('off');
  // eslint-disable-next-line no-undef
  const socket = io({ transports: ['websocket', 'polling'] });
  let connectedOnce = false;
  socket.on('connect', async () => {
    setConn('on');
    if (connectedOnce) { await resync(); toast('Riconnesso: dati riallineati'); } // snapshot dopo una riconnessione
    connectedOnce = true;
  });
  socket.on('disconnect', () => setConn('off'));
  socket.on('connect_error', (err) => { if (err.message === 'unauthorized') window.location.href = '/login'; });
  socket.on('task:updated', applyTask);
  socket.on('task:event', (ev) => {
    if (ev.task_id !== S.selected || S.history.some((x) => x.id === ev.id)) return;
    S.history.unshift(ev);
    const h = $('history'); if (h) h.innerHTML = renderHistory();
  });
  socket.on('project:changed', () => resync());
  socket.on('project:removed', ({ projectId }) => { if (projectId === S.project.id) window.location.href = '/'; });

  // ------------------------------------------------------------------ avvio
  renderFilters();
  const initial = boot.selectedCode ? list().find((t) => t.code === boot.selectedCode) : list().find(visible);
  S.selected = initial ? initial.id : null;
  renderAll();
  if (S.selected) loadHistory(S.selected);
})();
