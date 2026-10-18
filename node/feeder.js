// Feeds a Tdarr library to the node one file at a time, in path order.
// The library is scanned in full once with "Process library" off; --park then sets every record that is
// waiting to "Not required" so nothing runs when processing is turned on. The feeder loop sets one record
// at a time to "Queued" and waits until it is finished before queuing the next.
// Scanning a single folder makes Tdarr drop the records of every file outside it (tested 2026-10-17),
// so this script never scans; it only changes record status.
// Usage:
//   node feeder.js --library movies --park           park every Queued record not yet fed
//   node feeder.js --library movies [--count 50]     feed files until --count are done, or none are left
//   node feeder.js --library movies --status         show progress
const fs = require('fs');
const path = require('path');

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const flag = (name) => process.argv.includes(`--${name}`);
const LIBRARY = arg('library', 'movies');
const COUNT = Number(arg('count', 'Infinity'));
const INTERVAL = Number(arg('interval', '15')) * 1000;
const LOG_DIR = 'C:/Code/tdarr/logs';
const STATE = arg('state', `${LOG_DIR}/feeder-state-${LIBRARY}.json`);
const LOCK = `${STATE}.lock`;
const LOG = `${LOG_DIR}/feeder.log`;
const API = 'http://bandersnatch:8265/api/v2/';
const ENV = path.join(__dirname, '.env'); // TDARR_API_KEY=..., gitignored
const PARKED = 'Not required';
const WAITING = /queued|processing/i;

const key = process.env.TDARR_API_KEY || (fs.readFileSync(ENV, 'utf8').match(/^TDARR_API_KEY=(.*)$/m) || [])[1].trim();
const log = (msg) => {
  const line = `${new Date().toISOString()} [${LIBRARY}] ${msg}`;
  console.log(line);
  if (!flag('status')) fs.appendFileSync(LOG, `${line}\n`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (endpoint, data) => {
  const r = await fetch(API + endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify({ data }) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${endpoint} HTTP ${r.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
};
const records = async () => (await post('cruddb', { collection: 'FileJSONDB', mode: 'getAll' }))
  .filter((f) => f.DB === LIBRARY).sort((a, b) => a._id.localeCompare(b._id, 'en', { sensitivity: 'base' }));
const setStatus = (id, status) => post('cruddb', { collection: 'FileJSONDB', mode: 'update', docID: id, obj: { TranscodeDecisionMaker: status } });
const loadState = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { fed: [] });
const saveState = (s) => { fs.writeFileSync(`${STATE}.tmp`, JSON.stringify(s, null, 1)); fs.renameSync(`${STATE}.tmp`, STATE); };
// A converted file can come back as a new record (.avi became .mkv); same path without extension = already fed.
const stem = (p) => p.replace(/\.[^./]+$/, '');

const lock = () => {
  if (fs.existsSync(LOCK)) {
    const pid = Number(fs.readFileSync(LOCK, 'utf8'));
    try { process.kill(pid, 0); throw new Error(`feeder already running for ${LIBRARY} (pid ${pid})`); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
  fs.writeFileSync(LOCK, String(process.pid));
  const release = () => { try { if (fs.readFileSync(LOCK, 'utf8') === String(process.pid)) fs.unlinkSync(LOCK); } catch { /* gone */ } };
  process.on('exit', release);
  process.on('SIGINT', () => { log('stopped by Ctrl+C; the file in progress, if any, will finish'); process.exit(130); });
};

(async () => {
  const state = loadState();
  const fedStems = new Set(state.fed.map((f) => stem(f.id)));

  if (flag('status')) {
    const recs = await records();
    const left = recs.filter((f) => !fedStems.has(stem(f._id)) && f.TranscodeDecisionMaker === PARKED).length;
    const waiting = recs.filter((f) => WAITING.test(f.TranscodeDecisionMaker || ''));
    log(`${recs.length} records, ${state.fed.length} fed, ${left} parked and not fed, ${waiting.length} queued: ${waiting.map((f) => path.posix.basename(f._id)).join(', ') || 'none'}`);
    return;
  }

  if (flag('park')) {
    const recs = await records();
    const toPark = recs.filter((f) => !fedStems.has(stem(f._id)) && WAITING.test(f.TranscodeDecisionMaker || ''));
    for (const f of toPark) await setStatus(f._id, PARKED);
    log(`parked ${toPark.length} of ${recs.length} records`);
    return;
  }

  lock();
  const lib = await post('cruddb', { collection: 'LibrarySettingsJSONDB', mode: 'getById', docID: LIBRARY });
  if (!lib || !lib._id) throw new Error(`library ${LIBRARY} not found`);
  if (!lib.processLibrary) log('warning: "Process library" is off, so a queued file will not run');
  let fedThisRun = 0;
  let current = null;
  log(`feeder started${Number.isFinite(COUNT) ? `, count ${COUNT}` : ''}`);
  for (;;) {
    const recs = await records();
    const waiting = recs.filter((f) => WAITING.test(f.TranscodeDecisionMaker || ''));
    if (current) {
      const rec = recs.find((f) => f._id === current);
      if (waiting.length) { await sleep(INTERVAL); continue; }
      log(`done: ${path.posix.basename(current)} -> ${rec ? rec.TranscodeDecisionMaker : 'record replaced'}`);
      current = null;
    } else if (waiting.length) {
      log(`waiting: ${waiting.length} file(s) already queued in this library (${path.posix.basename(waiting[0]._id)}); not feeding until they finish`);
      await sleep(INTERVAL);
      continue;
    }
    if (fedThisRun >= COUNT) { log(`count ${COUNT} reached; stopping`); return; }
    const next = recs.find((f) => !fedStems.has(stem(f._id)) && f.TranscodeDecisionMaker === PARKED);
    if (!next) { log('nothing left to feed; stopping'); return; }
    await setStatus(next._id, 'Queued');
    state.fed.push({ id: next._id, at: new Date().toISOString() });
    fedStems.add(stem(next._id));
    saveState(state);
    fedThisRun += 1;
    current = next._id;
    log(`fed ${fedThisRun}${Number.isFinite(COUNT) ? `/${COUNT}` : ''}: ${next._id}`);
    await sleep(INTERVAL);
  }
})().catch((e) => { log(`error: ${e.message}`); process.exitCode = 1; });
