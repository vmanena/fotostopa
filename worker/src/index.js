const MODEL = '@cf/moondream/moondream3.1-9B-A2B';
const TEXT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const MAX_REQUEST_BYTES = 7 * 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const ALLOWED_ORIGIN = 'https://vmanena.github.io';
function corsHeaders(request) {
  return request.headers.get('Origin') === ALLOWED_ORIGIN
    ? { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN, 'Vary': 'Origin' }
    : {};
}
function json(data, status = 200, request = null) {
  return new Response(JSON.stringify(data), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    ...(request ? corsHeaders(request) : {})
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
    if (request.method === 'OPTIONS' && ['/analyze', '/test-text', '/test-google'].includes(url.pathname)) {
      if (request.headers.get('Origin') !== ALLOWED_ORIGIN) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: {
        ...corsHeaders(request),
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '600'
      } });
    }
    if (url.pathname === '/' && request.method === 'GET')
      return json({ service: 'FotoStopa AI', status: 'ready', note: 'Testovací API vyžaduje autorizaci.' });
    const reply = (data, status = 200) => json(data, status, request);
    if (url.pathname !== '/analyze' && url.pathname !== '/test-qwen' && url.pathname !== '/test-text' && url.pathname !== '/test-google') return reply({ error: 'Nenalezeno.' }, 404);
    if (request.method !== 'POST') return reply({ error: 'Použijte POST.' }, 405);
    if (!authorized(request, env.TEST_API_KEY)) return reply({ error: 'Neplatný nebo chybějící testovací klíč.' }, 401);
    if (!env.AI && url.pathname !== '/test-google') return reply({ error: 'Chybí vazba Workers AI.' }, 503);
    const declaredSize = Number(request.headers.get('Content-Length'));
    if (declaredSize > MAX_REQUEST_BYTES) return reply({ error: 'Požadavek je příliš velký.' }, 413);
    if (!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json'))
      return reply({ error: 'Očekávám application/json.' }, 415);
    let body;
    try {
      const buffer = await request.arrayBuffer();
      if (buffer.byteLength > MAX_REQUEST_BYTES) return reply({ error: 'Požadavek je příliš velký.' }, 413);
      body = JSON.parse(new TextDecoder().decode(buffer));
    } catch { return reply({ error: 'Neplatný JSON.' }, 400); }
    if (url.pathname === '/test-qwen') {
      // Independent text-model test. No photo is sent to Qwen.
      const description = typeof body?.description === 'string' ? body.description.trim() : '';
      if (!description || description.length > 4000)
        return reply({ error: 'Pole description musí obsahovat 1 až 4000 znaků.' }, 400);
      try {
        const result = await env.AI.run(TEXT_MODEL, {
          messages: [
            { role: 'system', content: 'Jsi redaktor českých výukových materiálů o digitální stopě. Piš přirozenou, gramaticky správnou češtinou. Pracuj výhradně s dodaným popisem. Nepřidávej identitu osob, konkrétní místo ani čas, pokud nejsou doložené. Žádné úvahy o vlastním postupu.' },
            { role: 'user', content: 'Z následujícího popisu fotografie napiš nejvýše 130 slov česky. Nejprve dvě věty o tom, co je na snímku přímo vidět. Potom uveď dvě potenciálně odhalující stopy; u každé napiš, co může naznačovat a proč to není jisté. Nakonec jedno praktické doporučení pro sdílení. Pokud popis neobsahuje dvě smysluplné stopy, uveď jen jednu. Nepovažuj každý předmět automaticky za digitální stopu.\\n\\nPopis: ' + description }
          ],
          max_tokens: 1100,
          temperature: 0.1
        });
        const output = result?.result ?? result;
        const answer = output?.response ?? output?.choices?.[0]?.message?.content ?? output?.answer ?? null;
        return reply({ success: typeof answer === 'string' && answer.length > 0,
          model: TEXT_MODEL, analysis: answer, usage: result?.usage ?? output?.usage ?? null });
      } catch (error) {
        console.error('FotoStopa Qwen test failed:', {
          name: error?.name ?? 'Error', message: error?.message ?? 'Unknown error'
        });
        return reply({ error: 'Test jazykového modelu se nezdařil. Podrobnosti jsou v Cloudflare Logs.' }, 502);
      }
    }
    const image = body?.image;
    if (typeof image !== 'string') return reply({ error: 'Chybí pole image.' }, 400);
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
    if (!match) return reply({ error: 'Obrázek musí být JPG, PNG nebo WebP jako Base64 data URI.' }, 400);
    const base64 = match[2];
    const approxBytes = Math.floor(base64.length * 3 / 4) -
      (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
    if (approxBytes <= 0 || approxBytes > MAX_IMAGE_BYTES)
      return reply({ error: 'Obrázek musí mít nejvýše 4 MB.' }, 413);
    if (url.pathname === '/test-google') {
      if (!env.GOOGLE_VISION_API_KEY) return reply({ error: 'Google Vision není nakonfigurován.' }, 503);
      try {
        const response = await fetch('https://vision.googleapis.com/v1/images:annotate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-goog-api-key': env.GOOGLE_VISION_API_KEY },
          body: JSON.stringify({ requests: [{
            image: { content: base64 },
            features: [
              { type: 'TEXT_DETECTION', maxResults: 30 },
              { type: 'LABEL_DETECTION', maxResults: 20 },
              { type: 'LOGO_DETECTION', maxResults: 10 },
              { type: 'OBJECT_LOCALIZATION', maxResults: 20 }
            ]
          }] })
        });
        const data = await response.json();
        if (!response.ok || data?.responses?.[0]?.error)
          return reply({ error: 'Google Vision vrátil chybu.', status: data?.responses?.[0]?.error?.code ?? response.status }, 502);
        const result = data?.responses?.[0] ?? {};
        return reply({
          success: true,
          text: result.fullTextAnnotation?.text ?? result.textAnnotations?.[0]?.description ?? '',
          labels: (result.labelAnnotations ?? []).map(x => ({ name: x.description, score: x.score })),
          logos: (result.logoAnnotations ?? []).map(x => ({ name: x.description, score: x.score })),
          objects: (result.localizedObjectAnnotations ?? []).map(x => ({ name: x.name, score: x.score }))
        });
      } catch (error) {
        console.error('Google Vision request failed:', { name: error?.name ?? 'Error' });
        return reply({ error: 'Google Vision není dostupný.' }, 502);
      }
    }
    // Diagnostic-only vision test: ask specifically for legible text, without language-model rewriting.
    const textTest = url.pathname === '/test-text';
    const question = textTest
      ? 'Read and transcribe any legible text in this image exactly as written. Focus on badges, name tags, clothing, signs and logos. Do not guess unreadable letters. If nothing is legible, say "No legible text".'
      : 'What can you see in this image? Describe the main objects, visible text, and surroundings briefly.';
    try {
      const result = await env.AI.run(MODEL, {
        task: 'query', image, question, reasoning: false,
        temperature: 0.2, max_tokens: 1300, stream: false
      });
      const output = result?.result ?? result;
      if (textTest) {
        return reply({ success: typeof output?.answer === 'string' && !!output.answer.trim(),
          model: MODEL, transcription: output?.answer ?? null,
          metrics: output?.metrics ?? null, finish_reason: output?.finish_reason ?? null });
      }
      const description = output?.answer;
      if (typeof description !== 'string' || !description.trim()) {
        return reply({ error: 'Obrazový model nevrátil použitelný popis fotografie.' }, 502);
      }
      let languageResult;
      try {
        languageResult = await env.AI.run(TEXT_MODEL, {
          messages: [
            { role: 'system', content: 'Jsi zkušený český lektor digitální bezpečnosti. Vytváříš přesné a srozumitelné výukové analýzy. Podkladem je pouze anglický popis fotografie, nikoli fotografie samotná. Nezměň ani nepřekládej nepřesně konkrétní předměty (shirt znamená košile jen pokud je uvedeno shirt; white shirt je bílá košile, nikoli tričko). Neodhaduj identitu osob, polohu ani čas bez důkazů. Nevymýšlej nové vizuální detaily. Věcně odlišuj pozorování, hypotézy a neznámé informace. Piš přirozenou češtinou.' },
            { role: 'user', content: 'Na základě NÁSLEDUJÍCÍHO POPISU fotografie napiš krátkou českou analýzu pro výuku digitální stopy (maximálně 180 slov). Použij čtyři označené části: VIDITELNÉ SKUTEČNOSTI (stručně věrně popiš), MOŽNÉ STOPY (nanejvýš tři relevantní vodítka; u každého uveď důkaz a nejistotu; pokud žádné nejsou, výslovně to řekni), CO NELZE ZJISTIT (konkrétní hranice poznání), BEZPEČNÉ SDÍLENÍ (jedno praktické doporučení týkající se soukromí, nikoli autorských práv). Nevydávej domněnky za fakta. Nepovažuj každý předmět za odhalující stopu. Metadata EXIF nemáš k dispozici.\\n\\nPOPIS:\\n' + description }
          ],
          max_tokens: 850,
          temperature: 0.1
        });
      } catch (error) {
        console.error('FotoStopa language model failed:', {
          name: error?.name ?? 'Error', message: error?.message ?? 'Unknown error'
        });
        return reply({ error: 'Česká analýza se nezdařila.', visual_description: description,
          visual_model: MODEL }, 502);
      }
      const textOutput = languageResult?.result ?? languageResult;
      const analysis = textOutput?.response ?? textOutput?.choices?.[0]?.message?.content ?? textOutput?.answer;
      if (typeof analysis !== 'string' || !analysis.trim()) {
        return reply({ error: 'Jazykový model nevrátil použitelný text.',
          visual_description: description, visual_model: MODEL }, 502);
      }
      return reply({ success: true, model: TEXT_MODEL, visual_model: MODEL,
        visual_description: description, analysis,
        metrics: { vision: output?.metrics ?? null, language: languageResult?.usage ?? textOutput?.usage ?? null } });
    } catch (error) {
      // Never log uploaded photos, tokens, or request bodies.
      console.error('FotoStopa AI request failed:', {
        name: error?.name ?? 'Error', message: error?.message ?? 'Unknown error'
      });
      return reply({ error: 'Analýza se nezdařila. Podrobnosti jsou v Cloudflare Logs.' }, 502);
    }
  }
};