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

export default {
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
      if (!code || !code_verifier) return err('Missing code or code_verifier');

      const tokenRes = await fetch('https://mc-id.com/api/auth/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: env.MCID_CLIENT_ID,
          client_secret: env.MCID_CLIENT_SECRET,
          redirect_uri: env.MCID_REDIRECT_URI,
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

      return json({ token: sessionToken, user: { uuid: account.uuid, username: account.username } });
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
        `SELECT uuid, ign, pieces, sets, updated_at FROM seymour_collections ORDER BY updated_at DESC LIMIT 300`
      ).all();
      const out = (results || []).map(r => {
        let pieces = [];
        try { pieces = JSON.parse(r.pieces || '[]'); } catch(e) {}
        let sets = [];
        try { sets = JSON.parse(r.sets || '[]'); } catch(e) {}
        const cats = {};
        for (const p of pieces) cats[p.cat] = (cats[p.cat] || 0) + 1;
        const slots = {};
        for (const p of pieces) slots[p.slot] = (slots[p.slot] || 0) + 1;
        return { uuid: r.uuid, ign: r.ign, count: pieces.length, sets: sets.length,
                 cats, slots, updated_at: r.updated_at };
      });
      return json({ collections: out });
    }

    // ── Seymour: fetch one collection ────────────────────────────────
    if (url.pathname === '/seymour/collection' && request.method === 'GET') {
      await ensureSeymour(env);
      const uuid = (url.searchParams.get('uuid') || '').replace(/-/g, '');
      if (!uuid) return err('uuid required');
      const row = await env.DB.prepare(
        `SELECT uuid, ign, pieces, sets, updated_at FROM seymour_collections WHERE uuid = ?`
      ).bind(uuid).first();
      if (!row) return json({ uuid, ign: '', pieces: [], sets: [], updated_at: 0 });
      let pieces = [], sets = [];
      try { pieces = JSON.parse(row.pieces || '[]'); } catch(e) {}
      try { sets = JSON.parse(row.sets || '[]'); } catch(e) {}
      return json({ uuid: row.uuid, ign: row.ign, pieces, sets, updated_at: row.updated_at });
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