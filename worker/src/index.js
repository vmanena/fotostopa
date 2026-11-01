const MODEL = '@cf/moondream/moondream3.1-9B-A2B';
const TEXT_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';
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
    if (url.pathname !== '/analyze' && url.pathname !== '/test-qwen') return json({ error: 'Nenalezeno.' }, 404);
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
    if (url.pathname === '/test-qwen') {
      // Independent text-model test. No photo is sent to Qwen.
      const description = typeof body?.description === 'string' ? body.description.trim() : '';
      if (!description || description.length > 4000)
        return json({ error: 'Pole description musí obsahovat 1 až 4000 znaků.' }, 400);
      try {
        const result = await env.AI.run(TEXT_MODEL, {
          messages: [
            { role: 'system', content: 'Jsi asistent pro českou výuku digitální stopy. Piš výhradně česky. Vycházej jen z dodaného popisu fotografie. Rozlišuj viditelné skutečnosti, možné závěry a nepodložené spekulace. Nepřidávej nepozorované detaily ani identitu lidí. Odpovídej stručně, bez interních úvah.' },
            { role: 'user', content: 'Z tohoto anglického popisu fotografie připrav česky: (1) stručný popis viditelných prvků, (2) nejvýše tři možné digitální stopy s vysvětlením důkazu a nejistoty, (3) dvě doporučení pro bezpečné sdílení. Popis:\\n' + description }
          ],
          max_tokens: 650,
          temperature: 0.2
        });
        const output = result?.result ?? result;
        const answer = output?.response ?? output?.choices?.[0]?.message?.content ?? output?.answer ?? null;
        return json({ success: typeof answer === 'string' && answer.length > 0,
          model: TEXT_MODEL, analysis: answer, usage: result?.usage ?? output?.usage ?? null });
      } catch (error) {
        console.error('FotoStopa Qwen test failed:', {
          name: error?.name ?? 'Error', message: error?.message ?? 'Unknown error'
        });
        return json({ error: 'Test jazykového modelu se nezdařil. Podrobnosti jsou v Cloudflare Logs.' }, 502);
      }
    }
    const image = body?.image;
    if (typeof image !== 'string') return json({ error: 'Chybí pole image.' }, 400);
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
    if (!match) return json({ error: 'Obrázek musí být JPG, PNG nebo WebP jako Base64 data URI.' }, 400);
    const base64 = match[2];
    const approxBytes = Math.floor(base64.length * 3 / 4) -
      (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
    if (approxBytes <= 0 || approxBytes > MAX_IMAGE_BYTES)
      return json({ error: 'Obrázek musí mít nejvýše 4 MB.' }, 413);
    // First validate basic image understanding before requesting structured analysis.
    const question = 'What can you see in this image? Describe the main objects, visible text, and surroundings briefly.';
    try {
      const result = await env.AI.run(MODEL, {
        task: 'query', image, question, reasoning: false,
        temperature: 0.2, max_tokens: 1300, stream: false
      });
      const output = result?.result ?? result;
      return json({ success: true, model: MODEL, analysis: output?.answer ?? null,
        metrics: output?.metrics ?? null, finish_reason: output?.finish_reason ?? null });
    } catch (error) {
      // Never log uploaded photos, tokens, or request bodies.
      console.error('FotoStopa AI request failed:', {
        name: error?.name ?? 'Error', message: error?.message ?? 'Unknown error'
      });
      return json({ error: 'Analýza se nezdařila. Podrobnosti jsou v Cloudflare Logs.' }, 502);
    }
  }
};