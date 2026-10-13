// Copy buttons and delete confirmation (inline scripts are blocked by CSP).
document.addEventListener('click', async e => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  await navigator.clipboard.writeText(document.getElementById(btn.dataset.copy).textContent);
  btn.textContent = 'Copied';
  setTimeout(() => (btn.textContent = 'Copy'), 1500);
});

document.addEventListener('change', e => {
  if (e.target.matches('[data-autosubmit]')) e.target.form.submit();
});

// Confirm dialogs; then lock POST buttons so a slow request can't be sent twice.
document.addEventListener('submit', e => {
  const form = e.target;
  const msg = form.dataset.confirm;
  if (msg && !confirm(msg)) return e.preventDefault();
  if (form.method !== 'post') return;
  const btn = form.querySelector('button');
  if (!btn) return;
  btn.disabled = true;
  if (btn.dataset.busy) btn.textContent = btn.dataset.busy;
});

// Back/forward cache can restore a locked button; unlock it.
addEventListener('pageshow', e => {
  if (e.persisted) document.querySelectorAll('button[disabled]').forEach(b => { b.disabled = false; });
});
