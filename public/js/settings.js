(() => {
  'use strict';
  const { api, toast, esc } = window.QB;
  const form = document.getElementById('settingsForm');
  const projectId = form.dataset.projectId;
  const box = document.getElementById('tagMap');
  const map = JSON.parse(box.dataset.map || '{}');
  const groups = [
    ['status', 'Tag per stato', JSON.parse(box.dataset.status)],
    ['priority', 'Tag per priorità', JSON.parse(box.dataset.priority)],
  ];
  let tags = null; // null finché il forum non viene verificato

  function renderTagMap() {
    box.innerHTML = groups.map(([group, title, items]) => `
      <fieldset class="space-y-3"><legend class="mb-2 text-xs text-muted">${title}</legend>
      ${items.map(([key, label]) => {
        const current = map[group]?.[key] || '';
        const options = tags
          ? tags.map((t) => `<option value="${esc(t.id)}" ${t.id === current ? 'selected' : ''}>${esc(t.name)}</option>`).join('')
          : (current ? `<option value="${esc(current)}" selected>ID ${esc(current)}</option>` : '');
        return `<label class="block text-xs text-slate-300">${label}
          <select data-group="${group}" data-key="${key}" class="mt-1 w-full rounded-lg border border-edge bg-canvas p-2 text-sm"${tags || current ? '' : ' disabled'}>
            <option value="">— nessun tag —</option>${options}</select></label>`;
      }).join('')}</fieldset>`).join('');
  }
  renderTagMap();

  const readMap = () => {
    const out = { status: {}, priority: {} };
    box.querySelectorAll('select[data-group]').forEach((s) => { if (s.value) out[s.dataset.group][s.dataset.key] = s.value; });
    return out;
  };
  const guild = () => form.elements.discord_guild_id.value.trim();
  const forum = () => form.elements.discord_forum_id.value.trim();

  document.getElementById('checkDiscord').addEventListener('click', async (e) => {
    const out = document.getElementById('checkResult');
    out.className = 'text-xs text-muted';
    out.textContent = 'Verifica in corso…';
    e.target.disabled = true;
    try {
      const current = readMap();
      const r = await api('POST', `/api/projects/${projectId}/discord/check`, {
        discord_guild_id: guild(), discord_forum_id: forum(), discord_tag_map: current,
      });
      tags = r.tags || [];
      Object.assign(map, current);
      renderTagMap();
      out.className = `text-xs ${r.ok ? 'text-emerald-300' : 'text-red-300'}`;
      out.textContent = r.ok ? `Forum valido${r.forumName ? `: #${r.forumName}` : ''} · ${tags.length} tag disponibili.` : r.problems.join(' ');
    } catch (err) {
      out.className = 'text-xs text-red-300';
      out.textContent = err.message;
    } finally { e.target.disabled = false; }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('settingsError');
    err.textContent = '';
    const categories = form.elements.categories.value.split('\n').map((s) => s.trim()).filter(Boolean);
    try {
      await api('PUT', `/api/projects/${projectId}/settings`, {
        name: form.elements.name.value,
        description: form.elements.description.value,
        categories,
        discord_guild_id: guild(),
        discord_forum_id: forum(),
        discord_tag_map: readMap(),
      });
      toast('Impostazioni salvate');
    } catch (ex) {
      err.textContent = [ex.message, ...Object.values(ex.fields || {})].filter((v, i, a) => v && a.indexOf(v) === i).join(' — ');
    }
  });
})();
