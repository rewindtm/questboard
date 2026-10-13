(() => {
  'use strict';
  const csrf = () => document.querySelector('meta[name="csrf-token"]')?.content || '';

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  class QBError extends Error {
    constructor(status, body) {
      super(body?.message || 'Errore di rete');
      this.status = status;
      this.code = body?.error;
      this.fields = body?.fields || {};
      this.current = body?.current || null;
    }
  }

  async function api(method, url, body) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrf() },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
      });
    } catch {
      throw new QBError(0, { message: 'Connessione assente: riprova.', error: 'network' });
    }
    if (res.status === 401) { window.location.href = '/login'; throw new QBError(401, { message: 'Sessione scaduta' }); }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new QBError(res.status, json);
    return json;
  }

  function toast(message, kind = 'info') {
    const box = document.getElementById('toasts');
    if (!box) return;
    const el = document.createElement('div');
    el.className = `pointer-events-auto rounded-xl border bg-panel px-5 py-3 text-sm text-white shadow-xl ${
      kind === 'error' ? 'border-red-400/50' : kind === 'warn' ? 'border-amber-400/50' : 'border-edge'}`;
    el.textContent = message;
    box.append(el);
    setTimeout(() => el.remove(), kind === 'info' ? 3500 : 6000);
  }

  window.QB = { api, toast, esc, QBError, csrf };

  // ------------------------------------------------------------------ form/azioni generici delle pagine admin
  function formData(form) {
    const out = {};
    for (const el of form.elements) {
      if (!el.name || el.disabled) continue;
      if (el.type === 'checkbox') out[el.name] = el.checked;
      else out[el.name] = el.value;
    }
    return out;
  }
  function showErrors(form, err) {
    form.querySelectorAll('[data-error-for]').forEach((p) => { p.textContent = err.fields?.[p.dataset.errorFor] || ''; });
    const general = form.querySelector('.form-error');
    if (general) {
      const unmatched = Object.entries(err.fields || {}).filter(([k]) => !form.querySelector(`[data-error-for="${k}"]`)).map(([, v]) => v);
      general.textContent = [err.message, ...unmatched].filter((v, i, a) => v && a.indexOf(v) === i).join(' — ');
    } else toast(err.message, 'error');
  }

  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-api-form]');
    if (!form) return;
    e.preventDefault();
    const btn = form.querySelector('button:not([type="button"])');
    if (btn) btn.disabled = true;
    try {
      const result = await api(form.dataset.method || 'POST', form.dataset.url, formData(form));
      if (form.dataset.redirectField) window.location.href = (form.dataset.redirectPrefix || '') + result[form.dataset.redirectField];
      else window.location.reload();
    } catch (err) {
      showErrors(form, err);
      if (btn) btn.disabled = false;
    }
  });
  document.addEventListener('change', (e) => {
    const form = e.target.closest('form[data-autosubmit]');
    if (form) form.requestSubmit();
    if (e.target.matches('select[data-nav-select]')) window.location.href = e.target.value;
  });
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-api-action]');
    if (btn) {
      if (btn.dataset.confirm && !window.confirm(btn.dataset.confirm)) return;
      btn.disabled = true;
      try {
        await api(btn.dataset.method || 'POST', btn.dataset.url, btn.dataset.body ? JSON.parse(btn.dataset.body) : undefined);
        window.location.reload();
      } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
    }
    const close = e.target.closest('[data-close-dialog]');
    if (close) close.closest('dialog')?.close();
  });
})();
