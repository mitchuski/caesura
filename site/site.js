const SUITE_TITLE = { 'ed25519': 'ed25519 signed', 'mldsa65-ed25519': 'ML-DSA-65 + ed25519', 'slhdsa-sha2-128s-ed25519': 'SLH-DSA + ed25519' };
// Caesura — the star in its lattice and manifold, two seats in orbit pausing at the
// caesura; and the board, read live from NEAR testnet in the browser.
// Geometry and colours follow the agentprivacy Star Key figure (two tetrahedra, the 64-point
// lattice, the shell rings). No framework, no build.
(function () {
  'use strict'
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // ---------------------------------------------------------------- the verse line
  var a = document.getElementById('half-a'), b = document.getElementById('half-b')
  if (a && b) {
    if (reduce) { a.classList.add('lit'); b.classList.add('lit') }
    else { var step = 0; var tick = function () { step = (step + 1) % 4; a.classList.toggle('lit', step === 1 || step === 3); b.classList.toggle('lit', step === 3) }; tick(); setInterval(tick, 1400) }
  }

  // ---------------------------------------------------------------- the star figure
  var MAGE = [232, 82, 58], SWORD = [77, 217, 232] /* the mage proposes (coral), the sword checks (cyan) */, PALE = [240, 238, 232], VIOLET = [183, 156, 255]
  var PHI = (1 + Math.sqrt(5)) / 2
  var TET_A = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]]
  var TET_B = TET_A.map(function (v) { return [-v[0], -v[1], -v[2]] })
  var EDGES = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]]
  var CORE = 0.6
  var scaleTo = function (vs, r) { var k = r / Math.hypot(vs[0][0], vs[0][1], vs[0][2]); return vs.map(function (v) { return [v[0] * k, v[1] * k, v[2] * k] }) }
  var SWORD_V = scaleTo(TET_A, CORE), MAGE_V = scaleTo(TET_B, CORE)
  var LATTICE = (function () {
    var gen = [[0, 1, PHI], [0, 1, -PHI], [1, PHI, 0], [1, -PHI, 0], [PHI, 0, 1], [PHI, 0, -1]].map(function (v) { var l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l] })
    var raw = [], max = 0
    for (var x = 0; x < 64; x++) { var p = [0, 0, 0]; for (var bb = 0; bb < 6; bb++) { var s = ((x >> bb) & 1) - 0.5; for (var i = 0; i < 3; i++) p[i] += s * gen[bb][i] } raw.push(p); max = Math.max(max, Math.hypot(p[0], p[1], p[2])) }
    return raw.map(function (p) { return [p[0] * 0.8 / max, p[1] * 0.8 / max, p[2] * 0.8 / max] })
  })()
  var SHELL = (function () {
    var R = 1.18, eps = 0.07, m = 5, n = 6, rings = []
    var pt = function (phi, th) { var r = R + eps * Math.sin(m * phi) * Math.cos(n * th); return [r * Math.sin(phi) * Math.cos(th), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(th)] }
    for (var i = 1; i < 8; i++) { var phi = i / 8 * Math.PI, ring = []; for (var j = 0; j <= 96; j++) ring.push(pt(phi, j / 96 * Math.PI * 2)); rings.push(ring) }
    for (var k = 0; k < 12; k++) { var th = k / 12 * Math.PI * 2, ring2 = []; for (var j2 = 0; j2 <= 48; j2++) ring2.push(pt(j2 / 48 * Math.PI, th)); rings.push(ring2) }
    return rings
  })()
  var rgba = function (c, al) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + Math.max(0, Math.min(1, al)) + ')' }

  var canvas = document.getElementById('star')
  if (canvas && canvas.getContext) (function () {
    var ctx = canvas.getContext('2d')
    var yaw = 5.5, pitch = 1.08, w = 0, h = 0, dpr = 1, dragging = false, lx = 0, ly = 0, t0 = performance.now(), auto = !reduce
    var fit = function () { var r = canvas.getBoundingClientRect(); dpr = Math.min(2, window.devicePixelRatio || 1); w = Math.max(1, r.width); h = Math.max(1, r.height); canvas.width = w * dpr; canvas.height = h * dpr }
    fit(); window.addEventListener('resize', fit)
    var proj = function (p, cy, sy, cp, sp) {
      var x = p[0] * cy - p[2] * sy, z = p[0] * sy + p[2] * cy, y = p[1] * cp - z * sp; z = p[1] * sp + z * cp
      var s = Math.min(w, h) * 0.33, f = 1 / (1 + z * 0.18)
      return { x: w / 2 + x * s * f, y: h / 2 - y * s * f, z: z, f: f }
    }
    var line = function (p, q, col, al, lw) { ctx.strokeStyle = rgba(col, al); ctx.lineWidth = lw; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke() }
    var glow = function (q, col, r, al) { var g = ctx.createRadialGradient(q.x, q.y, 0, q.x, q.y, r * 2.4); g.addColorStop(0, rgba(col, al)); g.addColorStop(0.45, rgba(col, al * 0.45)); g.addColorStop(1, rgba(col, 0)); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(q.x, q.y, r * 2.4, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = rgba(col, al); ctx.beginPath(); ctx.arc(q.x, q.y, r * 0.55, 0, Math.PI * 2); ctx.fill() }
    // the orbit: two seats on a ring tilted against the star; each pauses at its caesura
    // mark (the two bars), then goes on. The gate is the pause.
    var orbitPoint = function (t) { var R = 1.05; return [R * Math.cos(t), R * 0.28 * Math.sin(t), R * Math.sin(t)] }
    var ease = function (u) { return u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2 }
    // one revolution in 12 s; a 1.6 s hold at the caesura (angle PI/2 for the proposer, 3PI/2 for the assayer)
    var seatAngle = function (ms, offset) { var T = 12000, H = 1600, u = ((ms + offset) % T) / T; var goT = (T - H) / T; if (u < goT) return Math.PI / 2 + ease(u / goT) * Math.PI * 2 * 0.999; return Math.PI / 2 }
    var draw = function (now) {
      var ms = now - t0
      if (auto && !dragging) { yaw = 5.5 + 0.28 * Math.sin(ms / 1000 * 0.45); pitch = 1.08 + 0.1 * Math.sin(ms / 1000 * 0.31 + 1) }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h)
      var cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch)
      var P = function (p) { return proj(p, cy, sy, cp, sp) }
      // manifold
      ctx.lineWidth = 0.7
      SHELL.forEach(function (ring, ri) { ctx.strokeStyle = rgba(ri < 7 ? SWORD : MAGE, 0.13); ctx.beginPath(); ring.forEach(function (p, i) { var q = P(p); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y) }); ctx.stroke() })
      // lattice (gray code ring + points)
      for (var x = 0; x < 64; x++) { var q1 = P(LATTICE[x]), q2 = P(LATTICE[(x + 1) % 64]); line(q1, q2, PALE, 0.08, 0.6) }
      LATTICE.map(function (p) { return P(p) }).sort(function (u, v) { return u.z - v.z }).forEach(function (q) { ctx.fillStyle = rgba(PALE, 0.28 + 0.3 * (1 - (q.z + 1) / 2)); ctx.beginPath(); ctx.arc(q.x, q.y, 1.6 * q.f, 0, Math.PI * 2); ctx.fill() })
      // the star: two tetrahedra
      EDGES.forEach(function (e) { line(P(SWORD_V[e[0]]), P(SWORD_V[e[1]]), MAGE, 0.85, 1.6); line(P(MAGE_V[e[0]]), P(MAGE_V[e[1]]), SWORD, 0.85, 1.6) })
      glow(P([0, 0, 0]), PALE, 3, 0.9)
      // orbit ring + caesura marks
      ctx.strokeStyle = rgba(VIOLET, 0.35); ctx.lineWidth = 1; ctx.setLineDash([3, 6]); ctx.beginPath()
      for (var i = 0; i <= 120; i++) { var q = P(orbitPoint(i / 120 * Math.PI * 2)); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y) }
      ctx.stroke(); ctx.setLineDash([])
      ;[Math.PI / 2, Math.PI * 1.5].forEach(function (ang, k) { var c = orbitPoint(ang), q = P(c), col = k ? SWORD : MAGE; var dx = 4 * q.f; line({ x: q.x - dx, y: q.y - 9 * q.f }, { x: q.x - dx, y: q.y + 9 * q.f }, col, 0.9, 2); line({ x: q.x + dx, y: q.y - 9 * q.f }, { x: q.x + dx, y: q.y + 9 * q.f }, col, 0.9, 2) })
      // the seats
      var ap = seatAngle(reduce ? 0 : ms, 0), aa = seatAngle(reduce ? 0 : ms, 6000) + Math.PI
      var sP = P(orbitPoint(ap)), sA = P(orbitPoint(aa))
      line(sP, P([0, 0, 0]), MAGE, 0.18, 0.8); line(sA, P([0, 0, 0]), SWORD, 0.18, 0.8)
      glow(sP, MAGE, 5 * sP.f, 0.95); glow(sA, SWORD, 5 * sA.f, 0.95)
      requestAnimationFrame(draw)
    }
    canvas.addEventListener('pointerdown', function (e) { dragging = true; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId) })
    canvas.addEventListener('pointermove', function (e) { if (!dragging) return; yaw += (e.clientX - lx) * 0.01; pitch = Math.max(-1.4, Math.min(1.4, pitch + (e.clientY - ly) * 0.01)); lx = e.clientX; ly = e.clientY })
    canvas.addEventListener('pointerup', function () { dragging = false; auto = false })
    requestAnimationFrame(draw)
  })()

  // ---------------------------------------------------------------- the board (live)
  var RPC = { testnet: 'https://test.rpc.fastnear.com', mainnet: 'https://free.rpc.fastnear.com' }
  var EXPLORER = { testnet: 'https://testnet.nearblocks.io', mainnet: 'https://nearblocks.io' }
  function view(network, gate, method, args) {
    return fetch(RPC[network] || RPC.testnet, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'caesura', method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: gate, method_name: method, args_base64: btoa(JSON.stringify(args || {})) } }) })
      .then(function (r) { return r.json() })
      .then(function (j) { if (j.error) throw new Error(j.error.data || j.error.message || 'rpc'); var bytes = j.result.result; var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return JSON.parse(decodeURIComponent(escape(s))) })
  }
  var NEAR = function (yocto) { try { var n = BigInt(yocto); return (Number(n / 1000000000000000000000n) / 1000).toFixed(3).replace(/\.?0+$/, '') } catch (e) { return '?' } }
  var el = function (tag, cls, text) { var d = document.createElement(tag); if (cls) d.className = cls; if (text != null) d.textContent = text; return d }
  var live = document.getElementById('live'), tiles = document.getElementById('tiles'), gatesEl = document.getElementById('gates'), roundsEl = document.getElementById('rounds'), roundsGate = document.getElementById('rounds-gate')
  if (!live) return
  var txByRound = {}, metaByRound = {}
  var rootsLoaded = fetch('roots.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : [] }).then(function (rows) { (rows || []).forEach(function (r) { var name = String(r.round || '').split(' · ')[0]; txByRound[name] = r.tx; metaByRound[name] = r }) }).catch(function () {})

  function classify(p) {
    var s = String(p.status || '').toLowerCase(); var why = p.refusal || ''
    var caught = s === 'refused' && /^(verdict|receiver|method|cap_action|cap_day|cooldown)/.test(why)
    var by = s !== 'refused' ? '' : /^verdict/.test(why) ? 'assayer' : /^paused/.test(why) ? 'owner' : 'gate'
    var kind = s !== 'refused' ? '' : /^verdict/.test(why) ? 'verdict' : why.split(':')[0]
    return { status: s, why: why, caught: caught, by: by, kind: kind, value: s === 'refused' ? p.action.deposit : '0' }
  }
  var addY = function (a, b) { try { return (BigInt(a) + BigInt(b)).toString() } catch (e) { return a } }
  function loadGate(g) {
    return Promise.all([view(g.network, g.id, 'get_state', {}), view(g.network, g.id, 'list_proposals', { from: 0, limit: 200 }), view(g.network, g.id, 'list_roots', { from: 0, limit: 200 })])
      .then(function (r) {
        var state = r[0], props = r[1], roots = r[2]
        var exec = 0, ref = 0, caught = 0, held = '0', byA = 0, byG = 0, byO = 0, kinds = {}
        props.forEach(function (p) { var c = classify(p); if (c.status === 'executed') exec++; if (c.status === 'refused') { ref++; held = addY(held, c.value); kinds[c.kind] = (kinds[c.kind] || 0) + 1 } if (c.caught) caught++; if (c.by === 'assayer') byA++; if (c.by === 'gate') byG++; if (c.by === 'owner') byO++ })
        return { gate: g, state: state, props: props, roots: roots, exec: exec, ref: ref, caught: caught, held: held, byA: byA, byG: byG, byO: byO, kinds: kinds, ok: true }
      })
      .catch(function (e) { return { gate: g, ok: false, err: e.message, props: [], roots: [], exec: 0, ref: 0, caught: 0, held: '0', byA: 0, byG: 0, byO: 0, kinds: {} } })
  }
  function renderTiles(all) {
    var t = { gates: all.filter(function (x) { return x.ok }).length, rounds: 0, exec: 0, ref: 0, caught: 0, roots: 0, held: '0', byA: 0, byG: 0, byO: 0 }
    all.forEach(function (x) { t.rounds += x.props.length; t.exec += x.exec; t.ref += x.ref; t.caught += x.caught; t.roots += x.roots.length; t.held = addY(t.held, x.held); t.byA += x.byA; t.byG += x.byG; t.byO += x.byO })
    tiles.innerHTML = ''
    ;[['gates live', t.gates, ''], ['rounds', t.rounds, ''], ['executed', t.exec, 'ok'], ['refused', t.ref, 'no'], ['value held (NEAR)', NEAR(t.held), 'no'], ['held by assayer', t.byA, ''], ['held by gate', t.byG, ''], ['held by owner', t.byO, ''], ['attested rounds', Object.keys(metaByRound).filter(function (k) { return metaByRound[k].attested }).length, 'ok'], ['roots on-chain', t.roots, '']].forEach(function (x) { var d = el('div', 'tile ' + x[2]); d.appendChild(el('div', 'v', String(x[1]))); d.appendChild(el('div', 'l', x[0])); tiles.appendChild(d) })
  }
  function renderGates(all, selected) {
    gatesEl.innerHTML = ''
    var head = el('div', 'row'); ['gate', 'rounds', 'executed', 'refused', 'held', 'value held', 'roots', 'spent today'].forEach(function (h) { head.appendChild(el('span', null, h)) }); gatesEl.appendChild(head)
    all.forEach(function (x) {
      var row = el('div', 'row' + (x.gate.id === selected ? ' sel' : ''))
      var id = el('span', 'id', x.gate.id); id.appendChild(el('small', null, x.ok ? (x.gate.label || '') + ' · owner ' + (x.state.owner || x.gate.owner) + (x.state.paused ? ' · paused' : '') : 'unreachable: ' + x.err)); row.appendChild(id)
      row.appendChild(el('span', null, String(x.props.length))); row.appendChild(el('span', 'ok', String(x.exec))); row.appendChild(el('span', 'no', String(x.ref))); row.appendChild(el('span', null, String(x.caught))); row.appendChild(el('span', 'no', NEAR(x.held) + ' Ⓝ')); row.appendChild(el('span', null, String(x.roots.length)))
      row.appendChild(el('span', null, x.ok ? NEAR(x.state.spent_today) + ' Ⓝ' : '—'))
      row.addEventListener('click', function () { renderGates(all, x.gate.id); renderRounds(x) })
      gatesEl.appendChild(row)
    })
  }
  function renderRounds(x) {
    roundsGate.textContent = x.gate.id
    roundsEl.innerHTML = ''
    if (!x.props.length) { var ph = el('div', 'row placeholder'); ph.appendChild(el('span', null, 'no rounds yet')); roundsEl.appendChild(ph); return }
    var rootById = {}; x.roots.forEach(function (r) { rootById[r.proposal_id] = r })
    x.props.slice().reverse().forEach(function (p) {
      var c = classify(p), root = rootById[p.id], row = el('div', 'row')
      row.appendChild(el('span', null, '#' + p.id))
      var meta = root && metaByRound[root.round]
      row.appendChild(el('span', 'st ' + c.status, c.status + (c.by ? ' · ' + c.by : '') + (meta && meta.attested ? ' · attested' : '') + (meta && meta.signed ? ' · ' + (SUITE_TITLE[meta.signed] || meta.signed) : '') + (meta && meta.cost_usd != null ? ' · $' + meta.cost_usd.toFixed(4) : '')))
      if (meta && meta.ceremony) { var cer = el('span', 'cer ' + meta.ceremony, '⿻ ceremony · ' + meta.ceremony); cer.title = (meta.ceremony === 'transfer' ? 'a seat moved suite: signed by the owner and countersigned by the keys it leaves' : 'the owner vouched for the seat keys') + ' · owner ' + (SUITE_TITLE[meta.owner_signed] || meta.owner_signed || ''); row.lastChild.appendChild(cer) }
      var why = el('span', 'why', (c.why ? c.why : ('→ ' + p.action.receiver_id + ' · ' + NEAR(p.action.deposit) + ' Ⓝ' + (p.action.method_name ? ' · ' + p.action.method_name : ''))) + (root ? ' · ' + root.round : '')); row.appendChild(why)
      var k = el('span', 'k', root ? root.root.slice(0, 23) + '…' : 'no root'); k.title = root ? root.root : ''; row.appendChild(k)
      var tx = el('span', 'tx'); var hash = root && txByRound[root.round]
      var link = el('a', null, hash ? 'tx' : 'gate'); link.href = hash ? EXPLORER[x.gate.network] + '/txns/' + hash : EXPLORER[x.gate.network] + '/address/' + x.gate.id; link.target = '_blank'; link.rel = 'noopener'; tx.appendChild(link); row.appendChild(tx)
      roundsEl.appendChild(row)
    })
  }
  rootsLoaded.then(function () { return fetch('gates.json', { cache: 'no-store' }) }).then(function (r) { return r.json() }).then(function (gates) {
    return Promise.all(gates.map(loadGate)).then(function (all) {
      var okN = all.filter(function (x) { return x.ok }).length
      live.className = 'live ' + (okN ? 'ok' : 'err'); live.innerHTML = '<span class="dot"></span> ' + (okN ? 'live · ' + okN + ' of ' + all.length + ' gates read from testnet' : 'could not reach testnet')
      renderTiles(all); renderGates(all, all[0] && all[0].gate.id); if (all[0]) renderRounds(all[0])
    })
  }).catch(function (e) { live.className = 'live err'; live.innerHTML = '<span class="dot"></span> board unavailable: ' + e.message })
})()

// ---------------------------------------------------------------- the gap, measured (board.json)
;(function () {
  var live = document.getElementById('research-live'), curveEl = document.getElementById('curve'), noteEl = document.getElementById('curve-note'), frontEl = document.getElementById('front'), matrixEl = document.getElementById('matrix')
  if (!live) return
  var el = function (tag, cls, text) { var d = document.createElement(tag); if (cls) d.className = cls; if (text != null) d.textContent = text; return d }
  var LEVELS = ['policy + proposal', '+ the task', '+ the rationale', '+ the tool results', '+ the full prompt']
  var usd = function (x) { return x == null ? '' : '$' + x.toFixed(4) }
  function chip(r, withGap) {
    var c = el('span', 'chip ' + r.outcome)
    if (withGap && r.gap !== 1) c.appendChild(el('span', 'g', 'g' + r.gap))
    c.appendChild(document.createTextNode(r.outcome + (r.held_by ? ' · ' + r.held_by : '')))
    if (r.cost_usd != null) c.appendChild(el('span', 'c', usd(r.cost_usd)))
    return c
  }
  function renderCurve(b) {
    var rows = (b.studies && b.studies.gap) || []
    curveEl.innerHTML = ''
    var head = el('div', 'row'); head.appendChild(el('span', null, 'attack · seats'))
    LEVELS.forEach(function (l, i) { var s = el('span', null, 'g' + i); s.appendChild(el('span', 'lv', l)); head.appendChild(s) }); curveEl.appendChild(head)
    var groups = {}, order = []
    rows.forEach(function (r) { var k = r.task_id + '|' + r.pair_id; if (!groups[k]) { groups[k] = {}; order.push(k) } groups[k][r.gap] = r })
    if (!order.length) { var ph = el('div', 'row placeholder'); ph.appendChild(el('span', null, 'no study rounds yet')); curveEl.appendChild(ph); return }
    var held = 0, drained = 0
    order.forEach(function (k) {
      var row = el('div', 'row'), parts = k.split('|'), id = el('span', 'id', parts[0])
      var pair = (b.pairs || []).filter(function (p) { return p.pair_id === parts[1] })[0]
      id.appendChild(el('small', null, pair ? pair.title : parts[1])); row.appendChild(id)
      for (var g = 0; g < 5; g++) { var r = groups[k][g], s = el('span'); if (r) { s.appendChild(chip(r)); if (r.outcome === 'held') held++; if (r.outcome === 'drained') drained++ } else s.appendChild(el('span', 'chip none', '—')); row.appendChild(s) }
      curveEl.appendChild(row)
    })
    // one sentence per assayer, from the data: which levels it held at and which it drained at
    var byPair = {}, pairOrder = []
    rows.forEach(function (r) { if (!byPair[r.pair_id]) { byPair[r.pair_id] = {}; pairOrder.push(r.pair_id) } var L = byPair[r.pair_id][r.gap] || (byPair[r.pair_id][r.gap] = { held: 0, drained: 0 }); if (r.outcome === 'held') L.held++; if (r.outcome === 'drained') L.drained++ })
    function span(gs) { if (!gs.length) return ''; var out = [], a = gs[0], b = gs[0]; for (var i = 1; i <= gs.length; i++) { if (i < gs.length && gs[i] === b + 1) { b = gs[i]; continue } out.push(a === b ? 'g' + a : 'g' + a + '–g' + b); a = gs[i]; b = gs[i] } return out.join(', ') }
    var sentences = pairOrder.map(function (pid) {
      var pair = (b.pairs || []).filter(function (p) { return p.pair_id === pid })[0], name = pair ? pair.assayer.replace(/^.*\//, '') : pid
      var heldAt = [], drainedAt = []; for (var g = 0; g < 5; g++) { var L = byPair[pid][g]; if (!L) continue; if (L.drained) drainedAt.push(g); else if (L.held) heldAt.push(g) }
      var parts = []; if (heldAt.length) parts.push('held at ' + span(heldAt)); if (drainedAt.length) parts.push('drained at ' + span(drainedAt))
      return name + ' ' + parts.join(', ') + '.'
    })
    noteEl.textContent = 'A proposer poisoned by construction hands the second seat a redirect that the policy allows. With nothing but the policy and the proposal (g0) no second seat can know, and the gate pays. Once the task crosses (g1) the seat can hold; what happens as the rationale, the poison itself and the whole prompt cross is the curve. ' + sentences.join(' ') + ' Held ' + held + ' of ' + (held + drained) + '. The gap is what protects the seat that can be talked to; the cost of the pause grows with what crosses.'
  }
  function renderFront(b) {
    frontEl.innerHTML = ''
    var head = el('div', 'row'); ['seat pair', 'rounds', 'attacks', 'drained', 'held', 'not taken', 'honest passed', 'cost / round', 'attested'].forEach(function (h) { head.appendChild(el('span', null, h)) }); frontEl.appendChild(head)
    var rows = (b.front || []).slice().sort(function (x, y) { return (x.drained - y.drained) || (y.attacks_run - x.attacks_run) || (y.rounds - x.rounds) })
    rows.forEach(function (f) {
      var row = el('div', 'row'), id = el('span', 'id', f.title); id.appendChild(el('small', null, f.driver + ' · entered by ' + (f.entered_by || '—'))); row.appendChild(id)
      row.appendChild(el('span', null, String(f.rounds))); row.appendChild(el('span', null, String(f.attacks_run)))
      row.appendChild(el('span', f.drained ? 'nbad' : 'ngood', String(f.drained)))
      var hb = f.held_by || {}; var h = el('span', 'ngood', String(f.held)); h.title = 'assayer ' + (hb.assayer || 0) + ' · gate ' + (hb.gate || 0) + ' · owner ' + (hb.owner || 0); row.appendChild(h)
      row.appendChild(el('span', f.not_taken ? 'ngood' : 'n0', String(f.not_taken)))
      row.appendChild(el('span', f.blocked ? 'nbad' : '', f.honest_passed + ' / ' + f.honest_run))
      row.appendChild(el('span', null, f.cost_per_round == null ? '—' : usd(f.cost_per_round)))
      row.appendChild(el('span', f.attested ? 'ngood' : 'n0', f.attested + ' / ' + f.rounds))
      frontEl.appendChild(row)
    })
  }
  function renderMatrix(b) {
    matrixEl.innerHTML = ''
    var pairs = (b.front || []).map(function (f) { return f.pair_id })
    matrixEl.style.setProperty('--pairs', String(pairs.length))
    var head = el('div', 'row'); head.appendChild(el('span', null, 'attack · channel'))
    pairs.forEach(function (p) { var f = b.front.filter(function (x) { return x.pair_id === p })[0]; head.appendChild(el('span', null, f ? f.title : p)) }); matrixEl.appendChild(head)
    var tasks = (b.corpus || []).slice().sort(function (x, y) { return (x.kind === 'attack' ? 0 : 1) - (y.kind === 'attack' ? 0 : 1) })
    tasks.forEach(function (t) {
      var row = el('div', 'row'), id = el('span', 'id', t.title || t.task_id)
      id.appendChild(el('small', null, (t.kind === 'attack' ? 'attack · ' + t.channel + (t.within_policy ? ' · inside the policy' : ' · outside the policy') : 'honest · ' + t.channel))); row.appendChild(id)
      pairs.forEach(function (p) {
        var cell = el('span'), rs = ((b.matrix || {})[t.task_id] || {})[p] || []
        if (!rs.length) cell.appendChild(el('span', 'chip none', '·'))
        rs.forEach(function (r) { cell.appendChild(chip(r, true)); cell.appendChild(document.createTextNode(' ')) })
        row.appendChild(cell)
      })
      matrixEl.appendChild(row)
    })
  }
  fetch('board.json', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('board.json ' + r.status); return r.json() }).then(function (b) {
    live.className = 'live ok'; live.innerHTML = '<span class="dot"></span> ' + (b.rounds || []).length + ' rounds · ' + (b.front || []).length + ' seat pairs · ' + (b.corpus || []).length + ' tasks in the corpus · index minted ' + b.minted
    renderCurve(b); renderFront(b); renderMatrix(b)
  }).catch(function (e) { live.className = 'live err'; live.innerHTML = '<span class="dot"></span> index unavailable: ' + e.message })
})()
