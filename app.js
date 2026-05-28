/* =========================================================================
   STATE
   ========================================================================= */
const state = {
  // For each team: {strength: 0-100, override: boolean, lock: null|'W'|'RU'|'3'|'out'}
  teams: {}, // teamName -> {group, strength, override, lock, oddsSource}
  matchLocks: {}, // matchId -> teamName (winner forced)
  simResults: null, // computed
  fetchStatus: 'pending', // 'pending'|'live'|'fallback'|'manual'
  viewMode: 'full'  // 'full' | 'left' | 'right' — bracket view selector
};

function initState(){
  for(const [g, teams] of Object.entries(GROUPS)){
    teams.forEach(t => {
      state.teams[t] = {
        group:g,
        strength: FALLBACK_GROUP_WIN_PCT[g][t] || 25,
        override:false, lock:null, oddsSource:'fallback'
      };
    });
  }
}

/* =========================================================================
   POLYMARKET FETCH
   ========================================================================= */
/* Polymarket spells some teams differently than our GROUPS list.
   Map (normalized) Polymarket name -> our canonical team name. */
const NAME_ALIASES = {
  usa:"United States",
  turkiye:"Turkey",                       // "Türkiye" -> turkiye after accent strip
  congodr:"DR Congo",                     // Polymarket: "Congo DR"
  bosniaandherzegovina:"Bosnia & Herzegovina"
};

async function fetchPolymarketOdds(){
  setStatus('loading', 'Fetching live odds…');
  let successCount = 0, failCount = 0;

  await Promise.all(Object.entries(POLYMARKET_SLUGS).map(async ([g, slug]) => {
    try{
      const res = await fetch(`https://gamma-api.polymarket.com/events/slug/${slug}`,{cache:'no-store'});
      if(!res.ok) throw new Error('http '+res.status);
      const data = await res.json();
      // event has .markets[]; each market has .outcomes (JSON string) and .outcomePrices (JSON string)
      // For multi-outcome group winner: typically each "market" is one team's Yes/No.
      // Iterate markets, extract the team name from groupItemTitle or outcomes, and use Yes price.
      const markets = data.markets || [];
      let pulled = 0;
      markets.forEach(m => {
        // teamName likely in m.groupItemTitle, m.title, or extractable
        const name = m.groupItemTitle || m.outcomes?.[0] || null;
        if(!name) return;
        // outcomePrices may be string "[0.53, 0.47]" or array
        let prices = m.outcomePrices;
        if(typeof prices === 'string'){ try{ prices = JSON.parse(prices) }catch(e){ return } }
        if(!Array.isArray(prices) || prices.length<1) return;
        const yesPrice = parseFloat(prices[0]);
        if(isNaN(yesPrice)) return;
        // Match to a team in this group: explicit alias first, then fuzzy.
        const nname = normalize(name);
        const matched = (NAME_ALIASES[nname] && GROUPS[g].includes(NAME_ALIASES[nname]))
          ? NAME_ALIASES[nname]
          : GROUPS[g].find(t => normalize(t) === nname || normalize(t).includes(nname) || nname.includes(normalize(t)));
        if(matched && state.teams[matched] && !state.teams[matched].override){
          state.teams[matched].strength = yesPrice * 100;
          state.teams[matched].oddsSource = 'live';
          pulled++;
        }
      });
      if(pulled > 0) successCount++; else failCount++;
    }catch(e){ failCount++; }
  }));

  // Normalize each group's win-% to sum to 100 (Polymarket may sum to slightly >100 due to bid-ask)
  Object.keys(GROUPS).forEach(g => {
    const teams = GROUPS[g];
    const total = teams.reduce((s,t)=>s+state.teams[t].strength,0);
    if(total > 0){
      teams.forEach(t => state.teams[t].strength = state.teams[t].strength * 100 / total);
    }
  });

  if(successCount >= 6){
    setStatus('live', `Live · ${successCount}/12 groups from Polymarket`);
    state.fetchStatus = 'live';
  } else if(successCount > 0){
    setStatus('partial', `Partial · ${successCount}/12 live, rest from fallback priors`);
    state.fetchStatus = 'partial';
  } else {
    setStatus('fallback', 'Using fallback priors (Polymarket unreachable from browser)');
    state.fetchStatus = 'fallback';
  }
}

function setStatus(kind, text){
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');
  dot.className = 'dot' + (kind==='live'||kind==='partial' ? ' live' : '');
  txt.textContent = text;
}

function normalize(s){return s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'')}

/* =========================================================================
   SIMULATION
   For each group: derive (1st, 2nd, 3rd, 4th) probs from win-prob using
   a Plackett-Luce-style model (strength as weight, sample without replacement).
   For each knockout match: pair probabilities = strengthA / (strengthA + strengthB).
   Honor match locks (forced winners).
   ========================================================================= */
function runSim(){
  const N = Math.max(500, Math.min(100000, parseInt(document.getElementById('simCount').value) || 10000));
  state.varianceExp = parseFloat(document.getElementById('varianceSlider').value) || 0.85;
  const matchWinCounts = {}; // matchId -> {teamName: count}
  const matchPairCounts = {}; // matchId -> "teamA||teamB": count
  const matchHeadToHead = {}; // matchId -> {"teamA||teamB": {teamA: wins, teamB: wins}} for showing odds

  // Track for the per-group finish placements
  const groupFinish = {}; // group -> {team: {1:0,2:0,3:0,4:0}}
  Object.keys(GROUPS).forEach(g => {
    groupFinish[g] = {};
    GROUPS[g].forEach(t => groupFinish[g][t] = {1:0,2:0,3:0,4:0});
  });

  let annexCMissCount = 0; // sanity stat

  for(let sim=0; sim<N; sim++){
    // 1. Sample group standings
    const standings = {}; // group -> [team1st, team2nd, team3rd, team4th]
    for(const g of Object.keys(GROUPS)){
      standings[g] = sampleGroupStanding(g);
      standings[g].forEach((t,i) => groupFinish[g][t][i+1]++);
    }

    // 2. Determine the 8 best 3rd-place teams.
    // Real-life criteria: points, goal difference, goals scored, etc.
    // We use team strength as a proxy (consistent with the rest of the model).
    const all3rd = Object.keys(GROUPS).map(g => ({group:g, team:standings[g][2]}));
    all3rd.sort((a,b) => state.teams[b.team].strength - state.teams[a.team].strength);
    const third8 = all3rd.slice(0,8);
    const third8Groups = third8.map(x => x.group);
    const third8ByGroup = {}; third8.forEach(x => third8ByGroup[x.group] = x.team);

    // 3. Look up the official Annex C assignment for this combination of qualifying groups.
    const key = third8Groups.slice().sort().join('');
    const annexAssignment = ANNEX_C[key]; // 8-element array [opponentOf1A, opponentOf1B, opponentOf1D, opponentOf1E, opponentOf1G, opponentOf1I, opponentOf1K, opponentOf1L]
    if(!annexAssignment){
      annexCMissCount++;
      continue; // very rare — would indicate a data bug
    }

    // 4. Resolve R32 slots using standings + Annex C
    const matchResults = {}; // matchId -> winner team
    const matchLosers  = {}; // matchId -> loser team (needed for the 3rd-place playoff)
    R32.forEach(([id, venue, date, slotA, slotB]) => {
      const teamA = resolveSlot(slotA, standings, third8ByGroup, annexAssignment);
      const teamB = resolveSlot(slotB, standings, third8ByGroup, annexAssignment);
      const winner = simulateMatch(id, teamA, teamB);
      matchResults['M'+id] = winner;
      matchLosers['M'+id]  = winner === teamA ? teamB : teamA;
      bumpPair(matchPairCounts, id, teamA, teamB);
      bumpWin(matchWinCounts, id, winner);
      bumpH2H(matchHeadToHead, id, teamA, teamB, winner);
    });

    // 5. R16, QF, SF, then the Final + 3rd-place playoff.
    // A "Mxxx-loser" ref pulls the losing team of that match (the 3rd-place game
    // is Match 103 = loser of SF M101 vs loser of SF M102).
    const resolveRef = ref => ref.endsWith('-loser') ? matchLosers[ref.slice(0,-6)] : matchResults[ref];
    const laterRounds = [R16, QF, SF, FINAL];
    laterRounds.forEach(round => {
      round.forEach(([id, venue, date, refA, refB]) => {
        const teamA = resolveRef(refA);
        const teamB = resolveRef(refB);
        if(!teamA || !teamB) return;
        const winner = simulateMatch(id, teamA, teamB);
        matchResults['M'+id] = winner;
        matchLosers['M'+id]  = winner === teamA ? teamB : teamA;
        bumpPair(matchPairCounts, id, teamA, teamB);
        bumpWin(matchWinCounts, id, winner);
        bumpH2H(matchHeadToHead, id, teamA, teamB, winner);
      });
    });
  }

  state.simResults = {N, matchWinCounts, matchPairCounts, matchHeadToHead, groupFinish, annexCMissCount};
  document.getElementById('simStat').textContent = `${N.toLocaleString()} sims · ${state.fetchStatus}${annexCMissCount?` · ${annexCMissCount} annex misses`:''}`;
}

function sampleGroupStanding(g){
  const teams = GROUPS[g].slice();
  const result = [];
  // Build pool with strengths, possibly with locks honored
  const locked = {}; // place -> team
  teams.forEach(t => {
    if(state.teams[t].lock === 'W') locked[1] = t;
    else if(state.teams[t].lock === 'RU') locked[2] = t;
    else if(state.teams[t].lock === '3') locked[3] = t;
    else if(state.teams[t].lock === 'out') locked[4] = t;
  });
  let pool = teams.filter(t => !Object.values(locked).includes(t));
  for(let place=1; place<=4; place++){
    if(locked[place]){
      result.push(locked[place]);
    } else {
      // Plackett-Luce: pick weighted by strength from remaining pool
      const weights = pool.map(t => Math.max(0.5, state.teams[t].strength));
      const totalW = weights.reduce((a,b)=>a+b,0);
      let r = Math.random() * totalW;
      let idx = 0;
      for(; idx<weights.length; idx++){ r -= weights[idx]; if(r<=0) break; }
      idx = Math.min(idx, pool.length-1);
      result.push(pool[idx]);
      pool.splice(idx,1);
    }
  }
  return result;
}

function resolveSlot(spec, standings, third8ByGroup, annexAssignment){
  if(spec.type === 'W') return standings[spec.group][0];
  if(spec.type === 'RU') return standings[spec.group][1];
  if(spec.type === '3') return standings[spec.group][2];
  if(spec.type === '3of'){
    // Look up which group's 3rd-place fills this slot.
    // The 3of slot is identified by which group winner it opposes — find that
    // from the R32 entry that owns this slot. We use a small map below.
    // (See ANNEX_C_SLOT_INDEX — the slot is indexed by the W-Group letter.)
    const wGroup = spec.opposingWinnerGroup;
    const idx = ANNEX_C_SLOT_INDEX[wGroup];
    if(idx === undefined || !annexAssignment) {
      // Fallback: pick a random eligible group
      const eligible = spec.groups.filter(g => third8ByGroup[g]);
      return third8ByGroup[eligible[0]] || standings[spec.groups[0]][2];
    }
    const assignedGroup = annexAssignment[idx];
    return third8ByGroup[assignedGroup] || standings[assignedGroup][2];
  }
}

function simulateMatch(id, teamA, teamB){
  // Honor match-level lock
  if(state.matchLocks[id]){
    if(state.matchLocks[id] === teamA || state.matchLocks[id] === teamB){
      return state.matchLocks[id];
    }
    // Locked team isn't even in this match in this sim — fall through
  }
  const sA = Math.max(0.5, state.teams[teamA].strength);
  const sB = Math.max(0.5, state.teams[teamB].strength);
  // Variance exponent: lower = more upsets, higher = chalk
  const exp = state.varianceExp || 0.85;
  const eA = Math.pow(sA, exp);
  const eB = Math.pow(sB, exp);
  return Math.random() < eA/(eA+eB) ? teamA : teamB;
}

function bumpWin(o,id,team){ (o[id] = o[id]||{})[team] = (o[id][team]||0)+1; }
function bumpPair(o,id,a,b){
  const key = [a,b].sort().join('||');
  (o[id] = o[id]||{})[key] = (o[id][key]||0)+1;
}
function bumpH2H(o,id,a,b,winner){
  const key = [a,b].sort().join('||');
  if(!o[id]) o[id] = {};
  if(!o[id][key]) o[id][key] = {[a]:0,[b]:0,total:0};
  o[id][key][winner]++;
  o[id][key].total++;
}

/* =========================================================================
   RENDER — Groups
   ========================================================================= */
function renderGroups(){
  const c = document.getElementById('groupsContainer');
  c.innerHTML = '';
  for(const g of Object.keys(GROUPS)){
    const teams = GROUPS[g];
    const groupEl = document.createElement('div');
    groupEl.className = 'group';
    const finish = state.simResults?.groupFinish?.[g];
    const N = state.simResults?.N || 1;
    let teamsHtml = teams.map(t => {
      const ts = state.teams[t];
      const f = finish?.[t];
      const winPct = f ? (f[1]/N*100).toFixed(0) : '—';
      const finishSummary = f ? `${(f[1]/N*100).toFixed(0)}·${(f[2]/N*100).toFixed(0)}·${(f[3]/N*100).toFixed(0)}` : '';
      const lockMark = ts.lock ? `<span class="pill locked">${ts.lock}</span>` : '';
      const srcMark = ts.override ? `<span class="pill manual">M</span>` : (ts.oddsSource==='live' ? `<span class="pill live">L</span>` : '');
      return `
        <div class="team ${ts.lock?'locked':''}">
          <span class="team-name" data-team="${t}" style="cursor:pointer">${t}${lockMark}${srcMark}</span>
          <input class="team-slider" type="range" min="0" max="100" step="1" value="${ts.strength.toFixed(1)}" data-team="${t}">
          <span class="team-prob" title="Win·RU·3rd %">${finishSummary || winPct}</span>
        </div>
      `;
    }).join('');
    groupEl.innerHTML = `
      <div class="group-head">
        <span class="group-name">Group <b>${g}</b></span>
        <span class="group-src">${state.fetchStatus}</span>
      </div>
      <div class="teams">${teamsHtml}</div>
    `;
    c.appendChild(groupEl);
  }
  // Bind sliders
  c.querySelectorAll('input.team-slider').forEach(inp => {
    inp.addEventListener('input', e => {
      const t = e.target.dataset.team;
      state.teams[t].strength = parseFloat(e.target.value);
      state.teams[t].override = true;
    });
    inp.addEventListener('change', () => { runSim(); renderAll(); });
  });
  // Bind team-name click → cycle lock
  c.querySelectorAll('.team-name').forEach(el => {
    el.addEventListener('click', e => {
      const t = e.target.closest('.team-name').dataset.team;
      const cycle = [null,'W','RU','3','out'];
      const cur = state.teams[t].lock;
      state.teams[t].lock = cycle[(cycle.indexOf(cur)+1) % cycle.length];
      // If we set a W/RU/3/out, clear other locks in the same group (only one team can hold each place)
      if(state.teams[t].lock){
        const place = state.teams[t].lock;
        const g = state.teams[t].group;
        GROUPS[g].forEach(other => {
          if(other !== t && state.teams[other].lock === place){
            state.teams[other].lock = null;
          }
        });
      }
      runSim(); renderAll();
    });
  });
}

/* =========================================================================
   RENDER — Bracket
   ========================================================================= */
let selectedMatchId = null;

/* Most-likely occupant of an R32 slot (+ its display label and probability).
   Shared by the bracket render and the predicted-path propagation so the two
   can never disagree about who fills a slot. */
function r32SlotLikely(spec, matchId, N){
  const sim = state.simResults;
  let label='', team='', pct='';
  if(spec.type==='W'||spec.type==='RU'||spec.type==='3'){
    label = `${spec.type} ${spec.group}`;
    const place = spec.type==='W'?1:spec.type==='RU'?2:3;
    const finish = sim?.groupFinish?.[spec.group]||{};
    const best = Object.entries(finish).map(([t,p])=>[t,p[place]||0]).sort((a,b)=>b[1]-a[1])[0];
    if(best && best[1]>0){ team=best[0]; pct=(best[1]/N*100).toFixed(0)+'%'; }
  } else if(spec.type==='3of'){
    label = `3 of ${spec.groups.join('/')}`;
    const wG = spec.opposingWinnerGroup;
    const tally = {};
    Object.entries(sim?.matchPairCounts?.[matchId]||{}).forEach(([k,c])=>{
      k.split('||').forEach(t => { if(state.teams[t] && state.teams[t].group !== wG) tally[t]=(tally[t]||0)+c; });
    });
    const best = Object.entries(tally).sort((a,b)=>b[1]-a[1])[0];
    if(best && best[1]>0){ team=best[0]; pct=(best[1]/N*100).toFixed(0)+'%'; }
  }
  return {label, team, pct};
}

/* Build ONE internally-consistent "favorite path" bracket: take the most-likely
   R32 occupants, then advance the winner of each match (the team that won it most
   often across the sims) into the next round. This guarantees the team shown
   advancing from a match actually appears in the downstream match — the full
   probabilistic spread still lives in the detail panel. */
function computePredictedBracket(){
  const sim = state.simResults;
  const occ = {}, winner = {};   // occ[id]=[topTeam,bottomTeam]; winner['M'+id]=advancing team
  if(!sim) return {occ, winner};
  const { N, matchWinCounts } = sim;
  const advance = (id, a, b) => {
    if(!a) return b; if(!b) return a;
    const w = matchWinCounts[id] || {};
    const wa = w[a]||0, wb = w[b]||0;
    if(wa === wb) return (state.teams[b]?.strength||0) > (state.teams[a]?.strength||0) ? b : a;
    return wb > wa ? b : a;
  };
  R32.forEach(([id,,,sA,sB]) => {
    const a = r32SlotLikely(sA, id, N).team, b = r32SlotLikely(sB, id, N).team;
    occ[id] = [a, b]; winner['M'+id] = advance(id, a, b);
  });
  const refTeam = ref => {
    if(ref.endsWith('-loser')){              // 3rd-place game pulls the SF losers
      const mid = ref.slice(0,-6), id = mid.slice(1);
      const [a,b] = occ[id] || [];
      return winner[mid] === a ? b : a;
    }
    return winner[ref];
  };
  [R16, QF, SF, FINAL].forEach(round => round.forEach(([id,,,rA,rB]) => {
    const a = refTeam(rA), b = refTeam(rB);
    occ[id] = [a, b]; winner['M'+id] = advance(id, a, b);
  }));
  return {occ, winner};
}

function renderBracket(){
  const c = document.getElementById('bracketContainer');
  c.innerHTML = '';
  const N = state.simResults?.N || 1;
  const predicted = computePredictedBracket();

  // Determine which matches are on which side of the bracket by walking the tree from the final.
  // Left half: feeds M101. Right half: feeds M102.
  // M101 = M97 vs M98 → M97 = M89+M90, M98 = M93+M94.
  //   Left R32: 74,77 (M89), 73,75 (M90), 83,84 (M93), 81,82 (M94)
  // M102 = M99 vs M100 → M99 = M91+M92, M100 = M95+M96.
  //   Right R32: 76,78 (M91), 79,80 (M92), 86,88 (M95), 85,87 (M96)
  const leftR32IDs  = ["74","77","73","75","83","84","81","82"];
  const rightR32IDs = ["76","78","79","80","86","88","85","87"];
  const leftR16IDs  = ["89","90","93","94"];
  const rightR16IDs = ["91","92","95","96"];
  const leftQFIDs   = ["97","98"];
  const rightQFIDs  = ["99","100"];
  const leftSFID    = "101";
  const rightSFID   = "102";
  const finalID     = "104";

  const byId = {};
  R32.forEach(m => byId[m[0]] = ['R32', m]);
  R16.forEach(m => byId[m[0]] = ['R16', m]);
  QF.forEach(m  => byId[m[0]] = ['QF', m]);
  SF.forEach(m  => byId[m[0]] = ['SF', m]);
  FINAL.forEach(m => byId[m[0]] = ['F', m]);

  // Build the bracket wrap
  const wrap = document.createElement('div');
  wrap.className = 'bracket-wrap';
  if(state.viewMode === 'left')  wrap.classList.add('show-left');
  if(state.viewMode === 'right') wrap.classList.add('show-right');
  const grid = document.createElement('div');
  grid.className = 'bracket-grid';

  const buildColumn = (label, ids, isFinal) => {
    const col = document.createElement('div');
    col.className = 'round-col' + (isFinal?' final-col':'');
    col.innerHTML = `<div class="round-label">${label}</div>`;
    ids.forEach(id => {
      const [round, m] = byId[id];
      col.appendChild(renderMatchCard(m, round, N, predicted));
    });
    return col;
  };

  // Left side (R32 → R16 → QF → SF) | Final | Right side (SF → QF → R16 → R32)
  grid.appendChild(buildColumn('R32 · Left', leftR32IDs));
  grid.appendChild(buildColumn('R16', leftR16IDs));
  grid.appendChild(buildColumn('QF', leftQFIDs));
  grid.appendChild(buildColumn('SF', [leftSFID]));

  const finalCol = document.createElement('div');
  finalCol.className = 'round-col final-col';
  finalCol.innerHTML = `<div class="round-label">Final · Jul 19</div><div class="trophy">★ Trophy ★</div>`;
  finalCol.appendChild(renderMatchCard(byId[finalID][1], 'F', N, predicted));
  // Add 3rd-place game beneath final
  const thirdPlace = renderMatchCard(byId["103"][1], 'F', N, predicted);
  thirdPlace.style.opacity = '0.65';
  thirdPlace.style.marginTop = '12px';
  finalCol.appendChild(Object.assign(document.createElement('div'),{
    innerHTML:`<div style="text-align:center;font-family:'DM Mono',monospace;font-size:9px;color:var(--muted);margin:18px 0 4px;text-transform:uppercase;letter-spacing:.1em">3rd Place · Jul 18</div>`
  }));
  finalCol.appendChild(thirdPlace);
  grid.appendChild(finalCol);

  grid.appendChild(buildColumn('SF', [rightSFID]));
  grid.appendChild(buildColumn('QF', rightQFIDs));
  grid.appendChild(buildColumn('R16', rightR16IDs));
  grid.appendChild(buildColumn('R32 · Right', rightR32IDs));

  wrap.appendChild(grid);
  c.appendChild(wrap);

  // Draw connecting lines via SVG overlay, then fit to viewport (drawBracketConnectors
  // measures in natural units and calls fitBracket() once the SVG is in place).
  drawBracketConnectors(wrap, grid);
}

function fitBracket(){
  const wrap = document.querySelector('.bracket-wrap');
  const viewport = document.getElementById('bracketViewport');
  if(!wrap || !viewport) return;
  // Reset scale to measure natural width
  wrap.style.transform = '';
  const natural = wrap.offsetWidth;
  const available = viewport.clientWidth;
  if(natural <= 0 || available <= 0) return;
  // Scale to exactly fill available width — both upscale and downscale.
  const scale = available / natural;
  wrap.style.transform = `scale(${scale})`;
  // Transform doesn't affect layout, so set viewport height manually to match
  const naturalHeight = wrap.offsetHeight;
  viewport.style.height = (naturalHeight * scale + 8) + 'px';
}

function drawBracketConnectors(wrap, grid){
  // Defer to the next frame so the latest layout (e.g. after a panel opens/closes)
  // has settled, then measure in natural (unscaled) units and draw. fitBracket() at
  // the end reapplies the scale to the whole wrap — SVG included — so the connectors
  // and the cards scale together and stay aligned at any zoom level.
  requestAnimationFrame(() => {
    wrap.style.transform = '';
    const oldSvg = wrap.querySelector('svg.connectors');
    if(oldSvg) oldSvg.remove();
    const rect = grid.getBoundingClientRect();
    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('class','connectors');
    svg.setAttribute('width', rect.width);
    svg.setAttribute('height', rect.height);
    svg.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:1';

    const matches = grid.querySelectorAll('.match[data-match]');
    const posMap = {};
    matches.forEach(m => {
      const r = m.getBoundingClientRect();
      // Skip elements that are hidden (display:none gives zero-size rects)
      if(r.width === 0 && r.height === 0) return;
      posMap[m.dataset.match] = {
        l: r.left - rect.left,
        r: r.right - rect.left,
        cy: (r.top + r.bottom)/2 - rect.top,
        t: r.top - rect.top,
        b: r.bottom - rect.top
      };
    });

    // Connect each later-round match to its 2 feeders
    const connect = (childId, feederA, feederB, side) => {
      const c = posMap[childId];
      const a = posMap[feederA];
      const b = posMap[feederB];
      if(!c || !a || !b) return;
      // For left side: feeders' right edge → child's left edge
      // For right side: feeders' left edge → child's right edge
      const xMid = side==='L' ? (a.r + c.l)/2 : (c.r + a.l)/2;
      const childAttach = side==='L' ? c.l : c.r;
      const feederAttachA = side==='L' ? a.r : a.l;
      const feederAttachB = side==='L' ? b.r : b.l;

      // Horizontal stubs from each feeder
      svg.innerHTML += `<line x1="${feederAttachA}" y1="${a.cy}" x2="${xMid}" y2="${a.cy}" stroke="#1a2236" stroke-width="1"/>`;
      svg.innerHTML += `<line x1="${feederAttachB}" y1="${b.cy}" x2="${xMid}" y2="${b.cy}" stroke="#1a2236" stroke-width="1"/>`;
      // Vertical between them
      svg.innerHTML += `<line x1="${xMid}" y1="${a.cy}" x2="${xMid}" y2="${b.cy}" stroke="#1a2236" stroke-width="1"/>`;
      // Horizontal from mid to child
      svg.innerHTML += `<line x1="${xMid}" y1="${c.cy}" x2="${childAttach}" y2="${c.cy}" stroke="#1a2236" stroke-width="1"/>`;
    };

    // Left side connections
    connect("89","74","77",'L');
    connect("90","73","75",'L');
    connect("93","83","84",'L');
    connect("94","81","82",'L');
    connect("97","89","90",'L');
    connect("98","93","94",'L');
    connect("101","97","98",'L');
    connect("104","101","102",'L'); // final attaches to both SFs

    // Right side connections
    connect("91","76","78",'R');
    connect("92","79","80",'R');
    connect("95","86","88",'R');
    connect("96","85","87",'R');
    connect("99","91","92",'R');
    connect("100","95","96",'R');
    connect("102","99","100",'R');

    wrap.appendChild(svg);
    // Reapply scaling now that the SVG is in place, scaling cards + connectors together.
    fitBracket();
  });
}

function renderMatchCard(m, round, N, predicted){
  const [id, venue, date, ...slots] = m;
  const matchId = id;
  const el = document.createElement('div');
  el.className = 'match';
  if(selectedMatchId === matchId) el.classList.add('selected');
  if(state.matchLocks[matchId]) el.classList.add('locked');
  el.dataset.match = matchId;

  const pairCounts = state.simResults?.matchPairCounts?.[matchId] || {};
  const h2h = state.simResults?.matchHeadToHead?.[matchId] || {};

  // Team appearance frequency
  const teamAppearance = {};
  Object.entries(pairCounts).forEach(([key,c]) => {
    const [a,b] = key.split('||');
    teamAppearance[a] = (teamAppearance[a]||0)+c;
    teamAppearance[b] = (teamAppearance[b]||0)+c;
  });
  // Team that advances from THIS match on the favorite path (used to mark the winner slot).
  const advWinner = predicted?.winner?.['M'+matchId];
  let slotsHtml;

  if(round === 'R32'){
    // R32 occupants are the most-likely team for each slot (deterministic from
    // group standings + Annex C). Same source the predicted path uses.
    slotsHtml = slots.map(s => {
      const { label, team, pct } = r32SlotLikely(s, matchId, N);
      return `
      <div class="slot ${team && team===advWinner?'adv':''}">
        <span class="slot-team ${team?'':'tbd'}">${team || label}</span>
        <span class="slot-prob">${pct}</span>
      </div>`;
    }).join('');
  } else {
    // R16+: show the favorite-path occupants — the winners of the two feeder
    // matches — so whoever is shown advancing here actually appears next round.
    // reach% = how often the team reaches this match across sims.
    // win%   = how often it advances given it got here (conditional).
    const [tA, tB] = predicted?.occ?.[matchId] || [];
    if(!tA || !tB){
      slotsHtml = `
        <div class="slot"><span class="slot-team tbd">TBD</span><span class="slot-prob"></span></div>
        <div class="slot"><span class="slot-team tbd">TBD</span><span class="slot-prob"></span></div>`;
    } else {
      const winCnt = state.simResults?.matchWinCounts?.[matchId] || {};
      const reachPct = t => ((teamAppearance[t]||0)/N*100).toFixed(0);
      const winPct   = t => (teamAppearance[t] ? (winCnt[t]||0)/teamAppearance[t]*100 : 0).toFixed(0);
      slotsHtml = [tA, tB].map(t => `
        <div class="slot ${t===advWinner?'adv':''}" title="${t} reaches this match ${reachPct(t)}% of sims; advances ${winPct(t)}% of the times it gets here">
          <span class="slot-team">${t}</span>
          <span class="slot-prob">${reachPct(t)}%·${winPct(t)}%</span>
        </div>`).join('');
    }
  }

  el.innerHTML = `
    <div class="m-meta"><span>M${matchId} · ${venue}</span><span>${date}</span></div>
    ${slotsHtml}
  `;
  el.addEventListener('click', () => {
    selectedMatchId = matchId;
    // Auto-open the detail panel
    const m = document.querySelector('main');
    if(!m.classList.contains('detail-open')){
      m.classList.add('detail-open');
      document.getElementById('detailRail').textContent = '▶';
      setTimeout(()=>{
        const wrap = document.querySelector('.bracket-wrap');
        const grid = document.querySelector('.bracket-grid');
        if(wrap && grid) drawBracketConnectors(wrap, grid);
      }, 300);
    }
    renderBracket();
    renderDetail();
  });
  return el;
}

/* =========================================================================
   RENDER — Detail panel
   ========================================================================= */
function renderDetail(){
  const panel = document.getElementById('detailPanel');
  const meta = document.getElementById('detailMatchId');
  if(!selectedMatchId){ return; }
  const id = selectedMatchId;
  meta.textContent = `M${id}`;

  // Find match metadata
  let matchMeta = null, round='';
  const findIn = (arr, r) => arr.find(m => m[0]===id) && (matchMeta = arr.find(m=>m[0]===id), round=r);
  findIn(R32,'R32'); if(!matchMeta) findIn(R16,'R16');
  if(!matchMeta) findIn(QF,'QF'); if(!matchMeta) findIn(SF,'SF'); if(!matchMeta) findIn(FINAL,'F');
  if(!matchMeta){ panel.innerHTML = '<div class="empty-state">Match not found.</div>'; return; }

  const [mid, venue, date] = matchMeta;
  const N = state.simResults.N;
  const winCounts = state.simResults.matchWinCounts[id] || {};
  const pairCounts = state.simResults.matchPairCounts[id] || {};

  // Team appearance frequency
  const appearance = {};
  Object.entries(pairCounts).forEach(([key,c]) => {
    const [a,b] = key.split('||');
    appearance[a] = (appearance[a]||0)+c;
    appearance[b] = (appearance[b]||0)+c;
  });
  const apprSorted = Object.entries(appearance).sort((a,b)=>b[1]-a[1]);

  // Top pairs
  const pairsSorted = Object.entries(pairCounts).sort((a,b)=>b[1]-a[1]).slice(0,10);

  const lock = state.matchLocks[id];

  let html = `
    <div class="detail-title">Match ${mid} · ${venue}</div>
    <div class="detail-sub">${date} 2026 · ${round}</div>

    <div class="detail-section">
      <h3>Teams most likely to play in this match</h3>
      <div class="ranklist">
        ${apprSorted.slice(0,12).map(([t,c],i) => {
          const pct = c/N*100;
          return `<div class="rank-row">
            <span class="rank-num">${i+1}</span>
            <span class="rank-team">${t}</span>
            <div class="rank-bar-wrap"><div class="rank-bar" style="width:${pct}%"></div><span class="rank-pct">${pct.toFixed(1)}%</span></div>
          </div>`;
        }).join('') || '<div class="empty-state">Run a sim first.</div>'}
      </div>
    </div>

    <div class="detail-section">
      <h3>Most likely pairings · with head-to-head win %</h3>
      <div class="pairlist">
        ${pairsSorted.map(([key,c])=>{
          const [a,b] = key.split('||');
          const pct = (c/N*100).toFixed(1);
          const h2h = state.simResults.matchHeadToHead?.[id]?.[key];
          let winLine = '';
          if(h2h && h2h.total > 0){
            const winA = (h2h[a]/h2h.total*100).toFixed(0);
            const winB = (h2h[b]/h2h.total*100).toFixed(0);
            winLine = `<span style="font-family:'DM Mono',monospace;font-size:9px;color:var(--muted);display:block">${a} wins ${winA}% · ${b} wins ${winB}%</span>`;
          }
          return `<div class="pair"><div><span class="pair-teams">${a} vs ${b}</span>${winLine}</div><span class="pair-pct">${pct}%</span></div>`;
        }).join('') || '<div class="empty-state">No data.</div>'}
      </div>
    </div>

    <div class="detail-section">
      <h3>Force winner (what-if)</h3>
      <div style="display:flex;flex-wrap:wrap;gap:4px">
        ${apprSorted.slice(0,8).map(([t]) => `
          <button class="btn ${lock===t?'primary':''}" data-lock-team="${t}">${t}</button>
        `).join('')}
        <button class="btn" data-lock-team="">Clear</button>
      </div>
    </div>
  `;
  panel.innerHTML = html;
  panel.querySelectorAll('button[data-lock-team]').forEach(b => {
    b.addEventListener('click', () => {
      const t = b.dataset.lockTeam;
      if(t) state.matchLocks[id] = t;
      else delete state.matchLocks[id];
      runSim(); renderAll();
    });
  });
}

/* =========================================================================
   ORCHESTRATION
   ========================================================================= */
function renderAll(){
  renderGroups();
  renderBracket();
  if(selectedMatchId) renderDetail();
}

document.getElementById('resimBtn').addEventListener('click', ()=>{ runSim(); renderAll(); });
document.getElementById('resetLocks').addEventListener('click', ()=>{
  Object.values(state.teams).forEach(t => t.lock=null);
  state.matchLocks = {};
  runSim(); renderAll();
});
document.getElementById('resetAll').addEventListener('click', ()=>{
  initState();
  state.matchLocks = {};
  fetchPolymarketOdds().then(()=>{ runSim(); renderAll(); });
});
document.getElementById('refetchBtn').addEventListener('click', ()=>{
  Object.values(state.teams).forEach(t => { if(!t.override) t.oddsSource='fallback'; });
  fetchPolymarketOdds().then(()=>{ runSim(); renderAll(); });
});
// Variance slider — show live value, debounce re-sim
const vSlider = document.getElementById('varianceSlider');
const vLabel  = document.getElementById('varianceVal');
let vTimer;
vSlider.addEventListener('input', e => {
  vLabel.textContent = parseFloat(e.target.value).toFixed(2);
  clearTimeout(vTimer);
  vTimer = setTimeout(()=>{ runSim(); renderAll(); }, 250);
});

// Side panel toggles — both panels collapsed by default
const mainEl = document.querySelector('main');
function redrawConnectorsSoon(){
  setTimeout(()=>{
    const wrap = document.querySelector('.bracket-wrap');
    const grid = document.querySelector('.bracket-grid');
    if(wrap && grid) drawBracketConnectors(wrap, grid);
  }, 300);
}
function setGroupsOpen(open){
  mainEl.classList.toggle('groups-open', open);
  document.getElementById('groupsRail').textContent = open ? '◀' : '▶';
  redrawConnectorsSoon();
}
function setDetailOpen(open){
  mainEl.classList.toggle('detail-open', open);
  document.getElementById('detailRail').textContent = open ? '▶' : '◀';
  redrawConnectorsSoon();
}
document.getElementById('groupsRail').addEventListener('click', () => {
  setGroupsOpen(!mainEl.classList.contains('groups-open'));
});
document.getElementById('groupsLabel').addEventListener('click', () => setGroupsOpen(true));
document.getElementById('detailRail').addEventListener('click', () => {
  setDetailOpen(!mainEl.classList.contains('detail-open'));
});
document.getElementById('detailLabel').addEventListener('click', () => setDetailOpen(true));

// Bracket view mode (LEFT / FULL / RIGHT)
function setViewMode(mode){
  state.viewMode = mode;
  ['viewLeft','viewFull','viewRight'].forEach(id => {
    document.getElementById(id).classList.remove('active');
  });
  const btnId = mode==='left'?'viewLeft':mode==='right'?'viewRight':'viewFull';
  document.getElementById(btnId).classList.add('active');
  renderBracket();
}
document.getElementById('viewLeft').addEventListener('click', ()=>setViewMode('left'));
document.getElementById('viewFull').addEventListener('click', ()=>setViewMode('full'));
document.getElementById('viewRight').addEventListener('click', ()=>setViewMode('right'));

// README modal
const readmeModal = document.getElementById('readmeModal');
document.getElementById('openReadme').addEventListener('click', () => {
  readmeModal.classList.add('open');
});
document.getElementById('closeReadme').addEventListener('click', () => {
  readmeModal.classList.remove('open');
});
readmeModal.addEventListener('click', (e) => {
  if(e.target === readmeModal) readmeModal.classList.remove('open');
});
document.addEventListener('keydown', (e) => {
  if(e.key === 'Escape') readmeModal.classList.remove('open');
});

// On resize: redraw connectors, re-fit bracket, auto-switch mode if needed
let resizeTimer;
let wasOnMobile = false;
// Threshold below which we auto-switch from FULL to LEFT half-view.
// Full bracket has natural width ~1400px; below ~720px viewport the cards
// become too small to read even when scaled.
const HALF_VIEW_THRESHOLD = 720;
function isNarrow(){ return window.innerWidth < HALF_VIEW_THRESHOLD; }
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(()=>{
    const nowNarrow = isNarrow();
    if(nowNarrow && state.viewMode === 'full'){
      // Entered narrow viewport: auto-switch to half view
      setViewMode('left');
      wasOnMobile = true;
      return;
    }
    if(!nowNarrow && wasOnMobile){
      // Left narrow viewport: restore full view
      setViewMode('full');
      wasOnMobile = false;
      return;
    }
    // Otherwise just redraw + refit
    const wrap = document.querySelector('.bracket-wrap');
    const grid = document.querySelector('.bracket-grid');
    if(wrap && grid) drawBracketConnectors(wrap, grid);
  }, 200);
});

// Default to LEFT view on narrow viewports
if(isNarrow()){
  state.viewMode = 'left';
  wasOnMobile = true;
  document.getElementById('viewFull').classList.remove('active');
  document.getElementById('viewLeft').classList.add('active');
}

// Pre-select Match 94 (Seattle, July 6 R16) since that's what user asked about
selectedMatchId = '94';

initState();
runSim();
renderAll();
// Then try live fetch
fetchPolymarketOdds().then(()=>{ runSim(); renderAll(); });
