import { h } from '../dom.js';
import { api, apiR, canAct, state } from '../api.js';
import { panel, body, pageHead, region, kv, status, badge, notice, jsonView, resultView, empty } from '../components.js';
import { runAction } from '../actions.js';
import { enableNotifications } from '../prefs.js';

export default async function telegram() {
  const view = region(async () => {
    const [tg, mon] = await Promise.all([api('/api/telegram'), api('/api/monitor')]);
    return { cfg: tg.config, check: tg.check, mon };
  }, ({ cfg, check, mon }) => {
    const probe = h('div');
    const doProbe = async (e) => { e.target.disabled = true; probe.replaceChildren(h('p', { class: 'muted' }, 'Probing Telegram through OpenClaw…')); const r = await apiR('/api/openclaw/channels?probe=1').catch((x) => ({ ok: false, error: { message: x.message } })); probe.replaceChildren(resultView(r, (d) => jsonView(d))); e.target.disabled = false; };
    const toggleAlerts = (e) => { const on = e.target.checked; e.target.checked = !on; runAction('monitor.settings', { ...mon.settings, telegramAlerts: on }, { title: 'Alert settings' }).then(() => view.reload()); };
    return h('div', { class: 'stack' },
      h('div', { class: 'grid cols-2' },
        panel('Bot and routing', body(kv([
          ['Status', check ? status(check.status, check.message) : status('unknown', 'Not checked yet')],
          ['Bot', cfg.configured ? (cfg.enabled ? 'Enabled' : 'Disabled in config') : 'Not configured'],
          ['Bot token', cfg.hasToken ? 'Present in config (never shown here)' : 'Missing'],
          ['Owner accounts', cfg.ownerIds.length ? cfg.ownerIds.map((x) => `…${x.slice(-3)}`).join(', ') : 'none'],
          ['Agents answering', cfg.boundAgents.length ? cfg.boundAgents.join(', ') : 'none bound'],
          ['Groups need @mention', cfg.groupsRequireMention === null ? null : cfg.groupsRequireMention ? 'Yes' : 'No'],
        ])), { lead: true, actions: [h('button', { class: 'btn sm', type: 'button', onclick: doProbe }, 'Probe live')] }),
        panel('Alerts', body(h('div', { class: 'stack' },
          h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: mon.settings.telegramAlerts, disabled: canAct() && mon.telegramAlerts.ok ? null : true, onchange: toggleAlerts }), 'Send health alerts to the Telegram owner'),
          mon.telegramAlerts.ok ? null : notice('info', h('b', null, 'Telegram alerts are unavailable. '), mon.telegramAlerts.reason, ' Alerts still appear on the event timeline and as device notifications.'),
          h('p', { class: 'muted' }, 'Alerts fire after consecutive failures and are de-duplicated, with at most ten messages per hour.'),
          h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', disabled: canAct() && mon.telegramAlerts.ok ? null : true, onclick: () => runAction('telegram.test', {}, { title: 'Telegram test' }) }, 'Send a test alert'),
            h('button', { class: 'btn', type: 'button', onclick: enableNotifications }, state.prefs.notifications ? 'Device alerts are on' : 'Turn on device alerts')))))),
      panel('Live channel probe', body(probe, h('p', { class: 'muted' }, 'Select “Probe live” to ask OpenClaw to contact Telegram now.'))));
  }, { rows: 5 });
  return h('div', null, pageHead('Telegram and integrations', 'What OpenClaw has configured for Telegram, whether it answers, and how Mission Control can reach you.'), view);
}
