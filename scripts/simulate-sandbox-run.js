#!/usr/bin/env node
/*
 * simulate-sandbox-run.js
 * ---------------------------------------------------------------------------
 * Offline simulator for n8n-hubspot-goal-quota-vs-actuals-variance-forecast-bot.
 *
 * Zero dependencies and zero network modules: only fs, path and vm are
 * required. Code-node JavaScript is taken verbatim from workflow.json and run
 * in isolated VM contexts by a small engine that follows workflow.json's
 * connections, evaluates IF / HTTP {{ expressions }}, emulates HTTP pagination
 * (body and query-string cursors) and n8n workflow static data. HTTP nodes are
 * routed to in-memory HubSpot / Slack / Teams mocks; the HubSpot mock really
 * evaluates the search filters, so a wrong search body fails the tests.
 *
 * Verifies: structure and static safety, safe defaults, config validation,
 * fiscal-quarter derivation, webhook auth, destination allowlisting, fixture
 * parity, exact money parsing, every pacing scenario against an independent
 * reference model, all policy options (business days, holidays, stage maps,
 * past-due weighting, thresholds, scope, quota sources), data-quality guards,
 * Slack Block Kit and Teams Adaptive Card validity and escaping, live search
 * pagination and fail-closed limits, posting, duplicate-post protection,
 * week-over-week snapshots, and the hygiene-flag CRM write.
 *
 * Usage:  node scripts/simulate-sandbox-run.js [--quiet]
 * Exit:   0 when every check passes, 1 otherwise.
 * Output: sim-output/ (git-ignored): Slack + Teams payload previews, reports.
 * ---------------------------------------------------------------------------
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

globalThis.fetch = () => { throw new Error('Network access is not allowed in the simulator'); };

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, 'workflow.json');
const FIXTURE_PATH = path.join(ROOT, 'sample-payloads', 'quota-variance-fixture.json');
const OUT_DIR = path.join(ROOT, 'sim-output');
const QUIET = process.argv.includes('--quiet');
const workflow = JSON.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
const byName = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

let passed = 0, failed = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { passed++; if (!QUIET) console.log(`  ✔ ${label}`); }
  else { failed++; failures.push(label + (detail ? ` -- ${detail}` : '')); console.log(`  ✘ ${label}${detail ? `\n      ${detail}` : ''}`); }
}
const section = (t) => { if (!QUIET) console.log(`\n▶ ${t}`); };

// ===================================================================== mocks
const TOKENS = {
  HUBSPOT_ACCESS_TOKEN: 'sim-placeholder-hubspot-token',
  WEBHOOK_SHARED_SECRET: 'sim-placeholder-webhook-secret-0123456789',
  SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/TSIM00000/BSIM00000/simplaceholdersecretvalue',
  TEAMS_WEBHOOK_URL: 'https://prod-00.simregion.logic.azure.com/workflows/simplaceholder/triggers/manual/paths/invoke?sig=simplaceholdersig',
};
class HttpError extends Error { constructor(status, message) { super(`${status} - ${message}`); this.status = status; } }
const toMs = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(s + 'T00:00:00Z');
  if (/^\d{12,14}$/.test(s)) return Number(s);
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
};
function matches(rec, f) {
  const v = rec.properties[f.propertyName];
  if (f.operator === 'EQ') return String(v ?? '') === String(f.value);
  if (f.operator === 'IN') return f.values.map(String).includes(String(v ?? ''));
  const a = toMs(v), b = Number(f.value);
  if (a === null) return false;
  if (f.operator === 'GTE') return a >= b;
  if (f.operator === 'GT') return a > b;
  if (f.operator === 'LT') return a < b;
  throw new HttpError(400, `mock: unsupported operator ${f.operator}`);
}
function makeMocks(opts = {}) {
  const state = { calls: [], posts: [], stamped: {} };
  const deals = clone(opts.deals || [...fixture.closedWonDeals, ...fixture.openDeals]);
  const goals = clone(opts.goals || fixture.goalTargets);
  const owners = clone(opts.owners || fixture.owners);
  function search(records, body, label) {
    if (opts.failSearch === label) throw new HttpError(500, `${label} search unavailable`);
    if (body.limit > 200) throw new HttpError(400, 'limit > 200');
    const all = records.map((r) => ({ ...r, properties: { ...r.properties, ...(state.stamped[r.id] || {}) } }))
      .filter((r) => body.filterGroups.some((g) => g.filters.every((f) => matches(r, f)))).sort((a, b) => Number(a.id) - Number(b.id));
    const start = Number(body.after || 0);
    if (start >= 10000) throw new HttpError(400, 'cannot page beyond 10,000');
    const page = all.slice(start, start + body.limit).map((r) => ({ id: r.id, properties: Object.fromEntries(body.properties.map((k) => [k, r.properties[k] ?? null])) }));
    const more = opts.endlessPaging === label || start + body.limit < all.length;
    return { total: opts.fakeTotal && opts.fakeTotal[label] ? opts.fakeTotal[label] : all.length, results: page, ...(more ? { paging: { next: { after: String(start + body.limit) } } } : {}) };
  }
  function handle({ method, url, headers, body, node }) {
    const u = new URL(url);
    state.calls.push({ node, method, host: u.host, path: u.pathname, query: u.search, body: clone(body) });
    if (u.host === 'hooks.slack.com') {
      if (opts.failSlack) throw new HttpError(404, 'no_service');
      if (url !== TOKENS.SLACK_WEBHOOK_URL) throw new HttpError(403, 'wrong slack webhook');
      state.posts.push({ channel: 'slack', body: clone(body) });
      return { data: 'ok' };
    }
    if (u.host.endsWith('.logic.azure.com')) {
      if (url !== TOKENS.TEAMS_WEBHOOK_URL) throw new HttpError(401, 'bad sig');
      if (!body || body.type !== 'message' || body.attachments[0].contentType !== 'application/vnd.microsoft.card.adaptive') throw new HttpError(400, 'Workflows expects an Adaptive Card message');
      state.posts.push({ channel: 'teams', body: clone(body) });
      return {};
    }
    if (u.host !== 'api.hubapi.com') throw new HttpError(502, 'unmocked host ' + u.host);
    if (headers.Authorization !== `Bearer ${TOKENS.HUBSPOT_ACCESS_TOKEN}`) throw new HttpError(401, 'bad token');
    if (method === 'POST' && u.pathname === '/crm/v3/objects/goal_targets/search') return search(goals, body, 'goals');
    if (method === 'POST' && u.pathname === '/crm/v3/objects/deals/search') return search(deals, body, body.filterGroups[0].filters[0].propertyName === 'hs_is_closed_won' ? 'won' : 'open');
    if (method === 'GET' && u.pathname === '/crm/v3/owners') {
      if (opts.failOwners) throw new HttpError(403, 'MISSING_SCOPES crm.objects.owners.read');
      const start = Number(u.searchParams.get('after') || 0);
      const size = 3;
      return { results: owners.slice(start, start + size), ...(start + size < owners.length ? { paging: { next: { after: String(start + size) } } } : {}) };
    }
    if (method === 'POST' && u.pathname === '/crm/v3/objects/deals/batch/update') {
      for (const i of body.inputs) state.stamped[i.id] = { ...(state.stamped[i.id] || {}), ...i.properties };
      return { status: 'COMPLETE', results: body.inputs.map((i) => ({ id: i.id, properties: i.properties })) };
    }
    throw new HttpError(404, `unmocked route ${method} ${u.pathname}`);
  }
  return { state, handle };
}

// ==================================================================== engine
function evalExpr(template, ctx) {
  if (typeof template !== 'string' || !template.startsWith('=')) return template;
  const t = template.slice(1);
  const run = (expr) => vm.runInNewContext(`(${expr})`, { ...ctx, encodeURIComponent, JSON, String, Object, Number }, { timeout: 2000 });
  const single = t.match(/^\{\{([\s\S]*)\}\}$/);
  if (single && !single[1].includes('}}')) return run(single[1]);
  return t.replace(/\{\{([\s\S]*?)\}\}/g, (_, e) => { const v = run(e); return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); });
}
function runWorkflow({ trigger = 'manual', webhookItem, env = {}, mocks, staticData = {} }) {
  const runData = {};
  const envProxy = new Proxy({}, { get(_t, k) { if (env === 'BLOCKED') throw new Error('access to env vars denied'); return typeof k === 'string' ? env[k] : undefined; } });
  const accessor = (name) => {
    const runs = runData[name];
    if (!runs || !runs.length) throw new Error(`Referenced node "${name}" has not executed`);
    const items = (runs[runs.length - 1][0] || []).map(clone);
    return { first: () => items[0], last: () => items[items.length - 1], all: () => items, item: items[0] };
  };
  const ctxFor = (item) => ({ $json: clone(item.json), $: accessor, $env: envProxy });
  function exec(name, items) {
    const node = byName[name];
    let outputs;
    switch (node.type) {
      case 'n8n-nodes-base.manualTrigger': case 'n8n-nodes-base.webhook': case 'n8n-nodes-base.scheduleTrigger':
        outputs = [items]; break;
      case 'n8n-nodes-base.code': {
        const sandbox = {
          $input: { first: () => clone(items[0]), all: () => items.map(clone), item: clone(items[0]) },
          $env: envProxy, $: accessor, $getWorkflowStaticData: () => staticData,
          require: (m) => { throw new Error(`Cannot find module '${m}'`); },
          console: { log() {}, warn() {}, error() {} },
        };
        const res = vm.runInNewContext(`(() => {\n${node.parameters.jsCode}\n})()`, sandbox, { timeout: 20000, filename: `${name}.js` });
        if (!Array.isArray(res)) throw new Error(`Code node "${name}" did not return an array`);
        outputs = [res.map((i) => clone({ json: i.json }))];
        break;
      }
      case 'n8n-nodes-base.if': {
        const t = [], f = [];
        for (const it of items) (evalExpr(node.parameters.conditions.conditions[0].leftValue, ctxFor(it)) === true ? t : f).push(it);
        outputs = [t, f]; break;
      }
      case 'n8n-nodes-base.httpRequest': {
        const out = [];
        const pg = node.parameters.options && node.parameters.options.pagination && node.parameters.options.pagination.pagination;
        for (const it of items) {
          const c = ctxFor(it);
          let url = evalExpr(node.parameters.url, c);
          const headers = Object.fromEntries((node.parameters.headerParameters?.parameters || []).map((h) => [h.name, evalExpr(h.value, c)]));
          let body = node.parameters.sendBody ? JSON.parse(evalExpr(node.parameters.jsonBody, c)) : undefined;
          const send = () => mocks.handle({ method: node.parameters.method || 'GET', url, headers, body, node: name });
          try {
            if (!pg) { out.push({ json: send() }); continue; }
            for (let n = 0; n < pg.maxRequests; n++) {
              const resp = send();
              out.push({ json: resp });
              const rc = { ...c, $response: { body: resp } };
              if (evalExpr(pg.completeExpression, rc) === true) break;
              for (const prm of pg.parameters.parameters) {
                const v = evalExpr(prm.value, rc);
                if (prm.type === 'body') body = { ...body, [prm.name]: v };
                if (prm.type === 'qs') { const uu = new URL(url); uu.searchParams.set(prm.name, v); url = uu.toString(); }
              }
            }
          } catch (e) {
            if (node.onError === 'continueRegularOutput') out.push({ json: { error: { message: e.message, status: e.status } } });
            else throw Object.assign(new Error(`${name}: ${e.message}`), { node: name });
          }
        }
        outputs = [out]; break;
      }
      default: throw new Error(`Engine does not support ${node.type}`);
    }
    (runData[name] = runData[name] || []).push(outputs.map((o) => (o || []).map(clone)));
    const conns = (workflow.connections[name] || {}).main || [];
    outputs.forEach((o, idx) => { if (o && o.length) for (const cn of conns[idx] || []) exec(cn.node, o); });
  }
  let error = null;
  try {
    if (trigger === 'webhook') exec('Forecast Webhook', [{ json: webhookItem }]);
    else if (trigger === 'schedule') exec('Weekly Schedule (Mon 07:47)', [{ json: {} }]);
    else exec('Manual Test Trigger', [{ json: {} }]);
  } catch (e) { error = e; }
  const last = (n) => (runData[n] ? runData[n][runData[n].length - 1][0].map((i) => i.json) : undefined);
  return { runData, error, last, mocks, staticData };
}

// --------------------------------------------------------- reference model
// Independent floating-point model of the documented formulas, used to
// cross-check the workflow's exact BigInt implementation (to the cent).
function reference({ asOf = '2026-11-16', basis = 'calendar', holidays = [], weightPastDue = false, stageWeights = null } = {}) {
  const qs = Date.UTC(2026, 9, 1), qe = Date.UTC(2027, 0, 1), as = Math.min(Date.parse(asOf + 'T00:00:00Z'), qe);
  const days = (a, b) => { let n = 0; for (let t = a; t < b; t += 864e5) { const wd = new Date(t).getUTCDay(); if (basis === 'calendar' || (wd !== 0 && wd !== 6 && !holidays.includes(new Date(t).toISOString().slice(0, 10)))) n++; } return n; };
  const total = days(qs, qe), elapsed = days(qs, as), remaining = total - elapsed;
  const reps = {};
  const r = (id) => (reps[id] = reps[id] || { quota: 0, hasQuota: false, won: 0, weighted: 0 });
  for (const g of fixture.goalTargets) {
    const p = g.properties;
    if (!/quota/i.test(p.hs_goal_name)) continue;
    const s = Date.parse(p.hs_start_datetime), e = Date.parse(p.hs_end_datetime) + 1;
    const ov = Math.min(e, qe) - Math.max(s, qs);
    if (ov <= 0) continue;
    r(p.hubspot_owner_id).quota += Number(p.hs_target_amount) * ov / (e - s);
    r(p.hubspot_owner_id).hasQuota = true;
  }
  for (const d of fixture.closedWonDeals) {
    const p = d.properties, c = Date.parse(p.closedate);
    if (c < qs || c >= qe || !/^\d+$/.test(p.amount_in_home_currency) || !p.hubspot_owner_id) continue;
    r(p.hubspot_owner_id).won += Number(p.amount_in_home_currency);
  }
  for (const d of fixture.openDeals) {
    const p = d.properties;
    const pastDue = Math.floor(Date.parse(p.closedate) / 864e5) < Math.floor(as / 864e5);
    const prob = stageWeights ? stageWeights[p.dealstage] : p.hs_deal_stage_probability === '' ? undefined : Number(p.hs_deal_stage_probability);
    if (prob === undefined || (pastDue && !weightPastDue)) { r(p.hubspot_owner_id); continue; }
    r(p.hubspot_owner_id).weighted += Number(p.amount_in_home_currency) * prob;
  }
  const c2 = (x) => Math.round(x * 100 + 1e-7) / 100;
  for (const v of Object.values(reps)) {
    v.quota = c2(v.quota);
    v.expected = c2(v.quota * elapsed / total);
    v.gap = Math.max(0, c2(v.quota - v.won));
    v.need = remaining ? c2(v.gap * (basis === 'calendar' ? 7 : 5) / remaining) : null;
    v.weighted = c2(v.weighted);
  }
  return { total, elapsed, remaining, reps };
}

// -------------------------------------------------------------- env sets
const NOW = '2026-11-16T08:00:00.000Z';
const LIVE = { SANDBOX_MODE: 'false', HUBSPOT_ACCESS_TOKEN: TOKENS.HUBSPOT_ACCESS_TOKEN, HUBSPOT_PORTAL_ID: '99000001', NOW_OVERRIDE: NOW, WEBHOOK_SHARED_SECRET: TOKENS.WEBHOOK_SHARED_SECRET };
const ARMED = { ...LIVE, DRY_RUN: 'false', NOTIFICATIONS_ENABLED: 'true', NOTIFY_CHANNELS: 'slack,teams', SLACK_WEBHOOK_URL: TOKENS.SLACK_WEBHOOK_URL, TEAMS_WEBHOOK_URL: TOKENS.TEAMS_WEBHOOK_URL, HUBSPOT_MUTATIONS_ENABLED: 'true' };
const SB = (extra = {}, sd = {}) => runWorkflow({ env: { NOW_OVERRIDE: NOW, ...extra }, mocks: makeMocks(), staticData: sd });
const calcOf = (r) => r.last('Variance Calculator')[0];
const repOf = (c, id) => c.reps.find((x) => x.ownerId === id);
const cfgOf = (env, trigger, webhookItem) => { const r = runWorkflow({ env, trigger, webhookItem, mocks: makeMocks() }); return { r, c: r.last('Config & Safety Gate') && r.last('Config & Safety Gate')[0].config }; };
function validateSlack(p) {
  const e = [];
  if (!p.text || !Array.isArray(p.blocks) || p.blocks.length > 50) e.push('text/blocks');
  for (const [i, b] of p.blocks.entries()) {
    if (b.type === 'header' && b.text.text.length > 150) e.push(`#${i} header`);
    if (b.type === 'section' && b.text && b.text.text.length > 3000) e.push(`#${i} text`);
    if (b.type === 'section' && b.fields && (b.fields.length > 10 || b.fields.some((f) => f.text.length > 2000))) e.push(`#${i} fields`);
    if (b.type === 'context' && b.elements.some((x) => x.text.length > 3000)) e.push(`#${i} context`);
  }
  return e;
}

// ====================================================================== main
(function main() {
  console.log('n8n-hubspot-goal-quota-vs-actuals-variance-forecast-bot :: offline simulator');
  console.log(`workflow: workflow.json (${workflow.nodes.length} nodes)`);
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // ----------------------------------------------------------- 1. structure
  section('1. Workflow structure and static safety checks');
  const names = workflow.nodes.map((n) => n.name);
  check('Node names are unique', new Set(names).size === names.length);
  check('Workflow is inactive on import', workflow.active === false);
  const bad = [];
  for (const [s, c] of Object.entries(workflow.connections)) { if (!byName[s]) bad.push(s); for (const b of c.main || []) for (const x of b) if (!byName[x.node]) bad.push(`${s}->${x.node}`); }
  check('All connections reference existing nodes', bad.length === 0, bad.join(', '));
  const ifs = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.if');
  check(`All ${ifs.length} IF nodes wire both outputs`, ifs.every((n) => (workflow.connections[n.name]?.main || []).length === 2 && workflow.connections[n.name].main.every((b) => b.length)));
  const reach = new Set();
  const walk = (n) => { if (reach.has(n)) return; reach.add(n); for (const b of workflow.connections[n]?.main || []) for (const c of b) walk(c.node); };
  ['Manual Test Trigger', 'Forecast Webhook', 'Weekly Schedule (Mon 07:47)'].forEach(walk);
  const unreach = workflow.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote' && !reach.has(n.name)).map((n) => n.name);
  check('Every functional node is reachable from a trigger', unreach.length === 0, unreach.join(', '));
  check('Manual, webhook (POST, immediate response) and weekly schedule triggers exist', byName['Forecast Webhook'].parameters.httpMethod === 'POST' && byName['Forecast Webhook'].parameters.responseMode === 'onReceived' && byName['Weekly Schedule (Mon 07:47)'].parameters.rule.interval[0].expression === '47 7 * * 1');
  const http = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest');
  const hs = http.filter((n) => n.name !== 'Post Slack / Teams Update');
  check(`${hs.length} HubSpot HTTP nodes authenticate only via {{ $env.HUBSPOT_ACCESS_TOKEN }}`, hs.every((n) => (n.parameters.headerParameters.parameters.find((h) => h.name === 'Authorization') || {}).value === '=Bearer {{ $env.HUBSPOT_ACCESS_TOKEN }}'));
  const post = byName['Post Slack / Teams Update'];
  check('Notification URL comes only from $env (never item data); no auto-retry', post.parameters.url === "={{ $json.channel === 'teams' ? $env.TEAMS_WEBHOOK_URL : $env.SLACK_WEBHOOK_URL }}" && !post.retryOnFail);
  check('No stored n8n credentials', workflow.nodes.every((n) => !n.credentials));
  const codeSrc = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.code').map((n) => [n.name, n.parameters.jsCode]);
  const writers = codeSrc.filter(([, s]) => /batch\/(update|create|upsert|archive)/.test(s)).map(([n]) => n);
  check('Only "Build Hygiene Stamp Batches" builds a CRM write request', writers.length === 1 && writers[0] === 'Build Hygiene Stamp Batches', writers.join(', '));
  check('The three searches stop the run on error (no continue-on-fail)', ['HubSpot: Search Goal Targets', 'HubSpot: Search Closed-Won Deals', 'HubSpot: Search Open Pipeline'].every((n) => !byName[n].onError));
  const raw = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const PAT = [[/pat-(na|eu|ap)\d?-[0-9a-f-]{20,}/i, 'HubSpot token'], [/xox[abposr]-[A-Za-z0-9-]{10,}/, 'Slack token'], [/hooks\.slack\.com\/services\/T[A-Z0-9]+\//, 'Slack webhook URL'], [/logic\.azure\.com\/workflows\//, 'Teams workflow URL'], [/sig=[A-Za-z0-9%_-]{20,}/, 'signed URL'], [/sk-[A-Za-z0-9]{20,}/, 'API key'], [/Bearer [A-Za-z0-9\-_.]{16,}/, 'literal bearer'], [/\b\d{3}-\d{2}-\d{4}\b/, 'SSN-like'], [/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/, 'IBAN-like']];
  const texts = { 'workflow.json': raw };
  for (const f of ['README.md', 'DISCLAIMER.md', '.env.example', 'sample-payloads/quota-variance-fixture.json']) if (fs.existsSync(path.join(ROOT, f))) texts[f] = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const hits = [];
  for (const [f, t] of Object.entries(texts)) for (const [re, l] of PAT) if (re.test(t)) hits.push(`${l} in ${f}`);
  check('No tokens, webhook URLs, signed URLs, SSN / IBAN data in shipped files', hits.length === 0, hits.join(', '));
  const emails = [...new Set((raw + texts['sample-payloads/quota-variance-fixture.json']).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])];
  check('Every email in workflow / fixture uses example.com', emails.length > 0 && emails.every((e) => /@example\.com$/i.test(e)), emails.join(','));
  const exprErr = [];
  const visit = (v, w) => { if (typeof v === 'string' && v.startsWith('=')) for (const m of v.matchAll(/\{\{([\s\S]*?)\}\}/g)) { try { new Function('$json', '$', '$env', '$response', `return (${m[1]});`); } catch (e) { exprErr.push(`${w}: ${e.message}`); } } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, `${w}.${k}`); };
  workflow.nodes.forEach((n) => visit(n.parameters, n.name));
  check('Every {{ expression }} parses as JavaScript', exprErr.length === 0, exprErr.join('; '));
  const cErr = [];
  for (const [n, s] of codeSrc) { try { new vm.Script(`(() => {\n${s}\n})`); } catch (e) { cErr.push(`${n}: ${e.message}`); } }
  check('Every Code node compiles', cErr.length === 0, cErr.join('; '));
  check('Code nodes call no require() (no network, fs or crypto modules)', codeSrc.every(([, s]) => !/\brequire\s*\(/.test(s)));

  // ------------------------------------------------------ 2. config & quarter
  section('2. Safe defaults, config validation and fiscal quarters');
  const { c: d0 } = cfgOf({ NOW_OVERRIDE: NOW });
  check('Empty env -> SANDBOX_MODE and DRY_RUN on, notifications and CRM writes blocked', d0.sandboxMode && d0.dryRun && !d0.notify.allowedByConfig && !d0.hubspot.stampAllowed);
  check('Defaults: quotas from HubSpot goals, HubSpot probability, calendar pacing, past-due not weighted', d0.quota.source === 'hubspot_goals' && d0.pipeline.probabilitySource === 'hubspot' && d0.pacing.basis === 'calendar' && !d0.pipeline.weightPastDue);
  check('Default quarter for 2026-11-16 (FY starts Jan) is 2026-Q4, 2026-10-01 .. 2027-01-01', d0.quarter.id === '2026-Q4' && d0.quarter.startIso === '2026-10-01' && d0.quarter.endIsoExclusive === '2027-01-01');
  const fq = (fy, asOf) => cfgOf({ NOW_OVERRIDE: '2027-06-30T00:00:00Z', FISCAL_YEAR_START_MONTH: String(fy), AS_OF_DATE: asOf }).c.quarter;
  const f1 = fq(2, '2027-01-10'), f2 = fq(4, '2026-05-20'), f3 = fq(7, '2026-11-16');
  check('FY starting Feb: 2027-01-10 -> FY2027-Q4 (2026-11-01 .. 2027-02-01)', f1.id === 'FY2027-Q4' && f1.startIso === '2026-11-01' && f1.endIsoExclusive === '2027-02-01', JSON.stringify(f1));
  check('FY starting Apr: 2026-05-20 -> FY2027-Q1 (starts 2026-04-01)', f2.id === 'FY2027-Q1' && f2.startIso === '2026-04-01', JSON.stringify(f2));
  check('FY starting Jul: 2026-11-16 -> FY2027-Q2 (starts 2026-10-01)', f3.id === 'FY2027-Q2' && f3.startIso === '2026-10-01', JSON.stringify(f3));
  const bad1 = runWorkflow({ env: { NOW_OVERRIDE: NOW, QUARTER_START_DATE: '2026-11-01' }, mocks: makeMocks() });
  check('QUARTER_START_DATE that is not a fiscal-quarter start is refused', bad1.error && /not the first day of a fiscal quarter/.test(bad1.error.message));
  const bad2 = runWorkflow({ env: { NOW_OVERRIDE: NOW, AS_OF_DATE: '2026-11-30' }, mocks: makeMocks() });
  check('A future as-of date is refused', bad2.error && /in the future/.test(bad2.error.message));
  const bad3 = runWorkflow({ env: { NOW_OVERRIDE: NOW, AS_OF_DATE: '2026-09-30', QUARTER_START_DATE: '2026-10-01' }, mocks: makeMocks() });
  check('An as-of date before the quarter starts is refused', bad3.error && /before the start/.test(bad3.error.message));
  const bad4 = runWorkflow({ env: { NOW_OVERRIDE: NOW, AS_OF_DATE: '2026-02-30' }, mocks: makeMocks() });
  check('An impossible as-of date (2026-02-30) is refused', bad4.error && /Invalid as-of/.test(bad4.error.message));
  const { c: closed } = cfgOf({ NOW_OVERRIDE: '2027-01-04T08:00:00Z', QUARTER_START_DATE: '2026-10-01' });
  check('As-of after quarter end -> final (closed-quarter) report with a warning', closed.quarter.closed && closed.warnings.some((w) => /final/.test(w)));
  const { c: typo } = cfgOf({ NOW_OVERRIDE: NOW, SANDBOX_MODE: 'flase', DRY_RUN: 'nah', NOTIFICATIONS_ENABLED: 'please' });
  check('Typos keep SANDBOX / DRY_RUN on and do not arm notifications', typo.sandboxMode && typo.dryRun && !typo.notify.enabled);
  const { c: blk } = cfgOf('BLOCKED');
  check('Blocked $env -> all safe defaults', blk.envBlocked && blk.sandboxMode && !blk.notify.allowedByConfig);
  const { c: evil } = cfgOf({ ...ARMED, SLACK_WEBHOOK_URL: 'https://hooks.slack.com.attacker.example/services/x', NOTIFY_CHANNELS: 'slack' });
  check('Slack URL on a non-allowlisted host is refused', !evil.notify.allowedByConfig && evil.notify.blockers.some((b) => /not in NOTIFY_ALLOWED_HOST_SUFFIXES/.test(b)));
  const { c: plain } = cfgOf({ ...ARMED, TEAMS_WEBHOOK_URL: 'http://prod-00.simregion.logic.azure.com/x', NOTIFY_CHANNELS: 'teams' });
  check('Teams URL over plain http is refused', !plain.notify.allowedByConfig && plain.notify.blockers.some((b) => /https/.test(b)));
  const { c: noUrl } = cfgOf({ ...ARMED, NOTIFY_CHANNELS: 'teams', TEAMS_WEBHOOK_URL: '' });
  check('Selected channel without a URL is refused', noUrl.notify.blockers.some((b) => /TEAMS_WEBHOOK_URL is not set/.test(b)));
  const { c: inv } = cfgOf({ NOW_OVERRIDE: NOW, PACING_AHEAD_THRESHOLD: '0.8', PACING_ON_TRACK_THRESHOLD: '0.9', PROBABILITY_SOURCE: 'stage_map', STAGE_WEIGHTS: 'x:2', BUSINESS_HOLIDAYS: '2026-13-01' });
  check('Inverted thresholds, bad stage weights and bad holidays become config errors', inv.configErrors.length >= 4, JSON.stringify(inv.configErrors));
  const { c: userinfo } = cfgOf({ ...ARMED, NOTIFY_CHANNELS: 'slack', SLACK_WEBHOOK_URL: 'https://hooks.slack.com@attacker.example/services/x' });
  check('URL with embedded credentials / userinfo trick is refused', !userinfo.notify.allowedByConfig);
  const { c: envq } = cfgOf({ ...LIVE, QUOTA_SOURCE: 'env' });
  check('QUOTA_SOURCE=env without QUOTA_MAP is a config error in live mode', envq.configErrors.some((e) => /QUOTA_MAP/.test(e)));
  const { r: secretRun } = cfgOf(ARMED);
  check('Config output never contains a token or webhook URL', Object.values(TOKENS).every((s) => !JSON.stringify(secretRun.runData['Config & Safety Gate']).includes(s)));

  // ----------------------------------------------------- 3. live refusals
  section('3. Live-mode refusals and webhook authentication');
  const r1 = runWorkflow({ env: { SANDBOX_MODE: 'false', HUBSPOT_PORTAL_ID: '99000001' }, mocks: makeMocks() });
  check('Live without HUBSPOT_ACCESS_TOKEN is refused', r1.error && /HUBSPOT_ACCESS_TOKEN/.test(r1.error.message));
  const wm = makeMocks();
  const r2 = runWorkflow({ trigger: 'webhook', webhookItem: { headers: {}, query: {}, body: {} }, env: LIVE, mocks: wm });
  check('Live webhook without secret is rejected before any API call', r2.error && /Webhook rejected/.test(r2.error.message) && wm.state.calls.length === 0);
  const r3 = runWorkflow({ trigger: 'webhook', webhookItem: { headers: { 'X-Forecast-Secret': TOKENS.WEBHOOK_SHARED_SECRET }, query: {}, body: { as_of: '2026-11-09' } }, env: LIVE, mocks: makeMocks() });
  check('Valid webhook sets as_of from the body; secret never copied past the trigger node', !r3.error && r3.last('Config & Safety Gate')[0].config.asOf.iso === '2026-11-09' && Object.entries(r3.runData).filter(([n]) => n !== 'Forecast Webhook').every(([, v]) => !JSON.stringify(v).includes(TOKENS.WEBHOOK_SHARED_SECRET)));
  const r4 = runWorkflow({ trigger: 'schedule', env: { NOW_OVERRIDE: NOW }, mocks: makeMocks() });
  check('Weekly schedule trigger runs (sandbox)', !r4.error && r4.last('Forecast Run Report')[0].quarter === '2026-Q4');

  // ---------------------------------------------------- 4. fixture parity
  section('4. Fixture parity and synthetic-data hygiene');
  const emb = byName['Load Synthetic Quota Fixture'].parameters.jsCode.match(/const FIXTURE = ([\s\S]*?);\n\nreturn/);
  let parity = false;
  try { parity = JSON.stringify(JSON.parse(emb[1])) === JSON.stringify(fixture); } catch (e) { parity = false; }
  check('Fixture embedded in workflow.json equals sample-payloads/quota-variance-fixture.json', parity);
  check('Fixture flagged synthetic, portal 99000001, owner names marked (Mock)', fixture._meta.synthetic && fixture.portalId === '99000001' && fixture.owners.every((o) => /\(Mock\)$/.test(o.lastName)));

  // ---------------------------------------------------------- 5. helpers
  section('5. Exact money and probability parsing');
  const src = byName['Variance Calculator'].parameters.jsCode;
  const grab = (name) => { const s = src.indexOf(`function ${name}(`); let depth = 0; for (let i = src.indexOf('{', s); i < src.length; i++) { if (src[i] === '{') depth++; if (src[i] === '}' && --depth === 0) return src.slice(s, i + 1); } return ''; };
  const ux = {};
  vm.runInNewContext(`const dp = 2; const pow10 = (n) => 10n ** BigInt(n); const roundDiv = (num, den) => (num * 2n + den) / (den * 2n);\n${grab('parseMoney')}\n${grab('frac')}\n${grab('parseProbability')}\n${grab('parseInstant')}\nthis.pm = parseMoney; this.pp = parseProbability; this.pi = parseInstant;`, ux);
  const pm = (s) => { const r = ux.pm(s); return r.ok ? r.minor.toString() : r.empty ? 'EMPTY' : 'INVALID'; };
  for (const [s, w] of [['120000', '12000000'], ['1,234.56', '123456'], ['0.005', '1'], ['2.675', '268'], ['N/A', 'INVALID'], ['1.2e5', 'INVALID'], ['-100', 'INVALID'], ['9.500,00', 'INVALID'], ['', 'EMPTY']]) check(`parseMoney(${JSON.stringify(s)}) -> ${w}`, pm(s) === w, pm(s));
  check('parseProbability accepts 0..1, rejects > 1, text and blanks', ux.pp('0.6') && ux.pp('1') && ux.pp('0') && !ux.pp('1.2') && !ux.pp('60%') && !ux.pp(''));
  check('parseInstant accepts ISO, date-only and epoch ms; rejects garbage', ux.pi('2026-10-14T16:00:00.000Z') === Date.UTC(2026, 9, 14, 16) && ux.pi('2026-10-14') === Date.UTC(2026, 9, 14) && ux.pi('1791000000000') === 1791000000000 && ux.pi('next week') === null);

  // ------------------------------------------------- 6. sandbox end-to-end
  section('6. Sandbox end-to-end: every pacing scenario');
  const sb = SB();
  check('Sandbox run completes', !sb.error, sb.error && sb.error.message);
  check('Sandbox run makes ZERO HTTP calls (nothing fetched, posted or written)', sb.mocks.state.calls.length === 0);
  const c = calcOf(sb);
  const ref = reference();
  check('Pacing: 46 of 92 calendar days elapsed (50.0%)', c.pacing.elapsedDays === 46 && c.pacing.totalDays === 92 && c.pacing.elapsedPct === '50.0' && ref.elapsed === 46);
  const expected = { 99100001: 'AHEAD', 99100002: 'ON_TRACK', 99100003: 'AT_RISK', 99100004: 'CRITICAL', 99100005: 'QUOTA_MET', 99100006: 'NO_QUOTA', 99100007: 'CRITICAL' };
  const got = Object.fromEntries(c.reps.map((r) => [r.ownerId, r.status]));
  check('Rep statuses match all 7 fixture expectations', JSON.stringify(Object.fromEntries(Object.entries(got).sort())) === JSON.stringify(expected), JSON.stringify(got));
  for (const [id, rr] of Object.entries(ref.reps)) {
    const r = repOf(c, id);
    if (!rr.hasQuota) { check(`${id}: no quota -> NO_QUOTA, won ${rr.won}`, r.status === 'NO_QUOTA' && Number(r.won) === rr.won); continue; }
    check(`${id}: quota ${rr.quota}, won ${rr.won}, expected ${rr.expected}, weighted ${rr.weighted}, need/wk ${rr.need} match the reference`,
      Number(r.quota) === rr.quota && Number(r.won) === rr.won && Number(r.expectedToDate) === rr.expected && Number(r.weighted) === rr.weighted && Number(r.gapToQuota) === rr.gap && (rr.gap === 0 ? r.requiredWeeklyRunRate === '0.00' : Number(r.requiredWeeklyRunRate) === rr.need),
      JSON.stringify({ q: r.quota, w: r.won, e: r.expectedToDate, wt: r.weighted, need: r.requiredWeeklyRunRate }));
  }
  check('Monthly goals summed (3 x 100k); other-quarter and non-quota goals ignored', repOf(c, '99100001').quota === '300000.00' && repOf(c, '99100001').quotaParts.length === 3);
  check('Annual goal prorated 92/365 and flagged', repOf(c, '99100007').quota === '120986.30' && repOf(c, '99100007').flags.includes('QUOTA_PRORATED'));
  check('Projection escalation: pacing 82.7% but projected 41.3% -> CRITICAL', repOf(c, '99100007').pacingPct === '82.7' && repOf(c, '99100007').criticalReason === 'PROJECTED_ATTAINMENT_BELOW_THRESHOLD');
  check('Zero weighted pipeline edge case flagged (Morgan)', repOf(c, '99100004').flags.includes('ZERO_PIPELINE') && repOf(c, '99100004').coverage === '0.00' && repOf(c, '99100004').runRateMultiple === '5.00');
  check('Past-due open deal excluded from weighting and flagged (Riley)', repOf(c, '99100003').weighted === '100000.00' && repOf(c, '99100003').pastDue === '40000.00' && repOf(c, '99100003').flags.includes('PAST_DUE_PIPELINE'));
  check('Quota met: no gap, required run rate 0, coverage n/a', repOf(c, '99100005').gapToQuota === '0.00' && repOf(c, '99100005').coverage === null);
  check('Severity ordering: CRITICAL first, QUOTA_MET last', c.reps[0].status === 'CRITICAL' && c.reps[c.reps.length - 1].status === 'QUOTA_MET');
  const sumWon = c.reps.reduce((s, r) => s + Number(r.won), 0) + Number(c.team.unassignedWon);
  check('Team actuals = sum of reps + unassigned (675,000); team quota = sum of quotas', Number(c.team.won) === 675000 && sumWon === 675000 && Number(c.team.quota) === c.reps.reduce((s, r) => s + Number(r.quota || 0), 0));
  check('Invalid-amount deal excluded and counted; prior-quarter deal ignored', c.dataQuality.invalidDeals === 1 && c.dataQuality.outOfQuarterIgnored === 1 && repOf(c, '99100002').flags.includes('INVALID_DEAL_AMOUNT'));
  check('Hygiene list: missing owner, invalid amount, past-due close date, missing probability', JSON.stringify(c.hygiene.map((h) => h.issues[0]).sort()) === JSON.stringify(['INVALID_AMOUNT', 'MISSING_OWNER', 'MISSING_PROBABILITY', 'PAST_DUE_CLOSE_DATE']));
  check('Week-over-week deltas against the 2026-11-09 snapshot', c.previousSnapshotAsOf === '2026-11-09' && repOf(c, '99100001').wow.won === '90000.00' && c.team.wow.won === '200000.00');
  check('Guards pass on fixture data (5.3% invalid < 10%)', c.guards.passed && c.dataQuality.invalidPct === '5.3');
  const nb = sb.last('Notification Builder')[0];
  check('Notification blocked in sandbox with reasons; report DRY_RUN', !nb.notifyAllowed && nb.notifyBlockers.some((b) => b.startsWith('SANDBOX_MODE')) && sb.last('Forecast Run Report')[0].status === 'DRY_RUN');
  check('Slack Block Kit payload within limits', validateSlack(nb.slackPayload).length === 0, validateSlack(nb.slackPayload).join(';'));
  const tp = nb.teamsPayload;
  check('Teams payload is a Workflows message with an Adaptive Card 1.4 attachment (< 28 KB)', tp.type === 'message' && tp.attachments[0].contentType === 'application/vnd.microsoft.card.adaptive' && tp.attachments[0].content.version === '1.4' && JSON.stringify(tp).length < 28000);
  check('Messages are labelled [SANDBOX] and carry no email addresses', nb.slackPayload.blocks[0].text.text.includes('[SANDBOX]') && !/@example\.com/.test(JSON.stringify([nb.slackPayload, tp])));
  fs.writeFileSync(path.join(OUT_DIR, 'slack-blocks.json'), JSON.stringify({ blocks: nb.slackPayload.blocks }, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'teams-adaptive-card.json'), JSON.stringify(tp.attachments[0].content, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'text-preview.txt'), nb.textPreview + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'sandbox-report.json'), JSON.stringify(sb.last('Forecast Run Report')[0], null, 2) + '\n');

  // ---------------------------------------------------------- 7. policies
  section('7. Pacing basis, probability source, scope, thresholds and guards');
  const bz = calcOf(SB({ PACING_BASIS: 'business', BUSINESS_HOLIDAYS: '2026-11-26,2026-12-25' }));
  const bref = reference({ basis: 'business', holidays: ['2026-11-26', '2026-12-25'] });
  check(`Business-day pacing with holidays: ${bref.elapsed}/${bref.total} days, Riley need/wk matches reference`, bz.pacing.elapsedDays === bref.elapsed && bz.pacing.totalDays === bref.total && Number(repOf(bz, '99100003').requiredWeeklyRunRate) === bref.reps['99100003'].need, `${bz.pacing.elapsedDays}/${bz.pacing.totalDays}`);
  const SW = { presentationscheduled: 0.6, qualifiedtobuy: 0.4, decisionmakerboughtin: 0.8, contractsent: 0.9, appointmentscheduled: 0.2, 99300001: 0.3 };
  const sm = calcOf(SB({ PROBABILITY_SOURCE: 'stage_map', STAGE_WEIGHTS: Object.entries(SW).map(([k, v]) => `${k}:${v}`).join(',') }));
  const smRef = reference({ stageWeights: SW });
  check('Stage-map weighting matches the reference (Riley 200k x 0.3; Quinn now weighted)', Number(repOf(sm, '99100003').weighted) === smRef.reps['99100003'].weighted && Number(repOf(sm, '99100007').weighted) === smRef.reps['99100007'].weighted && !repOf(sm, '99100007').flags.includes('MISSING_PROBABILITY'));
  const wp = calcOf(SB({ WEIGHT_PAST_DUE_PIPELINE: 'true' }));
  check('WEIGHT_PAST_DUE_PIPELINE=true adds the past-due 40k x 0.9', repOf(wp, '99100003').weighted === '136000.00');
  const early = calcOf(SB({ AS_OF_DATE: '2026-10-05' }));
  check('Early quarter (4/92 days < 10%) -> EARLY_QUARTER instead of a pacing verdict', early.pacing.early && repOf(early, '99100004').status === 'EARLY_QUARTER');
  const fin = calcOf(runWorkflow({ env: { NOW_OVERRIDE: '2027-01-04T08:00:00Z', QUARTER_START_DATE: '2026-10-01' }, mocks: makeMocks() }));
  check('Closed quarter: 100% elapsed, no remaining run rate', fin.pacing.elapsedDays === 92 && fin.pacing.remainingDays === 0 && repOf(fin, '99100004').requiredWeeklyRunRate === null);
  const th = calcOf(SB({ PACING_AHEAD_THRESHOLD: '1.5', PACING_AT_RISK_THRESHOLD: '0.85' }));
  check('Thresholds are configurable (Avery 140% no longer AHEAD; Riley 80% now CRITICAL)', repOf(th, '99100001').status === 'ON_TRACK' && repOf(th, '99100003').status === 'CRITICAL');
  const exact = calcOf(SB({ PACING_ON_TRACK_THRESHOLD: '1.0' }));
  check('Exact boundary: pacing exactly 100.0% meets ON_TRACK threshold 1.0 (no float drift)', repOf(exact, '99100002').status === 'ON_TRACK');
  const qm = calcOf(SB({ QUOTA_SOURCE: 'env', QUOTA_MAP: '99100001:250000,99100006:50000' }));
  check('QUOTA_MAP overrides goals: Taylor gets a quota, others become NO_QUOTA', repOf(qm, '99100006').quota === '50000.00' && repOf(qm, '99100002').status === 'NO_QUOTA');
  const sc = calcOf(SB({ INCLUDED_OWNER_IDS: '99100001,99100002' }));
  check('INCLUDED_OWNER_IDS scopes the team to listed reps (+ unassigned revenue)', sc.reps.length === 2 && sc.team.won === '335000.00');
  const ex = calcOf(SB({ EXCLUDED_OWNER_IDS: '99100004' }));
  check('EXCLUDED_OWNER_IDS removes a rep', !repOf(ex, '99100004') && ex.reps.length === 6);
  const gq = calcOf(SB({ MAX_INVALID_RECORD_PCT: '1' }));
  check('Data-quality guard: invalid ratio above MAX_INVALID_RECORD_PCT blocks posting', !gq.guards.passed && gq.guards.failures.some((f) => /MAX_INVALID_RECORD_PCT/.test(f)));
  const ng = calcOf(SB({ GOAL_NAME_CONTAINS: 'no-such-goal' }));
  check('No matching quota goals -> guard blocks posting (never posts a 0-quota report)', !ng.guards.passed && ng.guards.failures.some((f) => /No goal_targets matched/.test(f)));
  const idl = SB({ REP_LABEL: 'id' }).last('Notification Builder')[0];
  check('REP_LABEL=id keeps names out of the message', !/Rep \(Mock\)/.test(JSON.stringify(idl.slackPayload)) && JSON.stringify(idl.slackPayload).includes('Owner 99100004'));
  const few = SB({ MAX_REPS_IN_MESSAGE: '3' }).last('Notification Builder')[0];
  check('MAX_REPS_IN_MESSAGE caps reps shown and notes the remainder', JSON.stringify(few.slackPayload).includes('+4 more rep(s)'));

  // --------------------------------------------- 8. live paths (mocked)
  section('8. Live HubSpot paths with mocks: searches, pagination, fail-closed');
  const lm = makeMocks();
  const lv = runWorkflow({ env: LIVE, mocks: lm });
  check('Live dry-run completes', !lv.error, lv.error && lv.error.message);
  const searches = lm.state.calls.filter((x) => x.path.endsWith('/search'));
  const gs = searches.find((x) => x.path.includes('goal_targets')).body.filterGroups[0].filters;
  check('Goal search: targets overlapping [2026-10-01, 2027-01-01)', gs.some((f) => f.propertyName === 'hs_start_datetime' && f.operator === 'LT' && f.value === String(Date.UTC(2027, 0, 1))) && gs.some((f) => f.propertyName === 'hs_end_datetime' && f.operator === 'GT' && f.value === String(Date.UTC(2026, 9, 1))));
  const won = searches.find((x) => x.path.includes('deals') && x.body.filterGroups[0].filters[0].propertyName === 'hs_is_closed_won').body;
  check('Closed-won search: hs_is_closed_won = true, closedate in quarter, 200/page, stable sort', won.filterGroups[0].filters.some((f) => f.propertyName === 'closedate' && f.operator === 'GTE') && won.limit === 200 && won.sorts[0].propertyName === 'hs_object_id');
  check('Open-pipeline search: hs_is_closed = false', searches.some((x) => x.body.filterGroups[0].filters[0].propertyName === 'hs_is_closed' && x.body.filterGroups[0].filters[0].value === 'false'));
  check('All live calls are read-only (searches + owners GET)', lm.state.calls.every((x) => x.path.endsWith('/search') || (x.method === 'GET' && x.path === '/crm/v3/owners')));
  check('Owners fetched with query-string pagination (7 owners, 3 pages)', lm.state.calls.filter((x) => x.path === '/crm/v3/owners').length === 3);
  const lc = calcOf(lv);
  check('Live results equal the sandbox results for every rep', JSON.stringify(lc.reps.map((r) => [r.ownerId, r.status, r.won, r.weighted, r.quota])) === JSON.stringify(c.reps.map((r) => [r.ownerId, r.status, r.won, r.weighted, r.quota])));
  check('Live: prior-quarter deal filtered by the search itself', lc.dataQuality.outOfQuarterIgnored === 0);
  const pl = runWorkflow({ env: { ...LIVE, PIPELINES: 'default' }, mocks: makeMocks() });
  check('PIPELINES=default adds a pipeline IN filter and drops other pipelines', pl.mocks.state.calls.filter((x) => x.path.includes('deals')).every((x) => x.body.filterGroups[0].filters.some((f) => f.operator === 'IN' && f.values[0] === 'default')) && repOf(calcOf(pl), '99100003').weighted === '0.00');
  const om = runWorkflow({ env: LIVE, mocks: makeMocks({ failOwners: true }) });
  check('Owners scope missing -> labels fall back to owner IDs, run continues', !om.error && repOf(calcOf(om), '99100001').label === 'Owner 99100001' && calcOf(om).collectionWarnings.length === 1);
  const fs1 = runWorkflow({ env: LIVE, mocks: makeMocks({ failSearch: 'won' }) });
  check('Fail closed: closed-won search error aborts the run (nothing calculated)', fs1.error && /search/i.test(fs1.error.message) && !fs1.last('Variance Calculator'));
  const fs2 = runWorkflow({ env: LIVE, mocks: makeMocks({ fakeTotal: { open: 15000 } }) });
  check('Fail closed: > 10,000 matches aborts the run', fs2.error && /10,000/.test(fs2.error.message));
  const fs3 = runWorkflow({ env: LIVE, mocks: makeMocks({ endlessPaging: 'goals' }) });
  check('Fail closed: truncated pagination (50 pages) aborts the run', fs3.error && /pagination stopped/i.test(fs3.error.message));
  const big = [...fixture.closedWonDeals];
  for (let i = 0; i < 430; i++) big.push({ id: String(991000000 + i), properties: { dealname: `Synthetic Bulk ${i} (Mock)`, amount_in_home_currency: '1000', deal_currency_code: 'USD', closedate: '2026-10-20T12:00:00.000Z', hubspot_owner_id: '99100002', hs_is_closed_won: 'true', hs_is_closed: 'true', pipeline: 'default' } });
  const bm = makeMocks({ deals: [...big, ...fixture.openDeals] });
  const br = runWorkflow({ env: LIVE, mocks: bm });
  check('Pagination: 442 closed-won deals across 3 pages, Jordan +430k', !br.error && bm.state.calls.filter((x) => x.path.includes('deals') && x.body.filterGroups[0].filters[0].propertyName === 'hs_is_closed_won').length === 3 && repOf(calcOf(br), '99100002').won === '550000.00');
  const envq2 = runWorkflow({ env: { ...LIVE, QUOTA_SOURCE: 'env', QUOTA_MAP: '99100001:300000' }, mocks: makeMocks() });
  check('QUOTA_SOURCE=env skips the goal search entirely', !envq2.error && !envq2.mocks.state.calls.some((x) => x.path.includes('goal_targets')));

  // ------------------------------------- 9. posting, snapshots, hygiene
  section('9. Armed posting, duplicate guard, week-over-week and hygiene flags (mocked)');
  const sd = {};
  const am = makeMocks();
  const ar = runWorkflow({ env: ARMED, mocks: am, staticData: sd });
  check('Armed run completes and reports POSTED', !ar.error && ar.last('Forecast Run Report')[0].status === 'POSTED', ar.error && ar.error.message);
  check('Exactly one Slack and one Teams post, each to its env URL', am.state.posts.length === 2 && am.state.posts.map((p) => p.channel).sort().join() === 'slack,teams');
  const built = ar.last('Notification Builder')[0];
  check('Posted payloads are byte-identical to the builder output', JSON.stringify(am.state.posts.find((p) => p.channel === 'slack').body) === JSON.stringify(built.slackPayload) && JSON.stringify(am.state.posts.find((p) => p.channel === 'teams').body) === JSON.stringify(built.teamsPayload));
  check('Webhook URLs never appear in item data', !JSON.stringify(ar.runData).includes(TOKENS.SLACK_WEBHOOK_URL) && !JSON.stringify(ar.runData).includes('simplaceholdersig'));
  check('Snapshot and posting record saved to workflow static data', sd.snapshots['2026-Q4'].asOf === '2026-11-16' && !!sd.lastPosted['2026-Q4|2026-11-16']);
  const upd = am.state.calls.filter((x) => x.path.endsWith('/batch/update'));
  check('One hygiene batch update with the 4 flagged deals', upd.length === 1 && upd[0].body.inputs.length === 4);
  const flagOf = (id) => upd[0].body.inputs.find((i) => i.id === id).properties.forecast_hygiene_flag;
  check('Hygiene flags written: PAST_DUE_CLOSE_DATE, MISSING_PROBABILITY, INVALID_AMOUNT, MISSING_OWNER', flagOf('990050005') === 'PAST_DUE_CLOSE_DATE' && flagOf('990050007') === 'MISSING_PROBABILITY' && flagOf('990040012') === 'INVALID_AMOUNT' && flagOf('990040011') === 'MISSING_OWNER');
  const again = runWorkflow({ env: ARMED, mocks: am, staticData: sd });
  check('Second run, same as-of: duplicate post blocked (SKIPPED_ALREADY_POSTED), no new posts', am.state.posts.length === 2 && again.last('Notification Builder')[0].notifyBlockers.some((b) => /Already posted/.test(b)) && again.last('Forecast Run Report')[0].status === 'SKIPPED_ALREADY_POSTED');
  check('Second run: hygiene flags unchanged -> no CRM write', am.state.calls.filter((x) => x.path.endsWith('/batch/update')).length === 1 && again.last('Hygiene Stamp Result')[0].attempted === false);
  runWorkflow({ env: { ...ARMED, FORCE_REPOST: 'true' }, mocks: am, staticData: sd });
  check('FORCE_REPOST=true posts again deliberately', am.state.posts.length === 4);
  const nextWeekDeals = clone([...fixture.closedWonDeals, ...fixture.openDeals]);
  nextWeekDeals.push({ id: '990040099', properties: { dealname: 'Copperline Telecom - Won (Mock)', amount_in_home_currency: '40000', deal_currency_code: 'USD', closedate: '2026-11-20T12:00:00.000Z', hubspot_owner_id: '99100003', hs_is_closed_won: 'true', hs_is_closed: 'true', pipeline: 'default' } });
  const nw = runWorkflow({ env: { ...ARMED, NOW_OVERRIDE: '2026-11-23T08:00:00.000Z' }, mocks: makeMocks({ deals: nextWeekDeals }), staticData: sd });
  const nwc = calcOf(nw);
  check('Next week: WoW deltas computed from the saved snapshot (Riley +40k won)', nwc.previousSnapshotAsOf === '2026-11-16' && repOf(nwc, '99100003').wow.won === '40000.00' && nw.last('Forecast Run Report')[0].status === 'POSTED');
  const fm = makeMocks({ failSlack: true });
  const fsd = {};
  const fr = runWorkflow({ env: { ...ARMED, NOTIFY_CHANNELS: 'slack' }, mocks: fm, staticData: fsd });
  check('Post failure -> POST_FAILED, no snapshot or posting record saved', fr.last('Forecast Run Report')[0].status === 'POST_FAILED' && !fsd.snapshots && !fsd.lastPosted);
  const nm = makeMocks();
  runWorkflow({ env: { ...ARMED, HUBSPOT_MUTATIONS_ENABLED: 'false' }, mocks: nm, staticData: {} });
  check('HUBSPOT_MUTATIONS_ENABLED=false: posts go out, zero CRM writes', nm.state.posts.length === 2 && !nm.state.calls.some((x) => x.path.endsWith('/batch/update')));
  const dm = makeMocks();
  runWorkflow({ env: { ...ARMED, DRY_RUN: 'true' }, mocks: dm, staticData: {} });
  check('DRY_RUN=true with everything else armed: zero posts, zero writes', dm.state.posts.length === 0 && !dm.state.calls.some((x) => x.path.endsWith('/batch/update')));
  const hostile = clone(fixture.owners);
  hostile[3].firstName = '<!channel> *Morgan*';
  hostile[3].lastName = '[click](https://evil.example)';
  const hm = makeMocks({ owners: hostile });
  runWorkflow({ env: ARMED, mocks: hm, staticData: {} });
  const sTxt = JSON.stringify(hm.state.posts.find((p) => p.channel === 'slack').body);
  const tTxt = JSON.stringify(hm.state.posts.find((p) => p.channel === 'teams').body);
  check('Hostile CRM names are escaped: no live <!channel> in Slack, no markdown link in Teams', !sTxt.includes('<!channel>') && sTxt.includes('&lt;!channel&gt;') && !tTxt.includes('](https://evil.example)'));
  const allOut = JSON.stringify([ar.runData, am.state.calls.filter((x) => x.host === 'api.hubapi.com')]);
  check('No token or webhook secret appears in any item, report or HubSpot request body', Object.values(TOKENS).every((t) => !allOut.includes(t)));
  fs.writeFileSync(path.join(OUT_DIR, 'armed-run-report.json'), JSON.stringify(ar.last('Forecast Run Report')[0], null, 2) + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'armed-run-call-log.json'), JSON.stringify(am.state.calls.map((x) => ({ node: x.node, method: x.method, host: x.host.replace(/^prod-00\./, '*.'), path: x.host === 'api.hubapi.com' ? x.path : '(webhook)' })), null, 2) + '\n');

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
  console.log(`Sandbox team: ${c.team.won} / ${c.team.quota} ${c.currency} (${c.team.attainmentPct}%), pacing ${c.team.pacingPct}%, forecast ${c.team.projectedAttainmentPct}%`);
  console.log('Output written to: sim-output/ (git-ignored)');
  if (failed) { console.log('\nFailures:\n' + failures.map((f) => ` - ${f}`).join('\n')); process.exit(1); }
})();
