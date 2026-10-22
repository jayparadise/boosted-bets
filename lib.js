// Shared browser/Node logic for the bet365 -> DST data-entry importer.
// parseBet365Html, buildRows, norm, dice, resolvePlayer, matchFixtures, the seven field names.

// DST pricing-table prices for 0.5 Shots on Goal (lookup table, column "1"). bet365's 1+ SOT price is rounded DOWN
// to the nearest of these (4.50 -> 4.00, 1.27 -> 1.25); above the top it is capped at the top, below the bottom it takes the bottom.
export const SOT_GRID = [1.01, 1.02, 1.03, 1.04, 1.05, 1.06, 1.08, 1.10, 1.12, 1.15, 1.18, 1.20, 1.25, 1.30, 1.35, 1.40, 1.45, 1.50, 1.60, 1.70, 1.80, 1.90, 2.00, 2.25, 2.50, 3.00, 4.00, 5.00, 6.00, 7.50];
export function roundDownToGrid(price, grid = SOT_GRID) {
  if (price == null) return null;
  let best = null;
  for (const g of grid) { if (g <= price + 1e-9) best = g; else break; }
  return best ?? grid[0];
}
// Shots: pick the rung whose price is in this band (inclusive); otherwise the rung closest to 1.88 in implied probability.
export const SHOTS_BAND = [1.88, 3.00];

export const FIELDS = ['shots', 'shots1_5Price', 'shotsOnGoal0_5Price', 'tackles0_5Price', 'assistPrice', 'cards', 'goals'];
export const FIELD_LABELS = ['Shots', 'Shots $', '0.5 SOT', '1.5 Tkl', 'Assist', 'Cards', 'Goals'];
export const TABS = ['Shots', 'Shots On Target', 'Tackles', 'Score or Assist', 'To Be Booked'];

const clean = s => (s || '').replace(/\s+/g, ' ').trim();
const price = s => (/^\d+\.\d+$/.test(s) ? Number(s) : null);

// Parse one "Webpage, Complete" save of a bet365 Weekend player-props tab.
// Structure-based (bet365's class names are obfuscated and differ between site builds):
//  - a game title is a leaf element whose text is "Home v Away"
//  - a ladder / Score-or-Assist table is the group of sibling columns whose classes contain "rgl-Market-pwidth";
//    the pwidth40 column holds the names (one child per player after a header), the others [header, cell per player]
//  - a To Be Booked list is elements holding a name leaf + a price leaf, outside any pwidth column
//  - each table / pair belongs to the nearest preceding title in document order
// Returns { tab, games: [{ title, headers, rows: { bet365Name: [prices] } }] }
export function parseBet365Html(htmlText, Parser) {
  const doc = new Parser().parseFromString(htmlText, 'text/html');
  let tab = '';
  for (const b of doc.querySelectorAll('button[aria-selected="true"]')) {
    const t = clean(b.textContent).replace(/^(.+?)\1$/, '$1'); // label is repeated in two spans
    if (TABS.includes(t)) { tab = t; break; }
  }
  const isTitle = s => / v /.test(s) && s.length < 80 && !/\d\.\d/.test(s);
  const leaves = el => [...el.querySelectorAll('*')].filter(e => !e.children.length);
  const before = (a, b) => (a.compareDocumentPosition(b) & 4) !== 0; // a precedes b
  const titleEls = [...doc.querySelectorAll('div,span,h1,h2,h3,h4')].filter(e => !e.children.length && isTitle(clean(e.textContent)));
  const nearestTitle = el => { let best = null; for (const t of titleEls) { if (before(t, el)) best = t; else break; } return best ? clean(best.textContent) : null; };

  const games = {}; const order = [];
  const game = title => { if (!games[title]) { games[title] = { title, headers: [], rows: {} }; order.push(title); } return games[title]; };
  const add = (g, name, prices) => {
    const old = g.rows[name];
    if (!old) { g.rows[name] = prices; return; }
    const n = Math.max(old.length, prices.length);
    g.rows[name] = Array.from({ length: n }, (_, i) => old[i] ?? prices[i] ?? null);
  };
  const nameOf = row => { // the leaf with the most letters inside a participant row
    let best = '', bl = 0;
    for (const l of [row, ...leaves(row)]) { const t = clean(l.textContent); const n = (t.match(/[A-Za-z\u00C0-\u024F]/g) || []).length; if (!l.children.length && n > bl) { bl = n; best = t; } }
    return best.replace(/^\d+\s*/, '').replace(/[\d\s]+$/, '').trim();
  };

  // ladder / score-assist tables
  const seenGroups = new Set();
  for (const pc40 of doc.querySelectorAll('[class*="rgl-Market-pwidth40"]')) {
    const grp = pc40.parentElement; if (!grp || seenGroups.has(grp)) continue; seenGroups.add(grp);
    const title = nearestTitle(grp); if (!title) continue;
    // price columns are siblings of the name column, or nested in a sibling scroll wrapper (ladder tabs)
    const pcols = [...grp.querySelectorAll('[class*="rgl-Market-pwidth"]')].filter(d => !/pwidth40/.test(d.className) && !d.parentElement.closest('[class*="rgl-Market-pwidth"]'));
    const rowsEls = [...pc40.children].slice(1);
    const names = rowsEls.map(nameOf);
    if (!pcols.length || !names.length) continue;
    const headers = [], cols = [];
    for (const pc of pcols) {
      const cells = [...pc.children];
      headers.push(clean(cells[0]?.textContent));
      cols.push(cells.slice(1).map(c => clean(c.textContent)));
    }
    if (cols.some(c => c.length !== names.length)) throw new Error(`${title}: column/name count mismatch (bet365 markup changed?)`);
    const g = game(title); g.headers = headers;
    const rung = headers.map(h => /^(\d+)\+$/.exec(h));
    if (rung.every(Boolean)) {
      const width = Math.max(...rung.map(m => Number(m[1])));
      names.forEach((n, i) => { const p = Array(width).fill(null); rung.forEach((m, j) => { p[Number(m[1]) - 1] = price(cols[j][i]); }); add(g, n, p); });
    } else {
      names.forEach((n, i) => add(g, n, cols.map(c => price(c[i]))));
    }
  }

  // booked-style list (name + price pairs), only when no table was found on the page
  if (!order.length) {
    for (const el of doc.querySelectorAll('div,li')) {
      if (el.children.length < 2) continue;
      const kids = [...el.children].filter(k => !k.children.length);
      const nameEl = kids.find(k => /[A-Za-z]{3,}/.test(clean(k.textContent)) && !isTitle(clean(k.textContent)));
      const priceEl = kids.find(k => /^\d+\.\d+$/.test(clean(k.textContent)));
      if (!nameEl || !priceEl) continue;
      const title = nearestTitle(el); if (!title) continue;
      const g = game(title); g.headers = ['booked'];
      add(g, clean(nameEl.textContent), [price(clean(priceEl.textContent))]);
    }
  }
  const out = order.map(t => games[t]);
  if (!tab && out.length) {
    const h = out[0].headers;
    if (h[0] === 'booked') tab = 'To Be Booked';
    else if (h.includes('Score') || h.includes('Assist')) tab = 'Score or Assist';
  }
  return { tab, games: out };
}

// Combine parsed tabs into the seven app values per player per game.
// tabs: { 'Shots': games, 'Shots On Target': games, 'Tackles': games, 'Score or Assist': games, 'To Be Booked': games }
export function buildRows(tabs) {
  const byTitle = {};
  const put = (title, name, i, v) => {
    const g = (byTitle[title] ??= {});
    (g[name] ??= Array(7).fill(null))[i] = v ?? null;
  };
  // Shots: the rung whose bet365 price sits between 1.88 and 3.00 (lowest such rung).
  // If no rung is in that band, the rung closest to 1.88 in implied probability (1/price), which favours the
  // price above the band when the one below is a heavy favourite: 1+ 1.57 / 2+ 3.50 -> 1+ (64% vs 29%, 53% target);
  // 1+ 1.20 / 2+ 3.10 -> 2+ (83% vs 32%).
  const pickShots = prices => {
    const rungs = prices.map((p, i) => ({ p, i })).filter(x => x.p != null);
    if (!rungs.length) return null;
    const inBand = rungs.filter(x => x.p >= SHOTS_BAND[0] && x.p <= SHOTS_BAND[1]);
    if (inBand.length) return inBand[0];
    const d = x => Math.abs(1 / x.p - 1 / 1.88);
    return rungs.reduce((a, b) => (d(b) < d(a) ? b : a));
  };
  for (const g of tabs['Shots'] ?? []) for (const [n, p] of Object.entries(g.rows)) {
    const b = pickShots(p); if (b) { put(g.title, n, 0, b.i + 0.5); put(g.title, n, 1, b.p); }
  }
  for (const g of tabs['Shots On Target'] ?? []) for (const [n, p] of Object.entries(g.rows)) put(g.title, n, 2, roundDownToGrid(p[0]));
  for (const g of tabs['Tackles'] ?? []) for (const [n, p] of Object.entries(g.rows)) put(g.title, n, 3, p[1]);
  for (const g of tabs['Score or Assist'] ?? []) {
    const si = g.headers.indexOf('Score'), ai = g.headers.indexOf('Assist');
    for (const [n, p] of Object.entries(g.rows)) { put(g.title, n, 6, si >= 0 ? p[si] : null); put(g.title, n, 4, ai >= 0 ? p[ai] : null); }
  }
  for (const g of tabs['To Be Booked'] ?? []) for (const [n, p] of Object.entries(g.rows)) put(g.title, n, 5, p[0]);
  return byTitle;
}

export const norm = s => (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[-'`.]/g, ' ').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).join(' ');

export function dice(a, b) {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const bg = s => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); m.set(k, (m.get(k) || 0) + 1); } return m; };
  const A = bg(a), B = bg(b); let inter = 0;
  for (const [k, v] of A) if (B.has(k)) inter += Math.min(v, B.get(k));
  return 2 * inter / ((a.length - 1) + (b.length - 1));
}

// roster: [{player:{id,name,isActive}, team:{abbreviation}, ...fields}], aliases: {normBet365Name: playerId}
// Returns { byNorm, counts, resolve(name) -> [entries[], how] }
export function makeResolver(roster, aliases) {
  const byNorm = {}, byId = {}, counts = {};
  for (const p of roster) {
    const k = norm(p.player.name);
    counts[k] = (counts[k] || 0) + 1;
    (byNorm[k] ??= []).push(p);
    byId[p.player.id] = p;
  }
  const resolve = name => {
    const k = norm(name);
    if (aliases && aliases[k] === 'IGNORE') return [null, 'ignored'];
    if (aliases && aliases[k] && byId[aliases[k]]) { const p = byId[aliases[k]]; return [byNorm[norm(p.player.name)], 'alias']; }
    if (byNorm[k]) return [byNorm[k], 'exact'];
    const toks = new Set(k.split(' '));
    const hits = Object.keys(byNorm).filter(rn => { const rt = new Set(rn.split(' ')); return [...toks].every(t => rt.has(t)) || [...rt].every(t => toks.has(t)); });
    if (hits.length === 1) return [byNorm[hits[0]], 'token'];
    let best = null, bs = 0;
    for (const rn of Object.keys(byNorm)) { const s = dice(k, rn); if (s > bs) { bs = s; best = rn; } }
    if (bs >= 0.72) return [byNorm[best], 'fuzzy ' + bs.toFixed(2)];
    return [null, 'none'];
  };
  return { byNorm, byId, counts, resolve };
}

// ---- fixture (game title) matching ----
const TEAM_STOP = new Set(['fc', 'cf', 'sc', 'afc', 'cfc', 'club', 'de', 'the', 'rj', 'sp', 'rs', 'mg', 'pr', 'fk', 'sk', 'ac', 'as', 'ss', 'sv', 'fsv', 'bsc', 'rc', 'rcd', 'ud', 'cd', 'ca', 'sd', 'cr', 'se', 'fr', 'ec', 'cs', 'ca', '1', 'calcio', 'football', 'ks', 'nk', 'gnk', 'hnk', 'rsc', 'kv', 'kaa', 'osc', 'sm', 'ogc', 'us', 'ss', 'sa', 'bv', 'tsv', 'vfl', 'vfb', '04', '05', '96', '98', '1899', '1860', 'e.v']);
const TEAM_SUBS = { utd: 'united', st: 'saint', 'man': 'manchester', 'nottm': 'nottingham', 'atl': 'atletico', 'ath': 'athletic', 'psg': 'paris saint germain', 'bmg': 'borussia monchengladbach', 'gladbach': 'monchengladbach', 'wolves': 'wolverhampton wanderers', 'spurs': 'tottenham hotspur', 'ny': 'new york', 'kc': 'kansas city', 'rsl': 'real salt lake', 'rb': 'red bull', 'nyc': 'new york city', 'lafc': 'los angeles football club', 'nycfc': 'new york city', 'skc': 'sporting kansas city', 'rbny': 'new york red bulls', 'cfm': 'cf montreal' };
const tokHit = (t, B) => B.some(b => b === t || (t.length >= 4 && b.startsWith(t)) || (b.length >= 4 && t.startsWith(b)));
export function teamTokens(name) {
  let n = norm(name);
  for (const [a, b] of Object.entries(TEAM_SUBS)) n = n.replace(new RegExp(`(^| )${a}( |$)`, 'g'), `$1${b}$2`);
  return n.split(' ').filter(t => t && !TEAM_STOP.has(t));
}
export function teamScore(a, b) {
  const A = teamTokens(a), B = teamTokens(b);
  if (!A.length || !B.length) return 0;
  const shared = A.filter(t => tokHit(t, B)).length;
  const tok = shared / Math.min(A.length, B.length);
  return 0.7 * tok + 0.3 * dice(A.join(' '), B.join(' '));
}
// fixtures: [{id, homeTeam:{name}, awayTeam:{name}, date, progress:{status}}]; teamAliases: {normBet365Team: appTeamName}
// returns { fixture|null, score, candidates:[{fixture, score}] }
export function matchFixture(title, fixtures, teamAliases) {
  const [h, a] = title.split(' v ').map(s => s.trim());
  const ah = teamAliases?.[norm(h)], aa = teamAliases?.[norm(a)];
  const scored = fixtures.map(f => {
    let s = teamScore(h, f.homeTeam.name) + teamScore(a, f.awayTeam.name);
    if (ah && norm(f.homeTeam.name) === norm(ah)) s += 1;
    if (aa && norm(f.awayTeam.name) === norm(aa)) s += 1;
    return { fixture: f, score: s };
  }).sort((x, y) => y.score - x.score || String(x.fixture.date).localeCompare(String(y.fixture.date)));
  const best = scored[0];
  const ok = best && best.score >= 1.0 && (!scored[1] || best.score - scored[1].score >= 0.25);
  return { fixture: ok ? best.fixture : null, score: best ? best.score : 0, candidates: scored.slice(0, 6) };
}

export const same = (a, b) => Math.abs((a == null ? 0 : Number(a)) - (b == null ? 0 : Number(b))) < 0.006;
