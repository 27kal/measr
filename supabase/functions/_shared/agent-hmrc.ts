function allowedGovUk(url: URL): boolean {
  return url.protocol === 'https:' && (url.hostname === 'www.gov.uk' || url.hostname.endsWith('.gov.uk'));
}

export async function searchHmrc(query: string) {
  const url = new URL('https://www.gov.uk/api/search.json');
  url.searchParams.set('q', `${query} HMRC`);
  url.searchParams.set('count', '8');
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`GOV.UK search failed (${response.status})`);
  const payload = await response.json() as { results?: Array<Record<string, unknown>> };
  return (payload.results ?? []).map(result => ({
    title: String(result.title ?? ''),
    description: String(result.description ?? ''),
    url: new URL(String(result.link ?? '/'), 'https://www.gov.uk').toString()
  })).filter(result => allowedGovUk(new URL(result.url)));
}

export async function fetchHmrcPage(value: string) {
  const requested = new URL(value);
  if (!allowedGovUk(requested)) throw new Error('Only HTTPS pages on GOV.UK may be fetched');
  const response = await fetch(requested, { redirect: 'follow', headers: { accept: 'text/html,text/plain' } });
  if (!response.ok || !allowedGovUk(new URL(response.url))) throw new Error(`GOV.UK fetch failed (${response.status})`);
  const html = await response.text();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  return { url: response.url, text: text.slice(0, 20_000), truncated: text.length > 20_000 };
}
