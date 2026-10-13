import { h } from './dom.js';
import { api, ApiError, state, canAct, isElevated } from './api.js';
import { modal, toast, jsonView, riskBadge, notice, kv } from './components.js';

/** Re-fetch session info (csrf stays; elevation/pending counts refresh). */
export async function refreshSession() {
  const s = await api('/api/session');
  state.session = s;
  document.dispatchEvent(new CustomEvent('mc:session'));
  return s;
}

export function elevateDialog(reason = 'This action needs your password again.') {
  return modal('Confirm it is you', ({ close }) => {
    const pw = h('input', { type: 'password', id: 'el-pw', autocomplete: 'current-password', required: true });
    const err = h('div', { class: 'notice crit', hidden: true, role: 'alert' });
    const form = h('form', { onsubmit: async (e) => {
      e.preventDefault();
      err.hidden = true;
      try { await api('/api/elevate', { method: 'POST', body: { password: pw.value } }); await refreshSession(); toast('Privileged actions unlocked for 10 minutes', 'ok'); close(true); }
      catch (x) { err.textContent = x.message; err.hidden = false; pw.select(); }
    } },
      h('p', null, reason), h('label', { for: 'el-pw' }, 'Your password'), pw, err,
      h('div', { class: 'dlg-foot' }, h('button', { class: 'btn', type: 'button', onclick: () => close(false) }, 'Cancel'), h('button', { class: 'btn primary', type: 'submit' }, 'Unlock for 10 minutes')));
    queueMicrotask(() => pw.focus());
    return { body: form, foot: [] };
  });
}

export async function ensureElevated(reason) {
  if (isElevated()) return true;
  return elevateDialog(reason);
}

/** Show an approval request with preview and (for high risk) the typed confirmation phrase. */
export function approvalDialog(a) {
  return modal('Review before approving', ({ close }) => {
    const input = h('input', { type: 'text', id: 'ap-confirm', autocomplete: 'off', spellcheck: 'false', placeholder: a.confirm_phrase ?? '' });
    const err = h('div', { class: 'notice crit', hidden: true, role: 'alert' });
    const go = h('button', { class: 'btn primary', type: 'button', disabled: a.confirm_phrase ? true : null }, 'Approve and run');
    if (a.confirm_phrase) input.addEventListener('input', () => { go.disabled = input.value.trim() !== a.confirm_phrase; });
    go.addEventListener('click', async () => {
      go.disabled = true; err.hidden = true;
      try {
        if (!isElevated() && !(await elevateDialog('Approving needs your password again.'))) { go.disabled = false; return; }
        const r = await api(`/api/approvals/${a.id}/approve`, { method: 'POST', body: { confirm: input.value.trim() } });
        close(r);
      } catch (x) { err.textContent = x.message; err.hidden = false; go.disabled = false; }
    });
    const reject = h('button', { class: 'btn danger', type: 'button', onclick: async () => { try { close(await api(`/api/approvals/${a.id}/reject`, { method: 'POST', body: {} })); } catch (x) { err.textContent = x.message; err.hidden = false; } } }, 'Reject');
    return {
      body: h('div', { class: 'stack' },
        h('div', { class: 'row' }, riskBadge(a.risk), h('strong', null, a.action), h('span', { class: 'muted' }, `requested by ${a.proposer}${a.proposer_role === 'agent' ? ' (agent)' : ''}`)),
        a.preview?.summary ? h('p', null, h('strong', null, a.preview.summary)) : null,
        a.preview && Object.keys(a.preview).some((k) => k !== 'summary') ? h('div', null, h('p', { class: 'muted' }, 'What will happen'), jsonView(Object.fromEntries(Object.entries(a.preview).filter(([k]) => k !== 'summary')))) : null,
        h('div', null, h('p', { class: 'muted' }, 'Parameters'), jsonView(a.params)),
        a.confirm_phrase ? h('div', null, h('label', { for: 'ap-confirm' }, h('span', null, 'Type ', h('code', null, a.confirm_phrase), ' to approve')), input) : null,
        err),
      foot: [h('button', { class: 'btn', type: 'button', onclick: () => close(undefined) }, 'Not now'), reject, go],
    };
  }, { wide: true });
}

function describeOutcome(o) {
  const tag = o.verified === true ? 'Verified' : o.verified === false ? 'Verification failed' : 'Not independently verified';
  return `${o.detail} (${tag})`;
}

/**
 * The single entry point for state-changing UI. Handles: elevation prompt (medium), queue + review (high),
 * and honest result reporting. Returns the SubmitResult or null.
 */
export async function runAction(action, params, { title, needsElevation = false, quiet = false } = {}) {
  if (!canAct()) { toast('Your account is read-only.', 'warn'); return null; }
  const submit = () => api('/api/actions', { method: 'POST', body: { action, params } });
  let res;
  try {
    try { res = await submit(); }
    catch (e) {
      if (e instanceof ApiError && e.code === 'elevation_required') {
        if (!(await elevateDialog(e.message))) return null;
        res = await submit();
      } else throw e;
    }
  } catch (e) { toast(e.message, 'crit', title ?? 'Action refused'); return null; }

  if (res.status === 'executed') {
    toast(describeOutcome(res.outcome), res.outcome.ok ? (res.outcome.verified === false ? 'warn' : 'ok') : 'crit', title);
    return res;
  }
  // Queued for approval (high risk).
  document.dispatchEvent(new CustomEvent('mc:approvals'));
  toast('Queued for approval. Review it to continue.', 'warn', title ?? 'Needs approval');
  if (!quiet) {
    const out = await approvalDialog(res.approval);
    if (out?.status === 'executed' || out?.status === 'failed') {
      const r = typeof out.result === 'object' && out.result ? out.result : {};
      toast(r.detail ?? out.status, out.status === 'executed' ? 'ok' : 'crit', title);
    } else if (out?.status === 'rejected') toast('Rejected', '');
    document.dispatchEvent(new CustomEvent('mc:approvals'));
  }
  return res;
}
