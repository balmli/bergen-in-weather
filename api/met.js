// Vercel serverless proxy for MET Norway (they require an identifying User-Agent, which browsers can't set)
export default async function handler(req, res) {
  try {
    const r = await fetch('https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=60.3855&lon=5.333', {
      headers: { 'User-Agent': 'bergen-in-weather/0.1 (personal visualisation project)' },
    });
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
    res.status(r.status).setHeader('Content-Type', 'application/json').send(await r.text());
  } catch (e) { res.status(502).json({ error: String(e) }); }
}
