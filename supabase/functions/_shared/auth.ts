type JwtClaims = { sub?: unknown; aud?: unknown; exp?: unknown };

// Use only in Edge Functions with verify_jwt enabled. The gateway verifies the
// signature; this helper validates the identity claims consumed by the function.
export function verifiedUserId(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  const token = authorization?.replace(/^Bearer\s+/i, '');
  const payloadPart = token?.split('.')[1];
  if (!payloadPart) return null;
  try {
    const base64 = payloadPart.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(payloadPart.length / 4) * 4, '=');
    const claims = JSON.parse(atob(base64)) as JwtClaims;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (typeof claims.sub !== 'string' || !/^[0-9a-f-]{36}$/i.test(claims.sub)) return null;
    if (!audiences.includes('authenticated')) return null;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) return null;
    return claims.sub;
  } catch {
    return null;
  }
}
