// signal.js — SERVER-SIDE SIGNAL COMPUTATION
// The server fetches history, runs the full spike predictor engine,
// and returns a COMPLETE, READY-TO-DISPLAY signal object.
// Every client in the world gets the EXACT same result.

const WebSocket = require('ws')

// ── MATH UTILITIES ────────────────────────────────────────────────────────
function ema(arr, p) {
  const k = 2 / (p + 1); let v = arr[0]
  for (let i = 1; i < arr.length; i++) v = arr[i] * k + v * (1 - k)
  return v
}
function stddev(arr) {
  const m = arr.reduce((s, v) => s + v, 0) / arr.length
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length)
}
function rollingAtr(prices, p = 20) {
  if (prices.length < p + 1) return 0.0001
  const r = []
  for (let i = prices.length - p; i < prices.length; i++)
    r.push(Math.abs(prices[i] - prices[i - 1]))
  return r.reduce((s, v) => s + v, 0) / p
}
function swings(prices, lb = 10) {
  const H = [], L = []
  for (let i = lb; i < prices.length - lb; i++) {
    const sl = prices.slice(i - lb, i + lb + 1)
    if (prices[i] === Math.max(...sl)) H.push({ i, p: prices[i] })
    if (prices[i] === Math.min(...sl)) L.push({ i, p: prices[i] })
  }
  return { H, L }
}

// ── SPIKE DETECTOR ────────────────────────────────────────────────────────
function detectSpikes(prices, type, thresh = 0.35) {
  const spikes = []
  for (let i = 1; i < prices.length; i++) {
    const pct = Math.abs((prices[i] - prices[i - 1]) / prices[i - 1]) * 100
    if (pct >= thresh) {
      const dir = prices[i] > prices[i - 1] ? 'UP' : 'DOWN'
      const valid = (type === 'boom' && dir === 'UP') || (type === 'crash' && dir === 'DOWN')
      if (valid) spikes.push({ idx: i, price: prices[i], dir, pct: +pct.toFixed(3) })
    }
  }
  return spikes
}

// ── 5-LAYER SPIKE PREDICTOR ENGINE ────────────────────────────────────────
function spikePredictor(prices, spikes, avg, type) {
  const n = prices.length
  const isBoom = type === 'boom'

  // ticks since last spike
  const lastSpikeIdx = spikes.length > 0 ? spikes[spikes.length - 1].idx : 0
  const since = n - 1 - lastSpikeIdx

  // Layer 1: Geometric probability (tick cycle)
  const geo = Math.min(99, Math.round((1 - Math.pow(1 - 1 / avg, since)) * 100))

  // Layer 2: Volatility compression (short ATR vs long ATR)
  const atrS = rollingAtr(prices.slice(-10), 10)
  const atrL = rollingAtr(prices.slice(-60), 60)
  const volRatio = atrL > 0 ? atrS / atrL : 1
  const volScore = Math.min(100, Math.round((1 - Math.min(volRatio, 1.5) / 1.5) * 100))
  const compressed = volRatio < 0.65

  // Layer 3: Directional drift toward spike direction
  const w30 = prices.slice(-30)
  const driftDir = isBoom ? 1 : -1
  let driftTicks = 0
  for (let i = 1; i < w30.length; i++) {
    if ((w30[i] - w30[i - 1]) * driftDir > 0) driftTicks++
  }
  const driftScore = Math.round((driftTicks / (w30.length - 1)) * 100)

  // Layer 4: Mean reversion z-score stretch
  const w100 = prices.slice(-100)
  const mean100 = w100.reduce((s, v) => s + v, 0) / w100.length
  const sd100 = stddev(w100)
  const zScore = sd100 > 0 ? (prices[n - 1] - mean100) / sd100 : 0
  const revStretch = isBoom ? Math.max(0, -zScore) : Math.max(0, zScore)
  const meanScore = Math.min(100, Math.round(revStretch * 33))

  // Layer 5: Counter-move exhaustion
  const counterDir = isBoom ? -1 : 1
  let exhaustCount = 0
  for (let i = n - 1; i > n - 20 && i > 0; i--) {
    if ((prices[i] - prices[i - 1]) * counterDir > 0) exhaustCount++
    else break
  }
  const exhaustScore = Math.min(100, exhaustCount * 12)

  // Composite (weighted average)
  const composite = Math.min(99, Math.round(
    geo * 0.30 + volScore * 0.25 + driftScore * 0.20 + meanScore * 0.15 + exhaustScore * 0.10
  ))

  // Zone
  const hotConds = [geo >= 80, compressed, driftScore >= 55, composite >= 72].filter(Boolean).length
  let zone, zc
  if      (composite >= 80 && hotConds >= 3) { zone = 'FIRE'; zc = '#ff4500' }
  else if (composite >= 70 && hotConds >= 2) { zone = 'HOT';  zc = '#fff176' }
  else if (composite >= 55)                   { zone = 'WARM'; zc = '#ffab00' }
  else if (composite >= 35)                   { zone = 'BUILDING'; zc = '#00fff7' }
  else                                         { zone = 'EARLY'; zc = '#1a3050' }

  // Pre-spike alert: 3+ layers hot AND composite >= 72
  const layersHot = [geo>=75, volScore>=60, driftScore>=60, meanScore>=40, exhaustScore>=36].filter(Boolean).length
  const alert = composite >= 72 && layersHot >= 3

  return { since, geo, volScore, driftScore, meanScore, exhaustScore, composite, zone, zc, alert, compressed, zScore: +zScore.toFixed(2), atrS: +atrS.toFixed(6), atrL: +atrL.toFixed(6), layersHot }
}

// ── MARKET STRUCTURE ──────────────────────────────────────────────────────
function marketStructure(prices) {
  const { H, L } = swings(prices, 10)
  if (H.length < 2 || L.length < 2) return { trend: 'NEUTRAL', HH: false, HL: false, LH: false, LL: false, bos: false }
  const lH = H.slice(-2), lL = L.slice(-2)
  const HH = lH[1].p > lH[0].p, HL = lL[1].p > lL[0].p
  const LH = lH[1].p < lH[0].p, LL = lL[1].p < lL[0].p
  const trend = (HH && HL) ? 'BULLISH' : (LH && LL) ? 'BEARISH' : 'NEUTRAL'
  const c = prices[prices.length - 1]
  const bos = trend === 'BULLISH' ? c > lH[0].p : trend === 'BEARISH' ? c < lL[0].p : false
  return { trend, HH, HL, LH, LL, bos }
}

// ── MAIN COMPUTE ──────────────────────────────────────────────────────────
function compute(prices, spikes, inst) {
  if (prices.length < 100) return null
  const n = prices.length
  const c = prices[n - 1]
  const pred = spikePredictor(prices, spikes, inst.avg, inst.type)
  const ms   = marketStructure(prices)
  const at   = rollingAtr(prices, 20)
  const isBoom = inst.type === 'boom'
  const spikeBull = isBoom

  // EMA
  const e20 = ema(prices.slice(-Math.min(n, 200)), 20)
  const e50 = ema(prices.slice(-Math.min(n, 400)), 50)

  // ROC
  const roc = n >= 50 ? ((prices[n-1]-prices[n-50])/prices[n-50])*100 : 0

  // Post-spike setup
  let ps = null
  if (spikes.length > 0) {
    const lastSpike = spikes[spikes.length - 1]
    const ago = n - 1 - lastSpike.idx
    const ret = ((c - lastSpike.price) / lastSpike.price) * 100
    const good = isBoom ? (ret < -0.03 && ret > -0.6) : (ret > 0.03 && ret < 0.6)
    const q = ago < 40 && good ? 'PRIME' : ago < 80 ? 'GOOD' : ago < 180 ? 'FAIR' : 'STALE'
    ps = { ago, spPrice: +lastSpike.price.toFixed(5), ret: +ret.toFixed(4), q }
  }

  // Score
  let score = 0
  const confs = []

  if      (pred.composite >= 80) { score += spikeBull ? 7 : -7;   confs.push({ t: `🔥 FIRE ZONE — Composite ${pred.composite}% — SPIKE IMMINENT`, b: spikeBull }) }
  else if (pred.composite >= 70) { score += spikeBull ? 5 : -5;   confs.push({ t: `⚡ HOT — Composite ${pred.composite}%`, b: spikeBull }) }
  else if (pred.composite >= 55) { score += spikeBull ? 3 : -3;   confs.push({ t: `WARM — Composite ${pred.composite}%`, b: spikeBull }) }
  else if (pred.composite >= 35) { score += spikeBull ? 1 : -1;   confs.push({ t: `BUILDING — Composite ${pred.composite}%`, b: spikeBull }) }

  if (pred.compressed)         confs.push({ t: `Volatility compressed (${(pred.atrS/pred.atrL*100).toFixed(0)}% of avg) — pre-spike squeeze`, b: spikeBull })
  if (pred.driftScore >= 65)   confs.push({ t: `Strong drift ${pred.driftScore}% toward spike direction`, b: spikeBull })
  if (pred.meanScore >= 50)    confs.push({ t: `Mean reversion stretch z=${pred.zScore}`, b: spikeBull })
  if (pred.exhaustScore >= 60) confs.push({ t: `Counter-move exhaustion`, b: spikeBull })

  if (ps) {
    const psBull = inst.type === 'crash'
    if (ps.q === 'PRIME') { score += psBull ? 4 : -4; confs.push({ t: `PRIME post-spike (${ps.ago} ticks, ${Math.abs(ps.ret).toFixed(3)}% retrace)`, b: psBull }) }
    else if (ps.q === 'GOOD') { score += psBull ? 2.5 : -2.5; confs.push({ t: `GOOD post-spike (${ps.ago} ticks)`, b: psBull }) }
  }

  if (ms.trend === 'BULLISH') { score += 1.5; confs.push({ t: 'Bullish structure HH+HL', b: true }) }
  if (ms.trend === 'BEARISH') { score -= 1.5; confs.push({ t: 'Bearish structure LH+LL', b: false }) }
  if (ms.bos && ms.trend === 'BULLISH') { score += 1; confs.push({ t: 'Bullish BOS confirmed', b: true }) }
  if (ms.bos && ms.trend === 'BEARISH') { score -= 1; confs.push({ t: 'Bearish BOS confirmed', b: false }) }
  if (c > e20 && e20 > e50) { score += 0.5; confs.push({ t: 'EMA stack bullish', b: true }) }
  if (c < e20 && e20 < e50) { score -= 0.5; confs.push({ t: 'EMA stack bearish', b: false }) }

  const conf = Math.min(97, Math.round((Math.abs(score) / 18) * 100))
  const dir  = score >= 5 ? 'BUY' : score <= -5 ? 'SELL' : 'WAIT'
  const sl   = dir === 'BUY' ? +(c - at * 10).toFixed(5) : +(c + at * 10).toFixed(5)
  const tp1  = dir === 'BUY' ? +(c + at * 12).toFixed(5) : +(c - at * 12).toFixed(5)
  const tp2  = dir === 'BUY' ? +(c + at * 25).toFixed(5) : +(c - at * 25).toFixed(5)
  const tp3  = dir === 'BUY' ? +(c + at * 42).toFixed(5) : +(c - at * 42).toFixed(5)
  const rr   = +((Math.abs(tp2 - c)) / (Math.abs(sl - c) || 0.0001)).toFixed(1)

  // Recent spikes for display (last 10)
  const recentSpikes = spikes.slice(-10).reverse().map(sp => ({
    price: sp.price.toFixed(5),
    idx: sp.idx,
    dir: sp.dir,
    pct: sp.pct
  }))

  return {
    dir, score: +score.toFixed(1), conf,
    price: +c.toFixed(5), sl, tp1, tp2, tp3, rr,
    at: +at.toFixed(6),
    e20: +e20.toFixed(5), e50: +e50.toFixed(5),
    roc: +roc.toFixed(3),
    pred, ms, ps, confs,
    recentSpikes,
    prices: prices.slice(-300),  // last 300 for chart
    spikeIdxs: spikes.slice(-20).map(s => s.idx - (prices.length - 300)), // mapped to chart window
  }
}

// ── FETCH FROM DERIV ─────────────────────────────────────────────────────
function fetchFromDeriv(symbol, count, anchoredEnd) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error('Timeout 9s')) }
    }, 9000)

    let ws
    try { ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089') }
    catch (e) { clearTimeout(timer); return reject(e) }

    ws.on('open', () => {
      ws.send(JSON.stringify({
        ticks_history: symbol,
        count,
        end: anchoredEnd,
        style: 'ticks',
        adjust_start_time: 1,
      }))
    })
    ws.on('message', raw => {
      if (settled) return
      let d
      try { d = JSON.parse(raw) } catch (e) { settled = true; clearTimeout(timer); ws.close(); return reject(e) }
      if (d.msg_type === 'history') {
        settled = true; clearTimeout(timer)
        try { ws.close() } catch (_) {}
        resolve(d.history)
      }
      if (d.error) {
        settled = true; clearTimeout(timer)
        try { ws.close() } catch (_) {}
        reject(new Error(d.error.message + ' [' + d.error.code + ']'))
      }
    })
    ws.on('error', e => { if (!settled) { settled = true; clearTimeout(timer); reject(e) } })
    ws.on('close', () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('WS closed')) } })
  })
}

// ── HANDLER ───────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    // Cache for 10 seconds so rapid refreshes from many devices reuse same result
    'Cache-Control': 'public, max-age=10, stale-while-revalidate=5',
  }
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' }

  const symbol = (event.queryStringParameters?.symbol || 'BOOM500').toUpperCase()
  const INST = {
    BOOM500:   { name: 'Boom 500',   type: 'boom',  avg: 500,  thresh: 0.35 },
    CRASH1000: { name: 'Crash 1000', type: 'crash', avg: 1000, thresh: 0.35 },
    CRASH300:  { name: 'Crash 300',  type: 'crash', avg: 300,  thresh: 0.35 },
  }
  const inst = INST[symbol]
  if (!inst) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown symbol: ' + symbol }) }

  // Anchor to 10-second boundary — all devices in same 10s window get identical data
  const now = Math.floor(Date.now() / 1000)
  const anchoredEnd = Math.floor(now / 10) * 10

  try {
    const history = await fetchFromDeriv(symbol, 500, anchoredEnd)
    const prices  = history.prices.map(Number)
    const spikes  = detectSpikes(prices, inst.type, inst.thresh)
    const signal  = compute(prices, spikes, inst)

    if (!signal) return { statusCode: 200, headers, body: JSON.stringify({ error: 'Not enough data yet', ok: false }) }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, symbol, anchor: anchoredEnd, signal })
    }
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: e.message, ok: false }) }
  }
}
