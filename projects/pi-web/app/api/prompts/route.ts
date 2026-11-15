import { NextResponse } from 'next/server';
import { promptStore } from '@/lib/prompt-manager';
import { hasJsonContentType, isApiRequestAllowed } from '@/lib/request-security';

export const dynamic = 'force-dynamic';
function failure(error: unknown) {
  const value = error as { message?: string; status?: number };
  return NextResponse.json({ error: value.message || 'Prompt operation failed.' }, { status: value.status || 500 });
}
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: 'Untrusted API request' }, { status: 403 });
  try {
    const store = promptStore();
    const sessionId = new URL(req.url).searchParams.get('sessionId');
    return NextResponse.json({ ...await store.list(), binding: sessionId ? await store.binding(sessionId) : null });
  } catch (error) { return failure(error); }
}
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: 'Untrusted API request' }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: 'Content-Type must be application/json' }, { status: 415 });
  try {
    const body = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Expected a JSON object.' }, { status: 400 });
    const store = promptStore();
    switch (body.action) {
      case 'create': return NextResponse.json(await store.create(body.prompt));
      case 'update': return NextResponse.json(await store.update(body.id, body.prompt, body.revision));
      case 'delete': return NextResponse.json(await store.delete(body.id, body.revision));
      case 'activate': return NextResponse.json(await store.activate(body.id));
      default: return NextResponse.json({ error: 'Unknown prompt operation.' }, { status: 400 });
    }
  } catch (error) { return failure(error); }
}
