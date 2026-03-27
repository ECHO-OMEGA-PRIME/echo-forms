/**
 * Echo Forms v1.0.0 — AI-Powered Form Builder & Survey System
 * Cloudflare Worker with Hono, D1, KV, service bindings
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';

interface Env { DB: D1Database; CACHE: KVNamespace; ENGINE_RUNTIME: Fetcher; SHARED_BRAIN: Fetcher; ECHO_API_KEY?: string; }
interface RLState { c: number; t: number }

// TODO: Consider batching sequential D1 queries with db.batch() for performance

// TODO: Consider batching sequential D1 queries with db.batch() for performance

const app = new Hono<{ Bindings: Env }>();
app.use('*', cors({ origin: '*', allowMethods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'], allowHeaders: ['Content-Type','Authorization','X-Tenant-ID','X-Echo-API-Key'] }));

const uid = () => crypto.randomUUID();
const sanitize = (s: string, max = 5000) => s?.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').slice(0, max) ?? '';
const sanitizeBody = (o: Record<string, unknown>) => { const r: Record<string, unknown> = {}; for (const [k, v] of Object.entries(o)) r[k] = typeof v === 'string' ? sanitize(v) : v; return r; };
const tid = (c: any) => c.req.header('X-Tenant-ID') || c.req.query('tenant_id') || '';
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });

async function rateLimit(kv: KVNamespace, key: string, limit: number, windowSec = 60): Promise<boolean> {
  const rlKey = `rl:${key}`; const now = Date.now();
  const raw = await kv.get(rlKey);
  if (!raw) { await kv.put(rlKey, JSON.stringify({ c: 1, t: now }), { expirationTtl: windowSec * 2 }); return false; }
  const st: RLState = JSON.parse(raw);
  const elapsed = (now - st.t) / 1000;
  const count = Math.max(0, st.c - (elapsed / windowSec) * limit) + 1;
  await kv.put(rlKey, JSON.stringify({ c: count, t: now }), { expirationTtl: windowSec * 2 });
  return count > limit;
}

app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === '/health' || path === '/status' || path.startsWith('/public/')) return next();
  const ip = c.req.header('cf-connecting-ip') || 'unknown';
  const isWrite = ['POST','PUT','PATCH','DELETE'].includes(c.req.method);
  if (await rateLimit(c.env.CACHE, `${ip}:${isWrite ? 'w' : 'r'}`, isWrite ? 60 : 200)) return json({ error: 'Rate limited' }, 429);
  return next();
});

// Auth middleware — require API key for write operations (public form submissions exempt)
app.use('*', async (c, next) => {
  const method = c.req.method;
  const path = new URL(c.req.url).pathname;
  if (method === 'GET' || method === 'OPTIONS' || method === 'HEAD' || path === '/health' || path === '/status' || path.startsWith('/public/')) return next();
  const apiKey = c.req.header('X-Echo-API-Key') || '';
  const bearer = (c.req.header('Authorization') || '').replace('Bearer ', '');
  const expected = c.env.ECHO_API_KEY;
  if (!expected || (apiKey !== expected && bearer !== expected)) {
    return json({ error: 'Unauthorized', message: 'Valid X-Echo-API-Key or Bearer token required for write operations' }, 401);
  }
  return next();
});

app.get('/health', (c) => json({ status: 'ok', service: 'echo-forms', version: '1.0.0', time: new Date().toISOString() }));

// ═══════════════ TENANTS ═══════════════
app.post('/tenants', async (c) => {
  const b = sanitizeBody(await c.req.json()); const id = uid();
  await c.env.DB.prepare('INSERT INTO tenants (id,name,email,plan) VALUES (?,?,?,?)').bind(id, b.name, b.email||null, b.plan||'free').run();
  return json({ id }, 201);
});
app.get('/tenants/:id', async (c) => {
  const r = await c.env.DB.prepare('SELECT * FROM tenants WHERE id=?').bind(c.req.param('id')).first();
  return r ? json(r) : json({ error: 'Not found' }, 404);
});

// ═══════════════ FORMS ═══════════════
app.get('/forms', async (c) => {
  const t = tid(c); const type = c.req.query('type'); const status = c.req.query('status');
  let q = 'SELECT id, tenant_id, title, description, type, status, response_count, view_count, created_at, updated_at FROM forms WHERE tenant_id=?';
  const p: string[] = [t];
  if (type) { q += ' AND type=?'; p.push(type); }
  if (status) { q += ' AND status=?'; p.push(status); }
  q += ' ORDER BY updated_at DESC';
  return json((await c.env.DB.prepare(q).bind(...p).all()).results);
});

app.post('/forms', async (c) => {
  const t = tid(c); const b = sanitizeBody(await c.req.json()); const id = uid();
  const slug = (b.slug as string) || (b.title as string).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50) + '-' + id.slice(0, 8);
  await c.env.DB.prepare('INSERT INTO forms (id,tenant_id,title,description,type,fields_json,settings_json,thank_you_message,redirect_url,notification_email,allow_multiple,requires_auth,start_date,end_date,max_responses,slug) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, t, b.title, b.description||null, b.type||'form', JSON.stringify(b.fields||[]), JSON.stringify(b.settings||{}), b.thank_you_message||'Thank you for your response!', b.redirect_url||null, b.notification_email||null, b.allow_multiple||0, b.requires_auth||0, b.start_date||null, b.end_date||null, b.max_responses||0, slug).run();
  return json({ id, slug }, 201);
});

app.get('/forms/:id', async (c) => {
  const r = await c.env.DB.prepare('SELECT * FROM forms WHERE id=? AND tenant_id=?').bind(c.req.param('id'), tid(c)).first();
  if (!r) return json({ error: 'Not found' }, 404);
  return json({ ...r, fields: JSON.parse((r as any).fields_json || '[]'), settings: JSON.parse((r as any).settings_json || '{}'), theme: JSON.parse((r as any).theme_json || '{}') });
});

app.put('/forms/:id', async (c) => {
  const t = tid(c); const b = sanitizeBody(await c.req.json());
  await c.env.DB.prepare('UPDATE forms SET title=coalesce(?,title),description=coalesce(?,description),fields_json=coalesce(?,fields_json),settings_json=coalesce(?,settings_json),thank_you_message=coalesce(?,thank_you_message),redirect_url=coalesce(?,redirect_url),notification_email=coalesce(?,notification_email),allow_multiple=coalesce(?,allow_multiple),requires_auth=coalesce(?,requires_auth),start_date=coalesce(?,start_date),end_date=coalesce(?,end_date),max_responses=coalesce(?,max_responses),theme_json=coalesce(?,theme_json),updated_at=datetime(\'now\') WHERE id=? AND tenant_id=?')
    .bind(b.title||null, b.description||null, b.fields ? JSON.stringify(b.fields) : null, b.settings ? JSON.stringify(b.settings) : null, b.thank_you_message||null, b.redirect_url||null, b.notification_email||null, b.allow_multiple??null, b.requires_auth??null, b.start_date||null, b.end_date||null, b.max_responses??null, b.theme ? JSON.stringify(b.theme) : null, c.req.param('id'), t).run();
  return json({ updated: true });
});

app.delete('/forms/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM responses WHERE form_id=? AND tenant_id=?').bind(c.req.param('id'), tid(c)).run();
  await c.env.DB.prepare('DELETE FROM forms WHERE id=? AND tenant_id=?').bind(c.req.param('id'), tid(c)).run();
  return json({ deleted: true });
});

// Publish/unpublish
app.post('/forms/:id/publish', async (c) => {
  await c.env.DB.prepare("UPDATE forms SET status='published',updated_at=datetime('now') WHERE id=? AND tenant_id=?").bind(c.req.param('id'), tid(c)).run();
  return json({ published: true });
});
app.post('/forms/:id/close', async (c) => {
  await c.env.DB.prepare("UPDATE forms SET status='closed',updated_at=datetime('now') WHERE id=? AND tenant_id=?").bind(c.req.param('id'), tid(c)).run();
  return json({ closed: true });
});

// Clone/duplicate form
app.post('/forms/:id/clone', async (c) => {
  const t = tid(c);
  const orig = await c.env.DB.prepare('SELECT * FROM forms WHERE id=? AND tenant_id=?').bind(c.req.param('id'), t).first() as any;
  if (!orig) return json({ error: 'Not found' }, 404);
  const id = uid(); const slug = orig.slug + '-copy-' + id.slice(0, 8);
  await c.env.DB.prepare('INSERT INTO forms (id,tenant_id,title,description,type,fields_json,settings_json,thank_you_message,redirect_url,notification_email,allow_multiple,requires_auth,theme_json,slug) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, t, orig.title + ' (Copy)', orig.description, orig.type, orig.fields_json, orig.settings_json, orig.thank_you_message, orig.redirect_url, orig.notification_email, orig.allow_multiple, orig.requires_auth, orig.theme_json, slug).run();
  return json({ id, slug }, 201);
});

// ═══════════════ PUBLIC FORM ACCESS (no tenant required) ═══════════════
app.get('/public/forms/:slug', async (c) => {
  const form = await c.env.DB.prepare("SELECT id, tenant_id, title, description, type, fields_json, settings_json, theme_json, thank_you_message, redirect_url, allow_multiple, requires_auth, start_date, end_date, max_responses, response_count FROM forms WHERE slug=? AND status='published'").bind(c.req.param('slug')).first() as any;
  if (!form) return json({ error: 'Form not found or not published' }, 404);
  // Check date limits
  const now = new Date().toISOString().split('T')[0];
  if (form.start_date && now < form.start_date) return json({ error: 'Form not yet open' }, 403);
  if (form.end_date && now > form.end_date) return json({ error: 'Form closed' }, 403);
  if (form.max_responses > 0 && form.response_count >= form.max_responses) return json({ error: 'Response limit reached' }, 403);
  // Track view
  await c.env.DB.prepare('INSERT INTO form_views (id,form_id,tenant_id,ip_address,user_agent) VALUES (?,?,?,?,?)').bind(uid(), form.id, form.tenant_id, c.req.header('cf-connecting-ip')||null, c.req.header('user-agent')?.slice(0,200)||null).run();
  await c.env.DB.prepare('UPDATE forms SET view_count=view_count+1 WHERE id=?').bind(form.id).run();
  return json({ ...form, fields: JSON.parse(form.fields_json), settings: JSON.parse(form.settings_json||'{}'), theme: JSON.parse(form.theme_json||'{}') });
});

// Submit response (public)
app.post('/public/forms/:slug/submit', async (c) => {
  const form = await c.env.DB.prepare("SELECT * FROM forms WHERE slug=? AND status='published'").bind(c.req.param('slug')).first() as any;
  if (!form) return json({ error: 'Form not found' }, 404);
  const now = new Date().toISOString().split('T')[0];
  if (form.end_date && now > form.end_date) return json({ error: 'Form closed' }, 403);
  if (form.max_responses > 0 && form.response_count >= form.max_responses) return json({ error: 'Limit reached' }, 403);
  const b = await c.req.json();
  const fields = JSON.parse(form.fields_json || '[]');
  // Validate required fields
  for (const field of fields) {
    if (field.required && !b.data?.[field.id] && b.data?.[field.id] !== 0) {
      return json({ error: `Field "${field.label}" is required` }, 400);
    }
  }
  // Calculate score for quizzes
  let score: number | null = null;
  if (form.type === 'quiz') {
    let correct = 0; let total = 0;
    for (const field of fields) {
      if (field.correct_answer !== undefined) {
        total++;
        if (b.data?.[field.id] === field.correct_answer) correct++;
      }
    }
    score = total > 0 ? (correct / total) * 100 : null;
  }
  const id = uid();
  await c.env.DB.prepare('INSERT INTO responses (id,form_id,tenant_id,data_json,metadata_json,ip_address,user_agent,referrer,completion_time_sec,score) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(id, form.id, form.tenant_id, JSON.stringify(b.data||{}), JSON.stringify(b.metadata||{}), c.req.header('cf-connecting-ip')||null, c.req.header('user-agent')?.slice(0,200)||null, c.req.header('referer')||null, b.completion_time_sec||null, score).run();
  await c.env.DB.prepare('UPDATE forms SET response_count=response_count+1,updated_at=datetime(\'now\') WHERE id=?').bind(form.id).run();
  // Trigger webhooks
  const hooks = await c.env.DB.prepare("SELECT * FROM webhooks WHERE form_id=? AND tenant_id=? AND is_active=1").bind(form.id, form.tenant_id).all();
  for (const hook of hooks.results as any[]) {
    try { fetch(hook.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'response.created', form_id: form.id, response_id: id, data: b.data }) }).catch(()=>{}); } catch {}
  }
  return json({ id, score, thank_you: form.thank_you_message, redirect: form.redirect_url }, 201);
});

// ═══════════════ RESPONSES ═══════════════
app.get('/forms/:formId/responses', async (c) => {
  const t = tid(c); const from = c.req.query('from'); const to = c.req.query('to');
  let q = 'SELECT * FROM responses WHERE form_id=? AND tenant_id=?'; const p: string[] = [c.req.param('formId'), t];
  if (from) { q += ' AND created_at>=?'; p.push(from); }
  if (to) { q += ' AND created_at<=?'; p.push(to); }
  q += ' ORDER BY created_at DESC LIMIT 500';
  const r = await c.env.DB.prepare(q).bind(...p).all();
  return json(r.results.map((row: any) => ({ ...row, data: JSON.parse(row.data_json||'{}'), metadata: JSON.parse(row.metadata_json||'{}') })));
});

app.get('/responses/:id', async (c) => {
  const r = await c.env.DB.prepare('SELECT * FROM responses WHERE id=? AND tenant_id=?').bind(c.req.param('id'), tid(c)).first() as any;
  if (!r) return json({ error: 'Not found' }, 404);
  return json({ ...r, data: JSON.parse(r.data_json||'{}'), metadata: JSON.parse(r.metadata_json||'{}') });
});

app.delete('/responses/:id', async (c) => {
  const r = await c.env.DB.prepare('SELECT form_id FROM responses WHERE id=? AND tenant_id=?').bind(c.req.param('id'), tid(c)).first() as any;
  if (r) { await c.env.DB.prepare('UPDATE forms SET response_count=MAX(0,response_count-1) WHERE id=?').bind(r.form_id).run(); }
  await c.env.DB.prepare('DELETE FROM responses WHERE id=? AND tenant_id=?').bind(c.req.param('id'), tid(c)).run();
  return json({ deleted: true });
});

// Export responses as CSV-compatible JSON
app.get('/forms/:formId/export', async (c) => {
  const t = tid(c);
  const form = await c.env.DB.prepare('SELECT fields_json FROM forms WHERE id=? AND tenant_id=?').bind(c.req.param('formId'), t).first() as any;
  if (!form) return json({ error: 'Not found' }, 404);
  const fields = JSON.parse(form.fields_json || '[]');
  const responses = await c.env.DB.prepare('SELECT data_json, created_at, ip_address, score FROM responses WHERE form_id=? AND tenant_id=? ORDER BY created_at').bind(c.req.param('formId'), t).all();
  const rows = (responses.results as any[]).map(r => {
    const data = JSON.parse(r.data_json || '{}');
    const row: Record<string, unknown> = { submitted_at: r.created_at, ip: r.ip_address, score: r.score };
    for (const f of fields) { row[f.label || f.id] = data[f.id] ?? ''; }
    return row;
  });
  return json({ fields: fields.map((f: any) => f.label || f.id), rows, total: rows.length });
});

// ═══════════════ ANALYTICS ═══════════════
app.get('/forms/:formId/analytics', async (c) => {
  const t = tid(c); const formId = c.req.param('formId');
  const form = await c.env.DB.prepare('SELECT * FROM forms WHERE id=? AND tenant_id=?').bind(formId, t).first() as any;
  if (!form) return json({ error: 'Not found' }, 404);
  const [totalResp, daily, avgTime, scoreStats, views] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) as cnt FROM responses WHERE form_id=?').bind(formId).first(),
    c.env.DB.prepare("SELECT date(created_at) as day, COUNT(*) as cnt FROM responses WHERE form_id=? AND created_at>=datetime('now','-30 days') GROUP BY day ORDER BY day").bind(formId).all(),
    c.env.DB.prepare('SELECT AVG(completion_time_sec) as avg_sec FROM responses WHERE form_id=? AND completion_time_sec>0').bind(formId).first(),
    c.env.DB.prepare('SELECT AVG(score) as avg_score, MIN(score) as min_score, MAX(score) as max_score FROM responses WHERE form_id=? AND score IS NOT NULL').bind(formId).first(),
    c.env.DB.prepare('SELECT COUNT(*) as cnt FROM form_views WHERE form_id=?').bind(formId).first(),
  ]);
  const fields = JSON.parse(form.fields_json || '[]');
  // Field-level analytics
  const fieldStats: Record<string, unknown> = {};
  const allResponses = await c.env.DB.prepare('SELECT data_json FROM responses WHERE form_id=? ORDER BY created_at DESC LIMIT 1000').bind(formId).all();
  for (const field of fields) {
    if (['select', 'radio', 'checkbox', 'rating', 'nps'].includes(field.type)) {
      const counts: Record<string, number> = {};
      for (const resp of allResponses.results as any[]) {
        const data = JSON.parse(resp.data_json || '{}');
        const val = data[field.id];
        if (val !== undefined && val !== null) {
          const key = Array.isArray(val) ? val.join(', ') : String(val);
          counts[key] = (counts[key] || 0) + 1;
        }
      }
      fieldStats[field.id] = { label: field.label, type: field.type, distribution: counts };
    }
  }
  const totalViews = (views as any)?.cnt || 0;
  const totalResponses = (totalResp as any)?.cnt || 0;
  return json({
    total_responses: totalResponses,
    total_views: totalViews,
    conversion_rate: totalViews > 0 ? ((totalResponses / totalViews) * 100).toFixed(1) : null,
    avg_completion_time_sec: (avgTime as any)?.avg_sec || null,
    score_stats: form.type === 'quiz' ? scoreStats : null,
    daily_responses: daily.results,
    field_analytics: fieldStats,
  });
});

// Overall analytics
app.get('/analytics/overview', async (c) => {
  const t = tid(c);
  const [forms, responses, views] = await Promise.all([
    c.env.DB.prepare("SELECT COUNT(*) as total, COUNT(CASE WHEN status='published' THEN 1 END) as published FROM forms WHERE tenant_id=?").bind(t).first(),
    c.env.DB.prepare("SELECT COUNT(*) as total, COUNT(CASE WHEN created_at>=datetime('now','-30 days') THEN 1 END) as last_30d FROM responses WHERE tenant_id=?").bind(t).first(),
    c.env.DB.prepare("SELECT COUNT(*) as total FROM form_views WHERE tenant_id=? AND created_at>=datetime('now','-30 days')").bind(t).first(),
  ]);
  return json({
    total_forms: (forms as any)?.total || 0,
    published_forms: (forms as any)?.published || 0,
    total_responses: (responses as any)?.total || 0,
    responses_30d: (responses as any)?.last_30d || 0,
    views_30d: (views as any)?.total || 0,
  });
});

// ═══════════════ TEMPLATES ═══════════════
app.get('/templates', async (c) => {
  const cat = c.req.query('category');
  let q = 'SELECT id, title, description, type, fields_json, template_category FROM forms WHERE is_template=1';
  const p: string[] = [];
  if (cat) { q += ' AND template_category=?'; p.push(cat); }
  q += ' ORDER BY title';
  return json((await c.env.DB.prepare(q).bind(...p).all()).results.map((r: any) => ({ ...r, fields: JSON.parse(r.fields_json||'[]') })));
});

app.post('/templates/:id/use', async (c) => {
  const t = tid(c);
  const tmpl = await c.env.DB.prepare('SELECT * FROM forms WHERE id=? AND is_template=1').bind(c.req.param('id')).first() as any;
  if (!tmpl) return json({ error: 'Template not found' }, 404);
  const id = uid(); const slug = tmpl.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50) + '-' + id.slice(0, 8);
  await c.env.DB.prepare('INSERT INTO forms (id,tenant_id,title,description,type,fields_json,settings_json,thank_you_message,slug) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(id, t, tmpl.title, tmpl.description, tmpl.type, tmpl.fields_json, tmpl.settings_json||'{}', tmpl.thank_you_message||'Thank you!', slug).run();
  return json({ id, slug }, 201);
});

// ═══════════════ WEBHOOKS ═══════════════
app.get('/forms/:formId/webhooks', async (c) => {
  return json((await c.env.DB.prepare('SELECT * FROM webhooks WHERE form_id=? AND tenant_id=?').bind(c.req.param('formId'), tid(c)).all()).results);
});
app.post('/forms/:formId/webhooks', async (c) => {
  const t = tid(c); const b = sanitizeBody(await c.req.json()); const id = uid();
  await c.env.DB.prepare('INSERT INTO webhooks (id,form_id,tenant_id,url,events,secret) VALUES (?,?,?,?,?,?)')
    .bind(id, c.req.param('formId'), t, b.url, b.events||'response.created', b.secret||null).run();
  return json({ id }, 201);
});

// ═══════════════ AI FEATURES ═══════════════
app.post('/ai/suggest-questions', async (c) => {
  const b = await c.req.json() as { topic: string; type?: string; count?: number };
  try {
    const aiRes = await c.env.ENGINE_RUNTIME.fetch('https://engine/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine_id: 'FN-01', query: `Generate ${b.count||5} form/survey questions for the topic: "${sanitize(b.topic, 200)}". Type: ${b.type||'survey'}. For each question provide: id (q1, q2...), label (question text), type (text/textarea/select/radio/checkbox/rating/nps/number/email/date), required (true/false), and options array if applicable. Return as JSON array.` }),
    });
    const ai = await aiRes.json() as any;
    return json({ questions: ai.response || ai });
  } catch { return json({ questions: 'AI unavailable', suggestion: 'Create questions manually' }); }
});

app.post('/ai/analyze-responses', async (c) => {
  const t = tid(c); const b = await c.req.json() as { form_id: string };
  const form = await c.env.DB.prepare('SELECT title, fields_json FROM forms WHERE id=? AND tenant_id=?').bind(b.form_id, t).first() as any;
  if (!form) return json({ error: 'Form not found' }, 404);
  const responses = await c.env.DB.prepare('SELECT data_json FROM responses WHERE form_id=? ORDER BY created_at DESC LIMIT 50').bind(b.form_id).all();
  const sampleData = (responses.results as any[]).slice(0, 20).map(r => JSON.parse(r.data_json || '{}'));
  try {
    const aiRes = await c.env.ENGINE_RUNTIME.fetch('https://engine/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine_id: 'FN-01', query: `Analyze ${responses.results.length} survey responses for "${form.title}". Fields: ${form.fields_json}. Sample responses (20): ${JSON.stringify(sampleData)}. Provide: key themes, sentiment analysis, notable patterns, actionable insights, and recommendations.` }),
    });
    const ai = await aiRes.json() as any;
    return json({ form_title: form.title, response_count: responses.results.length, analysis: ai.response || ai });
  } catch { return json({ analysis: 'AI unavailable' }); }
});

// ═══════════════ ACTIVITY LOG ═══════════════
app.get('/activity', async (c) => {
  return json((await c.env.DB.prepare('SELECT * FROM activity_log WHERE tenant_id=? ORDER BY created_at DESC LIMIT 100').bind(tid(c)).all()).results);
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // Daily cleanup: remove incomplete responses older than 30 days
    await env.DB.prepare("DELETE FROM responses WHERE is_complete=0 AND created_at < datetime('now','-30 days')").run();
    // Clean old views older than 90 days
    await env.DB.prepare("DELETE FROM form_views WHERE created_at < datetime('now','-90 days')").run();
    // Clean old activity logs older than 90 days
    await env.DB.prepare("DELETE FROM activity_log WHERE created_at < datetime('now','-90 days')").run();
  }
};
