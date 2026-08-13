const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function err(message, status = 400) {
  return json({ error: message }, status);
}

async function getSession(request, env) {
  const token = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const session = await env.SESSIONS.get(`session:${token}`);
  if (!session) return null;
  return JSON.parse(session);
}

function generateId() {
  return crypto.randomUUID().replace(/-/g, '');
}

// ══════════════════════════════════════════════════════════════════
// Progressive backfill: walks back through SkyCofl a slice at a time,
// driven by the same 1/min cron. ~9 requests per tick, far under the
// 30-per-10s / 100-per-min limits.
// ══════════════════════════════════════════════════════════════════
const SEYMOUR_RELEASE = Date.parse('2023-02-01T00:00:00Z');
const BF_TAGS = ['VELVET_TOP_HAT','CASHMERE_JACKET','SATIN_TROUSERS','OXFORD_SHOES'];

async function getMeta(env, k, dflt) {
  const r = await env.DB.prepare(`SELECT v FROM seymour_meta WHERE k = ?`).bind(k).first();
  return r && r.v !== null && r.v !== undefined ? r.v : dflt;
}
async function setMeta(env, k, v) {
  await env.DB.prepare(
    `INSERT INTO seymour_meta (k,v) VALUES (?,?)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(k, String(v)).run();
}

async function backfillStep(env, budget) {
  await ensureSales(env);
  if (budget === undefined) {
    budget = parseInt(await getMeta(env, 'bf_budget', '6'), 10) || 40;
  }
  budget = Math.min(Math.max(budget, 1), 20);   // +1 list request stays under the 50-subrequest cap
  

  let ti   = parseInt(await getMeta(env, 'bf_tag_index', '0'), 10) || 0;
  let page = parseInt(await getMeta(env, 'bf_page', '0'), 10) || 0;
  if (ti >= BF_TAGS.length) return { done: true };
  const tag = BF_TAGS[ti];

  // Honour a cooldown: if Coflnet blocked us, do not touch them again until it expires.
  const blockedUntil = parseInt(await getMeta(env, 'cofl_blocked_until', '0'), 10) || 0;
  if (blockedUntil > Date.now()) {
    return { blocked: true, until: blockedUntil,
             retryInMin: Math.ceil((blockedUntil - Date.now()) / 60000) };
  }

  const listRes = await fetch(
    `https://sky.coflnet.com/api/auctions/tag/${tag}/sold?page=${page}&pageSize=100`);

  if (listRes.status === 403 || listRes.status === 429) {
    const body = await listRes.text().catch(() => '');
    // 403 = IP ban. Back off hard (6h) so we stop making it worse.
    const cool = listRes.status === 403 ? 6 * 3600e3 : 15 * 60e3;
    await setMeta(env, 'cofl_blocked_until', Date.now() + cool);
    await setMeta(env, 'cofl_block_reason', (body || String(listRes.status)).slice(0, 400));
    return { blocked: true, status: listRes.status, cooldownMs: cool };
  }
  if (!listRes.ok) return { ok: false, status: listRes.status, tag, page };
  const list = await listRes.json();

  // Page empty -> this tag is exhausted, move to the next one
  if (!Array.isArray(list) || list.length === 0) {
    await setMeta(env, 'bf_tag_index', ti + 1);
    await setMeta(env, 'bf_page', 0);
    await setMeta(env, 'bf_offset', 0);
    await setMeta(env, 'bf_last_result', JSON.stringify(
      { at: Date.now(), tag, page, listed: 0, note: 'page empty -> moved to next piece' }));
    return { tagFinished: tag, next: BF_TAGS[ti + 1] || null };
  }

  let offset = parseInt(await getMeta(env, 'bf_offset', '0'), 10) || 0;
  if (offset >= list.length) offset = 0;

  let stored = 0, spent = 0, oldest = null, skippedNoColour = 0, alreadyHad = 0, skippedNoDate = 0;
  let sampleSaved = false;

  // Oldest end date on this page, regardless of what we manage to store.
  for (const a of list) {
    const end = Date.parse(a.end || '') || 0;
    if (end && (!oldest || end < oldest)) oldest = end;
  }

  // Walk forward from the saved offset. The cursor ALWAYS advances past
  // whatever we looked at, so a run of failures can never stall the page.
  let i = offset;
  for (; i < list.length; i++) {
    if (spent >= budget) break;
    const a = list[i];
    const seen = await env.DB.prepare(
      `SELECT 1 FROM seymour_sales WHERE auction_uuid = ?`).bind(a.uuid).first();
    if (seen) { alreadyHad++; continue; }

    spent++;
    let dRes;
    try { dRes = await fetch(`https://sky.coflnet.com/api/auction/${a.uuid}`); }
    catch (e) { continue; }
    if (dRes.status === 403) {
      await setMeta(env, 'cofl_blocked_until', Date.now() + 6 * 3600e3);
      await setMeta(env, 'cofl_block_reason', 'detail 403');
      i--; break;
    }
    if (dRes.status === 429) { i--; break; }          // back off, retry this one next tick
    if (!dRes.ok) { skippedNoColour++; continue; }
    const d = await dRes.json();
    const flat = d.flatNbt || d.flatNBT || {};
    let hex = '', uid = '', how = '';

    for (const k of ['color','Color','colour','Colour']) {
      if (flat[k] !== undefined && flat[k] !== null) { hex = String(flat[k]); how = 'flatNbt.' + k; break; }
    }
    // some responses nest it under the item's own NBT display tag
    if (!hex && d.nbtData && d.nbtData.data) {
      const disp = d.nbtData.data.display || d.nbtData.data.Display;
      if (disp && (disp.color !== undefined)) { hex = String(disp.color); how = 'nbtData.display.color'; }
    }
    for (const k of ['uid','uId','uuid','Uuid']) { if (flat[k]) { uid = String(flat[k]); break; } }

    if (!hex) {
      const bytes = d.itemBytes || d.item_bytes || d.bytes ||
                    (d.itemBytes && d.itemBytes.data) || '';
      if (bytes && typeof bytes === 'string') {
        const sey = await seymourFromBytes(bytes);
        if (sey) { hex = sey.hex; how = 'itemBytes'; if (!uid) uid = sey.uid || ''; }
      }
    }

    if (!hex) {
      skippedNoColour++;
      // keep one real example so we can see what the response actually looks like
      if (!sampleSaved) {
        sampleSaved = true;
        await setMeta(env, 'bf_sample', JSON.stringify({
          uuid: a.uuid, topKeys: Object.keys(d).slice(0, 30),
          flatNbtKeys: d.flatNbt ? Object.keys(d.flatNbt).slice(0, 30) : null,
          flatNbtSample: d.flatNbt || null, end: d.end
        }).slice(0, 1500));
      }
      continue;
    }

    hex = String(hex).replace('#','').trim().toUpperCase();
    if (/^-?[0-9]{1,10}$/.test(hex)) hex = (parseInt(hex, 10) >>> 0).toString(16).toUpperCase();
    hex = hex.padStart(6, '0').slice(-6);
    if (!/^[0-9A-F]{6}$/.test(hex)) { skippedNoColour++; continue; }
    uid = uid.replace(/-/g, '').toLowerCase().slice(-12);

    const buyer = (d.bids && d.bids.length) ? d.bids[d.bids.length-1].bidder : '';
    const soldAt = Date.parse(d.end || '') || Date.parse(a.end || '') || 0;
    if (!soldAt) { skippedNoDate++; continue; }   // real sale date or nothing
    await env.DB.prepare(
      `INSERT OR IGNORE INTO seymour_sales
       (auction_uuid,item_id,item_uid,hex,price,bin,seller,buyer,sold_at,source)
       VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .bind(a.uuid, tag, uid, hex, d.highestBidAmount || a.highestBidAmount || 0,
            d.bin ? 1 : 0, d.auctioneerId || '', buyer, soldAt, 'coflnet').run();
    stored++;
    if (spent < budget && i + 1 < list.length) await new Promise(r => setTimeout(r, 1200));
  }

  // Advance: finished the page -> next page; otherwise remember where we got to.
  if (i >= list.length) {
    await setMeta(env, 'bf_page', page + 1);
    await setMeta(env, 'bf_offset', 0);
  } else {
    await setMeta(env, 'bf_offset', i);
  }

  await setMeta(env, 'bf_last_run', Date.now());
  await setMeta(env, 'bf_last_result', JSON.stringify(
    { at: Date.now(), tag, page, offset, nextOffset: i >= list.length ? 0 : i,
      listed: list.length, newFetched: spent, stored, alreadyHad, skippedNoColour, skippedNoDate, oldest,
      note: spent === 0 ? 'page already fully archived'
          : skippedNoColour > 0 ? skippedNoColour + ' of ' + spent + ' had no readable colour'
          : 'ok' }));
  return { ok: true, tag, page, stored, examined: list.length, oldest, budget };
}

// ══════════════════════════════════════════════════════════════════
// Seymour: minimal NBT reader (gzip + base64 -> item colour + id)
// ══════════════════════════════════════════════════════════════════
const SEYMOUR_TAGS = new Set(['VELVET_TOP_HAT','CASHMERE_JACKET','SATIN_TROUSERS','OXFORD_SHOES']);

async function gunzipB64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function nbtParse(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  const str = () => { const n = dv.getUint16(p); p += 2;
    const s = new TextDecoder().decode(buf.subarray(p, p + n)); p += n; return s; };
  function payload(type) {
    switch (type) {
      case 1:  { const v = dv.getInt8(p);    p += 1; return v; }
      case 2:  { const v = dv.getInt16(p);   p += 2; return v; }
      case 3:  { const v = dv.getInt32(p);   p += 4; return v; }
      case 4:  { const v = Number(dv.getBigInt64(p)); p += 8; return v; }
      case 5:  { const v = dv.getFloat32(p); p += 4; return v; }
      case 6:  { const v = dv.getFloat64(p); p += 8; return v; }
      case 7:  { const n = dv.getInt32(p); p += 4; const a = buf.subarray(p, p + n); p += n; return a; }
      case 8:  return str();
      case 9:  { const t = dv.getInt8(p); p += 1; const n = dv.getInt32(p); p += 4;
                 const a = []; for (let i = 0; i < n; i++) a.push(payload(t)); return a; }
      case 10: { const o = {}; for (;;) { const t = dv.getInt8(p); p += 1; if (t === 0) break;
                 const k = str(); o[k] = payload(t); } return o; }
      case 11: { const n = dv.getInt32(p); p += 4; const a = [];
                 for (let i = 0; i < n; i++) { a.push(dv.getInt32(p)); p += 4; } return a; }
      case 12: { const n = dv.getInt32(p); p += 4; const a = [];
                 for (let i = 0; i < n; i++) { a.push(Number(dv.getBigInt64(p))); p += 8; } return a; }
      default: throw new Error('bad NBT tag ' + type);
    }
  }
  const t = dv.getInt8(p); p += 1;
  if (t !== 10) throw new Error('root not compound');
  str();
  return payload(10);
}

// Pull { id, hex } out of an auction's item_bytes; null if not Seymour
async function seymourFromBytes(itemBytes) {
  try {
    const root = nbtParse(await gunzipB64(itemBytes));
    const item = root?.i?.[0];
    if (!item) return null;
    const id = item.tag?.ExtraAttributes?.id;
    if (!id || !SEYMOUR_TAGS.has(id)) return null;
    const colour = item.tag?.display?.color;
    if (typeof colour !== 'number') return null;
    const iu = item.tag?.ExtraAttributes?.uuid || '';
    return { id, itemUuid: String(iu),
             hex: (colour >>> 0).toString(16).padStart(6, '0').toUpperCase().slice(-6) };
  } catch (e) { return null; }
}




async function ensureSales(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS seymour_sales (
    auction_uuid TEXT PRIMARY KEY,
    item_id TEXT, hex TEXT, item_uuid TEXT, price INTEGER, bin INTEGER,
    seller TEXT, buyer TEXT, sold_at INTEGER, source TEXT
  )`).run();
  try { await env.DB.prepare(`ALTER TABLE seymour_sales ADD COLUMN item_uuid TEXT`).run(); } catch (e) {}
  try { await env.DB.prepare(`ALTER TABLE seymour_sales ADD COLUMN source TEXT`).run(); } catch (e) {}
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_sales_item ON seymour_sales(item_uuid)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_sales_hex  ON seymour_sales(hex)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_sales_time ON seymour_sales(sold_at DESC)`).run();
}

// Polled once a minute by the cron trigger
async function pollEndedAuctions(env) {
  await ensureSales(env);
  const res = await fetch('https://api.hypixel.net/skyblock/auctions_ended');
  if (!res.ok) return { ok: false, status: res.status };
  const data = await res.json();
  const list = data.auctions || [];
  const rows = [];
  for (const a of list) {
    if (!a.item_bytes) continue;
    const sey = await seymourFromBytes(a.item_bytes);
    if (!sey) continue;
    rows.push([a.auction_id, sey.id, sey.hex, sey.itemUuid, a.price | 0, a.bin ? 1 : 0,
               a.seller || '', a.buyer || '', a.timestamp || Date.now(), 'hypixel']);
  }
  for (const r of rows) {
    try {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO seymour_sales
         (auction_uuid,item_id,hex,item_uuid,price,bin,seller,buyer,sold_at,source)
         VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(...r).run();
    } catch (e) {}
  }
  return { ok: true, scanned: list.length, stored: rows.length };
}


export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try { await ensureSales(env); } catch (e) {}
      try { await pollEndedAuctions(env); }
      catch (e) { try { await setMeta(env, 'poll_error', String(e && e.message || e)); } catch (_) {} }
      try {
        const r = await backfillStep(env);
        await setMeta(env, 'bf_error', '');
        await setMeta(env, 'bf_tick', JSON.stringify({ at: Date.now(), r }).slice(0, 900));
      } catch (e) {
        try { await setMeta(env, 'bf_error', String(e && e.message || e)); } catch (_) {}
      }
    })());
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // ── Bazaar proxy ───────────────────────────────────────────────────
    if (url.pathname === '/bazaar') {
      const resp = await fetch('https://api.hypixel.net/skyblock/bazaar');
      const data = await resp.json();
      return json(data);
    }

    // ── Auth: exchange MC-ID code for session ──────────────────────────
    if (url.pathname === '/auth/token' && request.method === 'POST') {
      const body = await request.json();
      const { code, code_verifier } = body;
      const redirectUri = body.redirect_uri || env.MCID_REDIRECT_URI;
      if (!code || !code_verifier) return err('Missing code or code_verifier');

      const tokenRes = await fetch('https://mc-id.com/api/auth/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: env.MCID_CLIENT_ID,
          client_secret: env.MCID_CLIENT_SECRET,
          redirect_uri: redirectUri,
          code_verifier,
        }),
      });

      const tokens = await tokenRes.json();
      if (!tokens.access_token) return err('Token exchange failed: ' + JSON.stringify(tokens));

      const profileRes = await fetch('https://mc-id.com/api/auth/oauth2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const profile = await profileRes.json();

      const account = profile.accounts?.find(a => a.primary) || profile.accounts?.[0];
      if (!account?.uuid) return err('No Minecraft account linked on MC-ID');

      const now = Date.now();

      await env.DB.prepare(`
        INSERT INTO users (uuid, sub, username, discord, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(uuid) DO UPDATE SET
          username = excluded.username,
          discord = excluded.discord,
          updated_at = excluded.updated_at
      `).bind(account.uuid, profile.sub, account.username, null, now, now).run();

      const sessionToken = generateId() + generateId();
      await env.SESSIONS.put(
        `session:${sessionToken}`,
        JSON.stringify({ uuid: account.uuid, username: account.username, sub: profile.sub }),
        { expirationTtl: 60 * 60 * 24 * 30 },
      );

      const urow = await env.DB.prepare(`SELECT discord FROM users WHERE uuid = ?`).bind(account.uuid).first();
      return json({ token: sessionToken, user: { uuid: account.uuid, username: account.username,
                                                 discord: (urow && urow.discord) || '' } });
    }

    // ── Auth: get current user ─────────────────────────────────────────
    if (url.pathname === '/auth/me' && request.method === 'GET') {
      const session = await getSession(request, env);
      if (!session) return err('Unauthorised', 401);
      return json({ user: session });
    }

    // ── Auth: logout ───────────────────────────────────────────────────
    if (url.pathname === '/auth/logout' && request.method === 'POST') {
      const token = request.headers.get('Authorization')?.replace('Bearer ', '');
      if (token) await env.SESSIONS.delete(`session:${token}`);
      return json({ ok: true });
    }

    // ── User preferences: get ──────────────────────────────────────────
    if (url.pathname === '/users/preferences' && request.method === 'GET') {
      const session = await getSession(request, env);
      if (!session) return err('Unauthorised', 401);
      try { await env.DB.prepare(`ALTER TABLE users ADD COLUMN preferences TEXT`).run(); } catch(e) {}
      const user = await env.DB.prepare(
        `SELECT preferences FROM users WHERE uuid = ?`
      ).bind(session.uuid).first();
      try {
        return json({ prefs: JSON.parse(user?.preferences || 'null') });
      } catch(e) {
        return json({ prefs: null });
      }
    }

    // ── User preferences: save ─────────────────────────────────────────
    if (url.pathname === '/users/preferences' && request.method === 'PUT') {
      const session = await getSession(request, env);
      if (!session) return err('Unauthorised', 401);
      try { await env.DB.prepare(`ALTER TABLE users ADD COLUMN preferences TEXT`).run(); } catch(e) {}
      const body = await request.json();
      await env.DB.prepare(
        `UPDATE users SET preferences = ? WHERE uuid = ?`
      ).bind(JSON.stringify(body), session.uuid).run();
      return json({ ok: true });
    }

    // ── Listings: get all ──────────────────────────────────────────────
    if (url.pathname === '/listings' && request.method === 'GET') {
      const cat = url.searchParams.get('cat');
      const q = url.searchParams.get('q');
      const sort = url.searchParams.get('sort') || 'newest';
      const status = url.searchParams.get('status') || 'active';

      let query = `SELECT * FROM listings WHERE status = ?`;
      const params = [status];

      if (cat && cat !== 'all') {
        query += ` AND cat = ?`;
        params.push(cat);
      }

      if (q) {
        query += ` AND (armour_type LIKE ? OR set_name LIKE ? OR ign LIKE ?)`;
        const like = `%${q}%`;
        params.push(like, like, like);
      }

      const orderMap = {
        newest: 'ts DESC', oldest: 'ts ASC',
        'price-asc': 'price ASC', 'price-desc': 'price DESC',
      };
      query += ` ORDER BY ${orderMap[sort] || 'ts DESC'} LIMIT 200`;

      const { results } = await env.DB.prepare(query).bind(...params).all();
      return json({ listings: results.map(r => ({ ...r, pieces: JSON.parse(r.pieces || '[]'), scuffness: r.scuffness ? JSON.parse(r.scuffness) : null, updated_at: r.updated_at || null })) });
    }

    // ── Listings: stats ────────────────────────────────────────────────
    if (url.pathname === '/listings/stats' && request.method === 'GET') {
      const [active, users, sold, messages] = await Promise.all([
        env.DB.prepare(`SELECT COUNT(*) as n FROM listings WHERE status = 'active'`).first(),
        env.DB.prepare(`SELECT COUNT(*) as n FROM users`).first(),
        env.DB.prepare(`SELECT COUNT(*) as n FROM listings WHERE status = 'sold'`).first(),
        env.DB.prepare(`SELECT SUM(messages_sent) as n FROM users`).first(),
      ]);
      return json({ active: active.n, users: users.n, sold: sold.n, messages: messages.n || 0 });
    }

    // ── Listings: create ───────────────────────────────────────────────
    if (url.pathname === '/listings' && request.method === 'POST') {
      const body = await request.json();
      const { armourType, setName, pieces, cat, catLabel, price, proof, notes, ign: bodyIgn } = body;

      if (!armourType || !pieces?.length) {
        return err('Missing required fields');
      }

      const session = await getSession(request, env);
      const finalIgn = session?.username || bodyIgn;
      const finalUuid = session?.uuid || null;
      if (!finalIgn) return err('IGN required');

      const id = generateId();
      const now = Date.now();

      const { forOffers, pageId, currentOffer, currentOfferIgn, boughtFor, scuffness } = body;
      // Try to add columns if they don't exist yet (D1 ignores errors on existing columns)
      try { await env.DB.prepare(`ALTER TABLE listings ADD COLUMN for_offers INTEGER DEFAULT 0`).run(); } catch(e) {}
      try { await env.DB.prepare(`ALTER TABLE listings ADD COLUMN page_id TEXT`).run(); } catch(e) {}
      try { await env.DB.prepare(`ALTER TABLE listings ADD COLUMN scuffness TEXT`).run(); } catch(e) {}
      try { await env.DB.prepare(`ALTER TABLE listings ADD COLUMN current_offer TEXT`).run(); } catch(e) {}
      try { await env.DB.prepare(`ALTER TABLE listings ADD COLUMN current_offer_ign TEXT`).run(); } catch(e) {}
      try { await env.DB.prepare(`ALTER TABLE listings ADD COLUMN bought_for TEXT`).run(); } catch(e) {}

      await env.DB.prepare(`
        INSERT INTO listings
          (id, uuid, ign, armour_type, set_name, pieces, cat, cat_label, price, proof, notes, status, ts, for_offers, page_id, current_offer, current_offer_ign, bought_for, scuffness)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id, finalUuid, finalIgn, armourType, setName || '',
        JSON.stringify(pieces), cat || 'exotic', catLabel || 'Exotic',
        price || 0, proof || '', notes || '', now,
        forOffers ? 1 : 0, pageId || null,
        currentOffer || '', currentOfferIgn || '', boughtFor || '',
        scuffness ? JSON.stringify(scuffness) : null
      ).run();



      return json({ id, ok: true }, 201);
    }

    // ── Listings: mark sold ────────────────────────────────────────────
    if (url.pathname.match(/^\/listings\/[a-f0-9]+\/sold$/) && request.method === 'PUT') {
      const session = await getSession(request, env);
      if (!session) return err('Unauthorised', 401);
      const id = url.pathname.split('/')[2];
      try { await env.DB.prepare(`ALTER TABLE listings ADD COLUMN updated_at INTEGER`).run(); } catch(e) {}
      const listing = await env.DB.prepare(`SELECT uuid FROM listings WHERE id = ?`).bind(id).first();
      if (!listing) return err('Not found', 404);
      if (listing.uuid !== session.uuid) return err('Forbidden', 403);
      await env.DB.prepare(`UPDATE listings SET status = 'sold', sold_at = ? WHERE id = ?`).bind(Date.now(), id).run();
      return json({ ok: true });
    }

    // ── Listings: delete ───────────────────────────────────────────────
    if (url.pathname.match(/^\/listings\/[a-f0-9]+\/delete$/) && request.method === 'PUT') {
      const session = await getSession(request, env);
      if (!session) return err('Unauthorised', 401);
      const id = url.pathname.split('/')[2];
      const listing = await env.DB.prepare(`SELECT uuid FROM listings WHERE id = ?`).bind(id).first();
      if (!listing) return err('Not found', 404);
      if (listing.uuid !== session.uuid) return err('Forbidden', 403);
      await env.DB.prepare(`UPDATE listings SET status = 'deleted' WHERE id = ?`).bind(id).run();
      return json({ ok: true });
    }

    // ── Listings: toggle for_offers ────────────────────────────────────
    if (url.pathname.match(/^\/listings\/[a-f0-9]+\/offers$/) && request.method === 'PUT') {
      const session = await getSession(request, env);
      if (!session) return err('Unauthorised', 401);
      const id = url.pathname.split('/')[2];
      const listing = await env.DB.prepare(`SELECT uuid FROM listings WHERE id = ?`).bind(id).first();
      if (!listing) return err('Not found', 404);
      if (listing.uuid !== session.uuid) return err('Forbidden', 403);
      const body = await request.json();
      const forOffers = body.for_offers ? 1 : 0;
      try { await env.DB.prepare(`ALTER TABLE listings ADD COLUMN for_offers INTEGER DEFAULT 0`).run(); } catch(e) {}
      await env.DB.prepare(`UPDATE listings SET for_offers = ? WHERE id = ?`).bind(forOffers, id).run();
      return json({ ok: true });
    }

    // ── Offers + chat creation ─────────────────────────────────────────
    if (url.pathname === '/offers' && request.method === 'POST') {
      const body = await request.json();
      const { listingId, buyerIgn, amount, message } = body;
      if (!listingId || !buyerIgn) return err('Missing required fields');

      const listing = await env.DB.prepare(
        `SELECT * FROM listings WHERE id = ? AND status = 'active'`
      ).bind(listingId).first();
      if (!listing) return err('Listing not found', 404);

      const session = await getSession(request, env);
      const offerId = generateId();
      const chatId = generateId();
      const now = Date.now();

      await env.DB.prepare(`
        INSERT INTO offers (id, listing_id, buyer_uuid, buyer_ign, amount, message, ts)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(offerId, listingId, session?.uuid || null, buyerIgn, amount, message || '', now).run();

      await env.DB.prepare(`
        INSERT INTO chats (id, listing_id, seller_uuid, seller_ign, buyer_uuid, buyer_ign, offer_amount, offer_message, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(chatId, listingId, listing.uuid, listing.ign, session?.uuid || null, buyerIgn, amount, message || '', now).run();

      await env.DB.prepare(`
        INSERT INTO messages (id, chat_id, sender_uuid, sender_ign, content, image_url, ts)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(generateId(), chatId, session?.uuid || buyerIgn, buyerIgn, `__offer__:${amount}:${message || ''}`, null, now).run();

      return json({ offerId, chatId, ok: true }, 201);
    }

    // ── Chats: get all (active or archived) ───────────────────────────
    if (url.pathname === '/chats' && request.method === 'GET') {
      const session = await getSession(request, env);
      if (!session) return err('Unauthorised', 401);

      const archived = url.searchParams.get('archived') === '1';

      let whereClause;
      if (archived) {
        whereClause = `((c.seller_uuid = ? AND c.archived_seller = 1) OR (c.buyer_uuid = ? AND c.archived_buyer = 1))`;
      } else {
        whereClause = `(c.seller_uuid = ? OR c.buyer_uuid = ?) AND (c.archived_seller = 0 OR c.seller_uuid != ?) AND (c.archived_buyer = 0 OR c.buyer_uuid != ?)`;
      }

      const binds = archived
        ? [session.uuid, session.uuid]
        : [session.uuid, session.uuid, session.uuid, session.uuid];

      const { results } = await env.DB.prepare(`
        SELECT c.*,
          l.armour_type, l.set_name, l.cat_label, l.pieces,
          (SELECT m2.ts FROM messages m2 WHERE m2.chat_id = c.id ORDER BY m2.ts DESC LIMIT 1) as last_ts,
          (SELECT m3.content FROM messages m3 WHERE m3.chat_id = c.id ORDER BY m3.ts DESC LIMIT 1) as last_message
        FROM chats c
        LEFT JOIN listings l ON c.listing_id = l.id
        WHERE ${whereClause}
        ORDER BY COALESCE(last_ts, c.created_at) DESC
      `).bind(...binds).all();

      return json({ chats: results });
    }

    // ── Chats: get single + messages ───────────────────────────────────
    if (url.pathname.match(/^\/chats\/[a-f0-9]+$/) && request.method === 'GET') {
      const session = await getSession(request, env);
      if (!session) return err('Unauthorised', 401);

      const chatId = url.pathname.split('/')[2];
      const since = parseInt(url.searchParams.get('since') || '0');

      const chat = await env.DB.prepare(
        `SELECT c.*, l.armour_type, l.set_name, l.pieces, l.price
         FROM chats c LEFT JOIN listings l ON c.listing_id = l.id
         WHERE c.id = ?`
      ).bind(chatId).first();

      if (!chat) return err('Not found', 404);
      if (chat.seller_uuid !== session.uuid && chat.buyer_uuid !== session.uuid) return err('Forbidden', 403);

      const { results: messages } = await env.DB.prepare(
        `SELECT * FROM messages WHERE chat_id = ? AND ts > ? ORDER BY ts ASC`
      ).bind(chatId, since).all();

      return json({ chat, messages });
    }

    // ── Chats: send message ────────────────────────────────────────────
    if (url.pathname.match(/^\/chats\/[a-f0-9]+\/messages$/) && request.method === 'POST') {
      const session = await getSession(request, env);
      if (!session) return err('Unauthorised', 401);

      const chatId = url.pathname.split('/')[2];
      const chat = await env.DB.prepare(`SELECT * FROM chats WHERE id = ?`).bind(chatId).first();
      if (!chat) return err('Not found', 404);
      if (chat.seller_uuid !== session.uuid && chat.buyer_uuid !== session.uuid) return err('Forbidden', 403);

      const body = await request.json();
      const { content, image_url } = body;
      if (image_url && chat.seller_uuid !== session.uuid) return err('Only seller can send images', 403);
      if (!content && !image_url) return err('Message cannot be empty');

      const id = generateId();
      await env.DB.prepare(`
        INSERT INTO messages (id, chat_id, sender_uuid, sender_ign, content, image_url, ts)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(id, chatId, session.uuid, session.username, content || null, image_url || null, Date.now()).run();

      // Increment message counter
      await env.DB.prepare(
        `UPDATE users SET messages_sent = messages_sent + 1 WHERE uuid = ?`
      ).bind(session.uuid).run();

      return json({ id, ok: true }, 201);
    }

    // ── Chats: archive (close) ─────────────────────────────────────────────
    if (url.pathname.match(/^\/chats\/[a-f0-9]+\/archive$/) && request.method === 'PUT') {
      const session = await getSession(request, env);
      if (!session) return err('Unauthorised', 401);
      const chatId = url.pathname.split('/')[2];
      const chat = await env.DB.prepare(`SELECT * FROM chats WHERE id = ?`).bind(chatId).first();
      if (!chat) return err('Not found', 404);
      if (chat.seller_uuid !== session.uuid && chat.buyer_uuid !== session.uuid) return err('Forbidden', 403);

      let body = {};
      try { body = await request.json(); } catch(e) {}

      if (body.both) {
        await env.DB.prepare(`UPDATE chats SET archived_seller = 1, archived_buyer = 1 WHERE id = ?`).bind(chatId).run();
      } else {
        const field = chat.seller_uuid === session.uuid ? 'archived_seller' : 'archived_buyer';
        await env.DB.prepare(`UPDATE chats SET ${field} = 1 WHERE id = ?`).bind(chatId).run();
      }
      return json({ ok: true });
    }

    // ── Chats: restore ─────────────────────────────────────────────────────
    if (url.pathname.match(/^\/chats\/[a-f0-9]+\/restore$/) && request.method === 'PUT') {
      const session = await getSession(request, env);
      if (!session) return err('Unauthorised', 401);
      const chatId = url.pathname.split('/')[2];
      const chat = await env.DB.prepare(`SELECT * FROM chats WHERE id = ?`).bind(chatId).first();
      if (!chat) return err('Not found', 404);
      if (chat.seller_uuid !== session.uuid && chat.buyer_uuid !== session.uuid) return err('Forbidden', 403);
      const field = chat.seller_uuid === session.uuid ? 'archived_seller' : 'archived_buyer';
      await env.DB.prepare(`UPDATE chats SET ${field} = 0 WHERE id = ?`).bind(chatId).run();
      return json({ ok: true });
    }

    // ── Images: upload ─────────────────────────────────────────────────
    if (url.pathname === '/images/upload' && request.method === 'POST') {
      const session = await getSession(request, env);
      if (!session) return err('Unauthorised', 401);

      const formData = await request.formData();
      const file = formData.get('file');
      if (!file) return err('No file provided');

      const ext = file.type === 'image/png' ? 'png' : file.type === 'image/gif' ? 'gif' : 'jpg';
      const key = `chat/${generateId()}.${ext}`;

      await env.IMAGES.put(key, file.stream(), {
        httpMetadata: { contentType: file.type },
      });

      return json({ url: `https://pub-${env.R2_PUBLIC_URL}.r2.dev/${key}` });
    }

    // ── Images: serve from R2 ──────────────────────────────────────────
    if (url.pathname.startsWith('/images/') && request.method === 'GET') {
      const key = url.pathname.slice(1);
      const obj = await env.IMAGES.get(key);
      if (!obj) return err('Not found', 404);
      return new Response(obj.body, {
        headers: {
          'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg',
          'Cache-Control': 'public, max-age=31536000',
          ...CORS,
        },
      });
    }

    
    // ── Pages: get ────────────────────────────────────────────────────
    if (url.pathname === '/pages' && request.method === 'GET') {
      const uuid = url.searchParams.get('uuid');
      if (!uuid) return err('Missing uuid');
      try { await env.DB.prepare(`ALTER TABLE pages ADD COLUMN tab TEXT DEFAULT 'exotic'`).run(); } catch(e) {}
      try { await env.DB.prepare(`CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, uuid TEXT, name TEXT, tab TEXT DEFAULT 'exotic', sort INTEGER DEFAULT 0, created_at INTEGER)`).run(); } catch(e) {}
      const rows = await env.DB.prepare(`SELECT * FROM pages WHERE uuid = ? ORDER BY sort ASC, created_at ASC`).bind(uuid).all();
      return json({ pages: rows.results || [] });
    }

    // ── Pages: create ─────────────────────────────────────────────────
    if (url.pathname === '/pages' && request.method === 'POST') {
      const session = await getSession(request, env);
      if (!session) return err('Unauthorised', 401);
      const body = await request.json();
      const name = (body.name || '').trim().slice(0, 40);
      if (!name) return err('Name required');
      try { await env.DB.prepare(`ALTER TABLE pages ADD COLUMN tab TEXT DEFAULT 'exotic'`).run(); } catch(e) {}
      try { await env.DB.prepare(`CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, uuid TEXT, name TEXT, tab TEXT DEFAULT 'exotic', sort INTEGER DEFAULT 0, created_at INTEGER)`).run(); } catch(e) {}
      try { await env.DB.prepare(`ALTER TABLE pages ADD COLUMN tab TEXT DEFAULT 'exotic'`).run(); } catch(e) {}
      const tab = (body.tab === 'seymour') ? 'seymour' : 'exotic';
      const id = generateId();
      await env.DB.prepare(`INSERT INTO pages (id, uuid, name, tab, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(id, session.uuid, name, tab, 0, Date.now()).run();
      return json({ id, ok: true }, 201);
    }

    // ── Pages: delete ─────────────────────────────────────────────────
    if (url.pathname.match(/^\/pages\/[a-z0-9]+$/) && request.method === 'DELETE') {
      const session = await getSession(request, env);
      if (!session) return err('Unauthorised', 401);
      const id = url.pathname.split('/')[2];
      try { await env.DB.prepare(`ALTER TABLE pages ADD COLUMN tab TEXT DEFAULT 'exotic'`).run(); } catch(e) {}
      try { await env.DB.prepare(`CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, uuid TEXT, name TEXT, tab TEXT DEFAULT 'exotic', sort INTEGER DEFAULT 0, created_at INTEGER)`).run(); } catch(e) {}
      const page = await env.DB.prepare(`SELECT uuid FROM pages WHERE id = ?`).bind(id).first();
      if (!page) return err('Not found', 404);
      if (page.uuid !== session.uuid) return err('Forbidden', 403);
      await env.DB.prepare(`DELETE FROM pages WHERE id = ?`).bind(id).run();
      return json({ ok: true });
    }


    // ── Listings: edit ────────────────────────────────────────────────
    if (url.pathname.match(/^\/listings\/[a-z0-9]+\/edit$/) && request.method === 'PUT') {
      const session = await getSession(request, env);
      if (!session) return err('Unauthorised', 401);
      const id = url.pathname.split('/')[2];
      try { await env.DB.prepare(`ALTER TABLE listings ADD COLUMN updated_at INTEGER`).run(); } catch(e) {}
      try { await env.DB.prepare(`ALTER TABLE listings ADD COLUMN updated_at INTEGER`).run(); } catch(e) {}
      const listing = await env.DB.prepare(`SELECT uuid FROM listings WHERE id = ?`).bind(id).first();
      if (!listing) return err('Not found', 404);
      if (listing.uuid !== session.uuid) return err('Forbidden', 403);
      const body = await request.json();
      const fields = [];
      const vals = [];
      if (body.armour_type !== undefined) { fields.push('armour_type = ?'); vals.push(body.armour_type); }
      if (body.set_name !== undefined) { fields.push('set_name = ?'); vals.push(body.set_name); }
      if (body.pieces !== undefined) { fields.push('pieces = ?'); vals.push(JSON.stringify(body.pieces)); }
      if (body.for_offers !== undefined) { fields.push('for_offers = ?'); vals.push(body.for_offers ? 1 : 0); }
      if (body.price !== undefined) { fields.push('price = ?'); vals.push(body.price || 0); }
      if (body.notes !== undefined) { fields.push('notes = ?'); vals.push(body.notes || ''); }
      if (body.current_offer !== undefined) { fields.push('current_offer = ?'); vals.push(body.current_offer || ''); }
      if (body.current_offer_ign !== undefined) { fields.push('current_offer_ign = ?'); vals.push(body.current_offer_ign || ''); }
      if (body.bought_for !== undefined) { fields.push('bought_for = ?'); vals.push(body.bought_for || ''); }
      if (body.scuffness !== undefined) { fields.push('scuffness = ?'); vals.push(body.scuffness ? JSON.stringify(body.scuffness) : null); }
      if (body.page_id !== undefined) { fields.push('page_id = ?'); vals.push(body.page_id || null); }
      fields.push('updated_at = ?'); vals.push(Date.now());
      if (!fields.length) return err('Nothing to update');
      // Add migration for new columns
      try { await env.DB.prepare(`ALTER TABLE listings ADD COLUMN current_offer TEXT`).run(); } catch(e) {}
      try { await env.DB.prepare(`ALTER TABLE listings ADD COLUMN scuffness TEXT`).run(); } catch(e) {}
      try { await env.DB.prepare(`ALTER TABLE listings ADD COLUMN current_offer_ign TEXT`).run(); } catch(e) {}
      try { await env.DB.prepare(`ALTER TABLE listings ADD COLUMN bought_for TEXT`).run(); } catch(e) {}
      vals.push(id);
      await env.DB.prepare(`UPDATE listings SET ${fields.join(', ')} WHERE id = ?`).bind(...vals).run();
      return json({ ok: true });
    }


    // ── Pages: rename ────────────────────────────────────────────────
    if (url.pathname.match(/^\/pages\/[a-z0-9\-]+\/rename$/) && request.method === 'PUT') {
      const session = await getSession(request, env);
      if (!session) return err('Unauthorised', 401);
      const id = url.pathname.split('/')[2];
      try { await env.DB.prepare(`ALTER TABLE pages ADD COLUMN tab TEXT DEFAULT 'exotic'`).run(); } catch(e) {}
      const page = await env.DB.prepare(`SELECT uuid FROM pages WHERE id = ?`).bind(id).first();
      if (!page) return err('Not found', 404);
      if (page.uuid !== session.uuid) return err('Forbidden', 403);
      const body = await request.json();
      const name = (body.name || '').trim().slice(0, 40);
      if (!name) return err('Name required');
      await env.DB.prepare(`UPDATE pages SET name = ? WHERE id = ?`).bind(name, id).run();
      return json({ ok: true });
    }





    // ── Seymour: every piece across every published collection ───────
    if (url.pathname === '/seymour/allpieces' && request.method === 'GET') {
      try {
        await ensureSeymour(env);
        const cap = Math.min(parseInt(url.searchParams.get('limit') || '25000', 10) || 25000, 40000);
        const { results } = await env.DB.prepare(
          `SELECT c.uuid, c.ign, c.pieces FROM seymour_collections c
            ORDER BY c.updated_at DESC LIMIT 200`).all();
        const out = [];
        let truncated = false;
        for (const row of (results || [])) {
          let ps = [];
          try { ps = JSON.parse(row.pieces || '[]'); } catch (e) { continue; }
          for (const p of ps) {
            if (out.length >= cap) { truncated = true; break; }
            out.push({ id: p.id, slot: p.slot, hex: p.hex, cat: p.cat, ts: p.ts,
                       best: p.best || null, owner: row.uuid, ign: row.ign || '' });
          }
          if (truncated) break;
        }
        return json({ pieces: out, count: out.length, truncated,
                      collections: (results || []).length });
      } catch (e) { return err('allpieces error: ' + e.message, 500); }
    }

    // ── Seymour: one item's full sale chain (by item uid) ────────────
    if (url.pathname === '/seymour/item' && request.method === 'GET') {
      try {
        await ensureSales(env);
        const uid = (url.searchParams.get('uid') || '').toLowerCase();
        if (!uid) return err('uid required');
        const { results } = await env.DB.prepare(
          `SELECT * FROM seymour_sales WHERE lower(item_uid) = ? ORDER BY sold_at ASC`
        ).bind(uid).all();
        return json({ uid, sales: results || [] });
      } catch (e) { return err('item error: ' + e.message, 500); }
    }



    // ── Seymour: wipe the sales archive and restart the walk ─────────
    if (url.pathname === '/seymour/sales/reset' && request.method === 'POST') {
      try {
        const session = await getSession(request, env);
        if (!session || !session.uuid) return err('Unauthorised', 401);
        await ensureSales(env);
        await env.DB.prepare(`DELETE FROM seymour_sales`).run();
        for (const k of ['bf_page','bf_offset','bf_tag_index','bf_oldest',
                         'bf_last_result','bf_error','bf_tick','poll_error']) {
          await setMeta(env, k, k === 'bf_last_result' ? 'null' : '0');
        }
        await setMeta(env, 'tracking_started', String(Date.now()));
        return json({ ok: true, reset: true });
      } catch (e) { return err('reset error: ' + e.message, 500); }
    }


    // ── Seymour: clear the Coflnet cooldown manually ─────────────────
    if (url.pathname === '/seymour/backfill/unblock' && request.method === 'POST') {
      try {
        const session = await getSession(request, env);
        if (!session || !session.uuid) return err('Unauthorised', 401);
        await setMeta(env, 'cofl_blocked_until', '0');
        await setMeta(env, 'cofl_block_reason', '');
        return json({ ok: true });
      } catch (e) { return err('unblock error: ' + e.message, 500); }
    }

    // ── Seymour: backfill control + progress ─────────────────────────
    if (url.pathname === '/seymour/backfill/status' && request.method === 'GET') {
      try {
        await ensureSales(env);
        const enabled = true;
        const ti      = parseInt(await getMeta(env, 'bf_tag_index', '0'), 10) || 0;
        const oldest  = parseInt(await getMeta(env, 'bf_oldest', '0'), 10) || 0;
        const page    = parseInt(await getMeta(env, 'bf_page', '0'), 10) || 0;
        const offset  = parseInt(await getMeta(env, 'bf_offset', '0'), 10) || 0;
        const last    = parseInt(await getMeta(env, 'bf_last_run', '0'), 10) || 0;
        const started = parseInt(await getMeta(env, 'tracking_started', '0'), 10) || 0;
        const lastRes = await getMeta(env, 'bf_last_result', 'null');
        const row     = await env.DB.prepare(
          `SELECT COUNT(*) AS c, MIN(sold_at) AS mn FROM seymour_sales`).first();
        const now = Date.now();
        const span = now - SEYMOUR_RELEASE;
        const reached = oldest || (row && row.mn) || now;
        const pct = Math.max(0, Math.min(100, ((now - reached) / span) * 100));
        return json({
          enabled, done: ti >= BF_TAGS.length,
          tag: BF_TAGS[ti] || null, tagIndex: ti, tagCount: BF_TAGS.length, page, offset,
          oldestReached: reached, releaseDate: SEYMOUR_RELEASE,
          percent: Math.round(pct * 10) / 10,
          totalSales: row ? row.c : 0, lastRun: last, trackingStarted: started,
          budget: parseInt(await getMeta(env, 'bf_budget', '6'), 10),
          blockedUntil: parseInt(await getMeta(env, 'cofl_blocked_until', '0'), 10) || 0,
          blockReason: await getMeta(env, 'cofl_block_reason', ''),
          lastResult: (() => { try { return JSON.parse(lastRes); } catch (e) { return null; } })()
        });
      } catch (e) { return err('status error: ' + e.message, 500); }
    }

    if (url.pathname === '/seymour/backfill/toggle' && request.method === 'POST') {
      try {
        const session = await getSession(request, env);
        if (!session || !session.uuid) return err('Unauthorised', 401);
        await ensureSales(env);
        const b = await request.json().catch(() => ({}));
        if (b.reset) {
          await setMeta(env, 'bf_tag_index', 0);
          await setMeta(env, 'bf_page', 0);
          await setMeta(env, 'bf_offset', 0);
          await setMeta(env, 'bf_oldest', 0);
        }
        if (b.budget !== undefined) {
          const bud = Math.min(Math.max(parseInt(b.budget, 10) || 6, 1), 48);
          await setMeta(env, 'bf_budget', bud);
        }
        await setMeta(env, 'bf_enabled', b.enabled ? '1' : '0');
        return json({ ok: true, enabled: !!b.enabled,
                      budget: parseInt(await getMeta(env, 'bf_budget', '6'), 10),
          blockedUntil: parseInt(await getMeta(env, 'cofl_blocked_until', '0'), 10) || 0,
          blockReason: await getMeta(env, 'cofl_block_reason', ''),
          lastResult: (() => { try { return JSON.parse(lastRes); } catch (e) { return null; } })() });
      } catch (e) { return err('toggle error: ' + e.message, 500); }
    }

    // Run one backfill slice immediately (handy for testing)
    if (url.pathname === '/seymour/backfill/step' && request.method === 'POST') {
      try {
        const b = await request.json().catch(() => ({}));
        await setMeta(env, 'bf_enabled', '1');
        return json(await backfillStep(env, Math.min(parseInt(b.budget || 8, 10) || 8, 20)));
      } catch (e) { return err('step error: ' + e.message, 500); }
    }


    // ── Seymour: cheap change-poll for live UI ───────────────────────
    if (url.pathname === '/seymour/version' && request.method === 'GET') {
      try {
        await ensureSales(env);
        const c = await env.DB.prepare(`SELECT COUNT(*) AS c, MAX(sold_at) AS m FROM seymour_sales`).first();
        return json({ sales: c ? c.c : 0, newest: c && c.m ? c.m : 0,
                      lastRun: parseInt(await getMeta(env, 'bf_last_run', '0'), 10) || 0 });
      } catch (e) { return json({ sales: 0, newest: 0, lastRun: 0 }); }
    }

    // ── Seymour: uuid -> username (cached forever in D1) ─────────────
    if (url.pathname === '/seymour/names' && request.method === 'GET') {
      try {
        await env.DB.prepare(
          `CREATE TABLE IF NOT EXISTS mc_names (uuid TEXT PRIMARY KEY, name TEXT, fetched_at INTEGER)`).run();
        const raw = (url.searchParams.get('uuids') || '').split(',')
          .map(s => s.trim().replace(/-/g, '').toLowerCase())
          .filter(s => /^[0-9a-f]{32}$/.test(s)).slice(0, 40);
        const out = {};
        const missing = [];
        for (const u of raw) {
          const r = await env.DB.prepare(`SELECT name FROM mc_names WHERE uuid = ?`).bind(u).first();
          if (r && r.name) out[u] = r.name; else missing.push(u);
        }
        let lastErr = null;
        for (const u of missing.slice(0, 10)) {
          let name = null;
          try {
            const res = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${u}`,
              { headers: { 'User-Agent': 'seyvault' } });
            if (res.ok) { const p = await res.json(); if (p && p.name) name = p.name; }
            else lastErr = 'mojang ' + res.status;
          } catch (e) { lastErr = 'mojang ' + (e.message || e); }
          if (!name) {
            try {
              const r2 = await fetch(`https://api.ashcon.app/mojang/v2/user/${u}`);
              if (r2.ok) { const p2 = await r2.json(); if (p2 && p2.username) name = p2.username; }
              else if (!lastErr) lastErr = 'ashcon ' + r2.status;
            } catch (e) { if (!lastErr) lastErr = 'ashcon ' + (e.message || e); }
          }
          if (!name) {
            try {
              const r3 = await fetch(`https://playerdb.co/api/player/minecraft/${u}`);
              if (r3.ok) { const p3 = await r3.json();
                if (p3 && p3.data && p3.data.player && p3.data.player.username) name = p3.data.player.username; }
            } catch (e) {}
          }
          if (name) {
            out[u] = name;
            await env.DB.prepare(
              `INSERT OR REPLACE INTO mc_names (uuid,name,fetched_at) VALUES (?,?,?)`)
              .bind(u, name, Date.now()).run();
          }
        }
        return json({ names: out, error: lastErr, asked: raw.length, missing: missing.length });
      } catch (e) { return err('names error: ' + e.message, 500); }
    }

    // ── Seymour: inspect one Coflnet auction ─────────────────────────
    if (url.pathname === '/seymour/probe' && request.method === 'GET') {
      const out = {};
      try {
        const tag = SEYMOUR_TAGS.has(url.searchParams.get('tag') || '')
          ? url.searchParams.get('tag') : 'VELVET_TOP_HAT';
        const page = parseInt(url.searchParams.get('page') || '0', 10) || 0;
        const lr = await fetch(
          `https://sky.coflnet.com/api/auctions/tag/${tag}/sold?page=${page}&pageSize=5`);
        out.listStatus = lr.status;
        if (!lr.ok) { out.listBody = (await lr.text()).slice(0, 400); return json(out); }
        const list = await lr.json();
        out.listedCount = Array.isArray(list) ? list.length : 0;
        out.firstListItem = Array.isArray(list) && list[0] ? list[0] : null;
        if (!out.listedCount) return json(out);
        const dr = await fetch(`https://sky.coflnet.com/api/auction/${list[0].uuid}`);
        out.detailStatus = dr.status;
        if (!dr.ok) { out.detailBody = (await dr.text()).slice(0, 400); return json(out); }
        const d = await dr.json();
        out.detailKeys = Object.keys(d);
        out.flatNbtKeys = d.flatNbt ? Object.keys(d.flatNbt) : null;
        out.flatNbt = d.flatNbt || null;
        out.end = d.end;
        out.parsedEnd = Date.parse(d.end || '') || null;
        out.hasItemBytes = !!(d.itemBytes || d.item_bytes || d.bytes);
      } catch (e) { out.error = String(e && e.message || e); }
      return json(out);
    }

    // ── Seymour: diagnostics ─────────────────────────────────────────
    if (url.pathname === '/seymour/debug' && request.method === 'GET') {
      const out = {};
      try {
        const cols = await env.DB.prepare(`PRAGMA table_info(seymour_sales)`).all();
        out.sales_columns = (cols.results || []).map(c => c.name);
        out.has_item_uid = out.sales_columns.includes('item_uid');
      } catch (e) { out.sales_columns = 'ERROR: ' + e.message; }
      try {
        const c = await env.DB.prepare(
          `SELECT COUNT(*) AS c, SUM(source='coflnet') AS cofl, SUM(source='hypixel') AS hyp
             FROM seymour_sales`).first();
        out.sales_rows = c ? c.c : 0;
        out.from_coflnet = c ? c.cofl : 0;
        out.from_hypixel = c ? c.hyp : 0;
      } catch (e) { out.sales_rows = 'ERROR: ' + e.message; }
      try {
        const m = await env.DB.prepare(`SELECT k, v FROM seymour_meta`).all();
        out.meta = Object.fromEntries((m.results || []).map(r => [r.k, r.v]));
        if (out.meta.bf_last_result) { try { out.lastSlice = JSON.parse(out.meta.bf_last_result); } catch (e) {} }
        if (out.meta.bf_sample)      { try { out.sample    = JSON.parse(out.meta.bf_sample); } catch (e) {} }
        out.cursor = { tag: BF_TAGS[parseInt(out.meta.bf_tag_index || '0', 10)] || null,
                       page: out.meta.bf_page || '0', offset: out.meta.bf_offset || '0' };
      } catch (e) { out.meta = 'ERROR: ' + e.message; }
      return json(out);
    }

    // ── Seymour: sales history ───────────────────────────────────────
    if (url.pathname === '/seymour/sales' && request.method === 'GET') {
      try {
        await ensureSales(env);
        const hex   = (url.searchParams.get('hex') || '').replace('#','').toUpperCase();
        const item  = url.searchParams.get('item') || '';
        const uid   = (url.searchParams.get('uid')  || '').toLowerCase();
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '400', 10) || 400, 1000);
        let sql = `SELECT s.*,
          (SELECT COUNT(*) FROM seymour_sales x
            WHERE x.item_uid = s.item_uid AND s.item_uid IS NOT NULL AND s.item_uid <> '') AS chain_len,
          (SELECT MAX(x.sold_at) FROM seymour_sales x
            WHERE x.item_uid = s.item_uid AND s.item_uid IS NOT NULL AND s.item_uid <> '') AS last_sold
          FROM seymour_sales s`;
        const cond = [], vals = [];
        if (/^[0-9A-F]{6}$/.test(hex)) { cond.push('s.hex = ?'); vals.push(hex); }
        if (SEYMOUR_TAGS.has(item))    { cond.push('s.item_id = ?'); vals.push(item); }
        if (uid)                       { cond.push('lower(s.item_uid) = ?'); vals.push(uid); }
        if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
        sql += ' ORDER BY s.sold_at DESC LIMIT ?'; vals.push(limit);
        const { results } = await env.DB.prepare(sql).bind(...vals).all();
        const total = await env.DB.prepare(`SELECT COUNT(*) AS c FROM seymour_sales`).first();
        const meta  = await env.DB.prepare(
          `SELECT v FROM seymour_meta WHERE k = 'tracking_started'`).first();
        const first = await env.DB.prepare(`SELECT MIN(sold_at) AS m FROM seymour_sales`).first();
        return json({
          sales: results || [],
          tracked: total ? total.c : 0,
          tracking_started: meta ? Number(meta.v) : null,
          earliest_sale: first && first.m ? Number(first.m) : null
        });
      } catch (e) { return err('sales error: ' + e.message, 500); }
    }

    // ── Seymour: manual poll (debug / backfill trigger) ──────────────
    if (url.pathname === '/seymour/poll' && request.method === 'POST') {
      try { return json(await pollEndedAuctions(env)); }
      catch (e) { return err('poll error: ' + (e && e.message ? e.message : String(e)), 500); }
    }

    // ── Seymour: profile (discord tag) ───────────────────────────────
    if (url.pathname === '/seymour/profile' && request.method === 'PUT') {
      try {
        const session = await getSession(request, env);
        if (!session || !session.uuid) return err('Unauthorised', 401);
        const body = await request.json();
        let discord = typeof body.discord === 'string' ? body.discord.trim().slice(0, 40) : '';
        if (discord && !/^[a-zA-Z0-9._#\- ]{2,40}$/.test(discord)) return err('Invalid Discord username');
        await env.DB.prepare(`UPDATE users SET discord = ?, updated_at = ? WHERE uuid = ?`)
          .bind(discord || null, Date.now(), session.uuid).run();
        return json({ ok: true, discord });
      } catch (e) { return err('profile error: ' + (e && e.message ? e.message : String(e)), 500); }
    }

    // ── Seymour: ensure table ────────────────────────────────────────
    async function ensureSeymour(env){
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS seymour_collections (
        uuid TEXT PRIMARY KEY,
        ign TEXT,
        pieces TEXT,
        sets TEXT,
        updated_at INTEGER
      )`).run();
    }

    // ── Seymour: list all public collections ─────────────────────────
    if (url.pathname === '/seymour/collections' && request.method === 'GET') {
      await ensureSeymour(env);
      const { results } = await env.DB.prepare(
        `SELECT c.uuid, c.ign, c.pieces, c.sets, c.updated_at, u.discord
           FROM seymour_collections c LEFT JOIN users u ON u.uuid = c.uuid
          ORDER BY c.updated_at DESC LIMIT 300`
      ).all();
      const out = (results || []).map(r => {
        let pieces = [];
        try { pieces = JSON.parse(r.pieces || '[]'); } catch(e) {}
        let sets = [];
        try { sets = JSON.parse(r.sets || '[]'); } catch(e) {}
        const cats = {};
        for (const p of pieces) cats[p.cat] = (cats[p.cat] || 0) + 1;
        const tiers = { t0: 0, t1: 0, t2: 0 };
        for (const p of pieces) {
          const d = p.best && typeof p.best.dE === 'number' ? p.best.dE : 99;
          if (d < 1) tiers.t0++; else if (d < 2) tiers.t1++; else if (d < 5) tiers.t2++;
        }
        const slots = {};
        for (const p of pieces) slots[p.slot] = (slots[p.slot] || 0) + 1;
        return { uuid: r.uuid, ign: r.ign, discord: r.discord || '', count: pieces.length,
                 sets: sets.length, cats, tiers, slots, updated_at: r.updated_at };
      });
      return json({ collections: out });
    }


    // ── Seymour: every piece across every collection ─────────────────
    if (url.pathname === '/seymour/allpieces' && request.method === 'GET') {
      try {
        await ensureSeymour(env);
        const { results } = await env.DB.prepare(
          `SELECT c.uuid, c.ign, c.pieces FROM seymour_collections c ORDER BY c.updated_at DESC LIMIT 300`
        ).all();
        const out = [];
        for (const r of (results || [])) {
          let pieces = [];
          try { pieces = JSON.parse(r.pieces || '[]'); } catch (e) {}
          for (const p of pieces) {
            if (out.length >= 40000) break;
            out.push({ id: p.id, slot: p.slot, hex: p.hex, cat: p.cat, ts: p.ts || 0,
                       best: p.best || null, owner: r.uuid, ign: r.ign || '' });
          }
          if (out.length >= 40000) break;
        }
        return json({ pieces: out, owners: (results || []).length });
      } catch (e) { return err('allpieces error: ' + e.message, 500); }
    }


    // ── Seymour: every piece across every collection ─────────────────
    if (url.pathname === '/seymour/allpieces' && request.method === 'GET') {
      try {
        await ensureSeymour(env);
        const { results } = await env.DB.prepare(
          `SELECT c.uuid, c.ign, c.pieces FROM seymour_collections c
            ORDER BY c.updated_at DESC LIMIT 300`).all();
        const out = [];
        for (const r of (results || [])) {
          let pieces = [];
          try { pieces = JSON.parse(r.pieces || '[]'); } catch (e) { continue; }
          for (const p of pieces) {
            if (!p || !p.hex || !p.slot) continue;
            out.push({ hex: p.hex, slot: p.slot, cat: p.cat, ts: p.ts || 0,
                       best: p.best || null, owner: r.uuid, ign: r.ign || '' });
            if (out.length >= 25000) break;
          }
          if (out.length >= 25000) break;
        }
        return json({ pieces: out, owners: (results || []).length });
      } catch (e) { return err('pieces error: ' + e.message, 500); }
    }

    // ── Seymour: fetch one collection ────────────────────────────────
    if (url.pathname === '/seymour/collection' && request.method === 'GET') {
      await ensureSeymour(env);
      const uuid = (url.searchParams.get('uuid') || '').replace(/-/g, '');
      if (!uuid) return err('uuid required');
      const row = await env.DB.prepare(
        `SELECT c.uuid, c.ign, c.pieces, c.sets, c.updated_at, u.discord
           FROM seymour_collections c LEFT JOIN users u ON u.uuid = c.uuid
          WHERE c.uuid = ?`
      ).bind(uuid).first();
      if (!row) return json({ uuid, ign: '', discord: '', pieces: [], sets: [], updated_at: 0 });
      let pieces = [], sets = [];
      try { pieces = JSON.parse(row.pieces || '[]'); } catch(e) {}
      try { sets = JSON.parse(row.sets || '[]'); } catch(e) {}
      return json({ uuid: row.uuid, ign: row.ign, discord: row.discord || '',
                    pieces, sets, updated_at: row.updated_at });
    }

    // ── Seymour: publish your collection ─────────────────────────────
    if (url.pathname === '/seymour/collection' && request.method === 'PUT') {
      try {
        const session = await getSession(request, env);
        if (!session || !session.uuid) return err('Unauthorised', 401);
        await ensureSeymour(env);
        const body = await request.json();
        const pieces = Array.isArray(body.pieces) ? body.pieces.slice(0, 4000) : [];
        const sets   = Array.isArray(body.sets)   ? body.sets.slice(0, 500)    : [];
        const slim = pieces.map(p => ({
          id: String(p.id || '').slice(0, 60),
          slot: p.slot, hex: p.hex, cat: p.cat, ts: p.ts || 0,
          best: p.best ? { name: p.best.name, hex: p.best.hex,
                           dE: Math.round((p.best.dE || 0) * 1000) / 1000,
                           abs: p.best.abs | 0 } : null
        }));
        await env.DB.prepare(
          `INSERT INTO seymour_collections (uuid, ign, pieces, sets, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(uuid) DO UPDATE SET
             ign = excluded.ign, pieces = excluded.pieces,
             sets = excluded.sets, updated_at = excluded.updated_at`
        ).bind(session.uuid, session.username || '', JSON.stringify(slim),
               JSON.stringify(sets), Date.now()).run();
        return json({ ok: true, count: slim.length });
      } catch (e) {
        return err('DB error: ' + (e && e.message ? e.message : String(e)), 500);
      }
    }

    // ── Seymour: unpublish ───────────────────────────────────────────
    if (url.pathname === '/seymour/collection' && request.method === 'DELETE') {
      const session = await getSession(request, env);
      if (!session) return err('Unauthorised', 401);
      await ensureSeymour(env);
      await env.DB.prepare(`DELETE FROM seymour_collections WHERE uuid = ?`).bind(session.uuid).run();
      return json({ ok: true });
    }

    // ── Reports: submit ────────────────────────────────────────────────
    if (url.pathname === '/reports' && request.method === 'POST') {
      const body = await request.json();
      const { type, targetId, targetIgn, reason, notes, reporterIgn, reporterUuid } = body;
      if (!reason || !type) return err('Missing fields');

      const id = generateId();
      await env.DB.prepare(`
        INSERT INTO reports (id, type, target_id, target_ign, reason, notes, reporter_ign, reporter_uuid, ts, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
      `).bind(id, type, targetId || '', targetIgn || '', reason, notes || '', reporterIgn || '', reporterUuid || null, Date.now()).run();

      // Admin notification in KV
      const existing = await env.SESSIONS.get('admin:notifications');
      const notifs = existing ? JSON.parse(existing) : [];
      notifs.unshift({ id, type, targetIgn, reason, ts: Date.now() });
      await env.SESSIONS.put('admin:notifications', JSON.stringify(notifs.slice(0, 50)));

      return json({ id, ok: true }, 201);
    }

    // ── Reports: get (mrlancus only) ───────────────────────────────────
    if (url.pathname === '/reports' && request.method === 'GET') {
      const session = await getSession(request, env);
      if (!session) return err('Unauthorised', 401);
      if (session.username.toLowerCase() !== 'mrlancus') return err('Forbidden', 403);

      const { results } = await env.DB.prepare(
        `SELECT * FROM reports ORDER BY ts DESC LIMIT 100`
      ).all();
      const notifs = await env.SESSIONS.get('admin:notifications');
      return json({ reports: results, notifications: notifs ? JSON.parse(notifs) : [] });
    }

    // ── Skull texture proxy ────────────────────────────────────────────────
    if (url.pathname.startsWith('/skull/') && request.method === 'GET') {
      const hash = url.pathname.split('/')[2];
      if (!hash || !/^[a-f0-9]+$/i.test(hash)) return err('Invalid hash', 400);
      const texRes = await fetch(`https://textures.minecraft.net/texture/${hash}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      if (!texRes.ok) return new Response('Not found', { status: 404, headers: CORS });
      const blob = await texRes.arrayBuffer();
      return new Response(blob, {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=86400',
          ...CORS,
        }
      });
    }

    return err('Not found', 404);
    
  },
}
;