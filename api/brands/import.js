'use strict';

// Vercel Node.js Function. No npm dependencies needed.
// The exact database columns are those used by the existing index.html importer.
const crypto = require('node:crypto');
const contactedHandles = new Set(require('../../data/contacted-handles.json'));

const MAX_BRANDS = 100;  // GPT Action: send batches of <= 100, ideally 50.
const MAX_BODY_BYTES = 200_000;

function send(res, status, payload) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(payload);
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const aa = crypto.createHash('sha256').update(a).digest();
  const bb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(aa, bb);
}
function normBrand(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}
function instagramHandle(raw) {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (!value) return null;
  if (/^(https?:\/\/)?(www\.)?instagram\.com\//i.test(value)) {
    try {
      const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
      if (!['instagram.com', 'www.instagram.com'].includes(url.hostname.toLowerCase())) return null;
      value = url.pathname.split('/').filter(Boolean)[0] || '';
    } catch { return null; }
  } else if (/^https?:\/\//i.test(value) || value.includes('/')) {
    return null;
  }
  value = value.replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(value) || value.endsWith('.') || value.includes('..')) return null;
  if (['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'direct'].includes(value)) return null;
  return value;
}
function tiktokHandle(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let value = raw.trim();
  if (/^(https?:\/\/)?(www\.)?tiktok\.com\//i.test(value)) {
    try {
      const u = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
      if (!['www.tiktok.com', 'tiktok.com'].includes(u.hostname.toLowerCase())) return null;
      value = u.pathname.split('/').filter(Boolean)[0] || '';
    } catch { return null; }
  }
  value = value.replace(/^@/, '');
  return /^[a-zA-Z0-9._]{2,24}$/.test(value) ? value : null;
}
function toFrench(value) {
  return value === true || value === 1 || (typeof value === 'string' && /^(1|true|vrai|oui|yes)$/i.test(value.trim()));
}
function cleanBrand(r, index) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return {error: {index, reason:'invalid_record'}};
  const brandRaw = r.brand ?? r.marque ?? r.nom ?? r.name ?? '';
  const brand = typeof brandRaw === 'string' ? brandRaw.trim() : '';
  const handle = instagramHandle(r.handle ?? r.instagram_url ?? r.instagram ?? r.insta ?? '');
  if (!brand || brand.length > 150) return {error:{index, reason:'invalid_brand'}};
  if (!handle) return {error:{index, brand, reason:'invalid_instagram_handle'}};
  const categoryRaw = r.category ?? r.categorie ?? r['catégorie'] ?? 'Import';
  const category = typeof categoryRaw === 'string' && categoryRaw.trim() ? categoryRaw.trim() : 'Import';
  if (category.length > 100) return {error:{index, brand, reason:'invalid_category'}};
  const norm = normBrand(brand);
  if (!norm) return {error:{index, brand, reason:'invalid_brand'}};
  if (contactedHandles.has(handle)) return {error:{index, brand, reason:'already_contacted_blacklist'}};
  return {record:{
    brand, brand_norm:norm, handle,
    tt:tiktokHandle(r.tt ?? r.tiktok ?? ''),
    fr:toFrench(r.fr ?? r.francaise ?? false),
    category,
    added_by:'Instagram Brand Scout (GPT Action)'
  }};
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, {success:false, error:'method_not_allowed'});
  }
  const apiKey = process.env.DMFLEMME_IMPORT_API_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!apiKey || !serviceKey || !supabaseUrl) {
    return send(res, 503, {success:false, error:'server_not_configured'});
  }
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ') || !safeEqual(auth.slice(7), apiKey)) {
    return send(res, 401, {success:false, error:'unauthorized'});
  }
  const bytes = Number(req.headers['content-length'] || 0);
  if (bytes > MAX_BODY_BYTES) return send(res, 413, {success:false, error:'payload_too_large'});
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return send(res,400,{success:false,error:'invalid_json'}); }
  }
  if (!body || !Array.isArray(body.brands) || body.brands.length < 1 || body.brands.length > MAX_BRANDS) {
    return send(res, 400, {success:false,error:'brands_must_contain_1_to_100_records'});
  }
  const clean = [];
  const rejected = [];
  const seenNames = new Set(), seenHandles = new Set();
  body.brands.forEach((r, i) => {
    const result = cleanBrand(r, i);
    if (result.error) return rejected.push(result.error);
    const row = result.record;
    if (seenNames.has(row.brand_norm) || seenHandles.has(row.handle)) {
      return rejected.push({index:i,brand:row.brand,reason:'duplicate_in_batch'});
    }
    seenNames.add(row.brand_norm); seenHandles.add(row.handle);
    clean.push(row);
  });
  if (!clean.length) return send(res, 200, {
    success:true, received:body.brands.length, imported:0, duplicates:0,
    rejected_count:rejected.length, rejected
  });
  let endpoint;
  try {
    const url = new URL('/rest/v1/brands', supabaseUrl);
    if (url.protocol !== 'https:') throw new Error('bad protocol');
    url.searchParams.set('on_conflict', 'brand_norm');
    endpoint = url.toString();
  } catch { return send(res,503,{success:false,error:'invalid_supabase_url'}); }

  try {
    // Import is idempotent on the same 'brand_norm' unique key as the UI importer.
    const response = await fetch(endpoint, {
      method:'POST',
      headers:{
        apikey:serviceKey,
        Authorization:`Bearer ${serviceKey}`,
        'Content-Type':'application/json',
        Prefer:'resolution=ignore-duplicates,return=representation'
      },
      body:JSON.stringify(clean),
      signal:AbortSignal.timeout(15000)
    });
    if (!response.ok) {
      // Avoid exposing database details or service credentials to the GPT.
      console.error('Brand Scout Supabase insert failed:', response.status, (await response.text()).slice(0,500));
      return send(res, 502, {success:false, error:'database_import_failed', status:response.status});
    }
    const inserted = await response.json();
    if (!Array.isArray(inserted)) return send(res,502,{success:false,error:'unexpected_database_response'});
    return send(res,200,{
      success:true,
      received:body.brands.length,
      imported:inserted.length,
      duplicates:clean.length - inserted.length,
      rejected_count:rejected.length,
      rejected
    });
  } catch (error) {
    console.error('Brand Scout API network failure:', error.message);
    return send(res,502,{success:false,error:'database_unavailable'});
  }
};
module.exports._test = {normBrand, instagramHandle, cleanBrand};
