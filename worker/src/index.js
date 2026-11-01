const MODEL = '@cf/moondream/moondream3.1-9B-A2B';
const MAX_REQUEST_BYTES = 7 * 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
  } });
}
function authorized(request, secret) {
  const header = request.headers.get('Authorization') || '';
  if (typeof secret !== 'string' || secret.length < 24 || !header.startsWith('Bearer ')) return false;
  const token = header.slice(7);
  if (token.length !== secret.length) return false;
  let mismatch = 0;
  for (let i = 0; i < secret.length; i++) mismatch |= token.charCodeAt(i) ^ secret.charCodeAt(i);
  return mismatch === 0;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' && request.method === 'GET')
      return json({ service: 'FotoStopa AI', status: 'ready', note: 'Testovací API vyžaduje autorizaci.' });
    if (url.pathname !== '/analyze') return json({ error: 'Nenalezeno.' }, 404);
    if (request.method !== 'POST') return json({ error: 'Použijte POST.' }, 405);
    if (!authorized(request, env.TEST_API_KEY)) return json({ error: 'Neplatný nebo chybějící testovací klíč.' }, 401);
    if (!env.AI) return json({ error: 'Chybí vazba Workers AI.' }, 503);
    const declaredSize = Number(request.headers.get('Content-Length'));
    if (declaredSize > MAX_REQUEST_BYTES) return json({ error: 'Požadavek je příliš velký.' }, 413);
    if (!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json'))
      return json({ error: 'Očekávám application/json.' }, 415);
    let body;
    try {
      const buffer = await request.arrayBuffer();
      if (buffer.byteLength > MAX_REQUEST_BYTES) return json({ error: 'Požadavek je příliš velký.' }, 413);
      body = JSON.parse(new TextDecoder().decode(buffer));
    } catch { return json({ error: 'Neplatný JSON.' }, 400); }
    const image = body?.image;
    if (typeof image !== 'string') return json({ error: 'Chybí pole image.' }, 400);
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
    if (!match) return json({ error: 'Obrázek musí být JPG, PNG nebo WebP jako Base64 data URI.' }, 400);
    const base64 = match[2];
    const approxBytes = Math.floor(base64.length * 3 / 4) -
      (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
    if (approxBytes <= 0 || approxBytes > MAX_IMAGE_BYTES)
      return json({ error: 'Obrázek musí mít nejvýše 4 MB.' }, 413);
    const question = [
      'Analyzuj fotografii jako pomůcku k výuce digitální stopy. Odpověz česky.',
      '1. Vypiš pět nejzajímavějších přímo viditelných detailů.',
      '2. U každého vysvětli, co by z něj šlo opatrně odvodit a co už by byla spekulace.',
      '3. Zmiň možné stopy místa, času, prostředí a případných osobních údajů, pouze pokud je fotografie skutečně obsahuje.',
      '4. Na závěr přidej tři stručná doporučení pro bezpečné sdílení.',
      'Nevymýšlej si neviditelné detaily. Neurčuj identitu lidí ani citlivé osobní charakteristiky.',
      'Nepředstírej znalost EXIF metadat: nejsou součástí této analýzy.',
      'U každého odhadu uveď, z jakého vizuálního důkazu vychází.',
      'Pokud si nejsi jistý, řekni to otevřeně.'
    ].join('\n');
    try {
      const result = await env.AI.run(MODEL, {
        task: 'query', image, question, reasoning: false,
        temperature: 0.2, max_tokens: 1300, stream: false
      });
      // Diagnostic only: response may contain inferred details from the uploaded photo.
      console.log('Moondream response:', JSON.stringify(result));
      return json({ success: true, model: MODEL, analysis: result?.answer ?? null,
        metrics: result?.metrics ?? null, finish_reason: result?.finish_reason ?? null });
    } catch (error) {
      // Never log uploaded photos, tokens, or request bodies.
      console.error('FotoStopa AI request failed:', {
        name: error?.name ?? 'Error', message: error?.message ?? 'Unknown error'
      });
      return json({ error: 'Analýza se nezdařila. Podrobnosti jsou v Cloudflare Logs.' }, 502);
    }
  }
};