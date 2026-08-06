import { NextRequest, NextResponse } from 'next/server';

const BOT_API_URL = process.env.BOT_API_URL;

const TIMEOUT_MS = 15000;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxyRequest(request, params, 'GET');
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxyRequest(request, params, 'POST');
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxyRequest(request, params, 'DELETE');
}

async function proxyRequest(
  request: NextRequest,
  params: Promise<{ path: string[] }>,
  method: string
) {
  if (!BOT_API_URL) {
    return NextResponse.json(
      { error: 'BOT_API_URL environment variable is not configured' },
      { status: 500 }
    );
  }

  const { path } = await params;
  const targetPath = path.join('/');
  const targetUrl = `${BOT_API_URL.replace(/\/+$/, '')}/${targetPath}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const fetchOptions: RequestInit = {
      method,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (method === 'POST' || method === 'DELETE') {
      const body = await request.text();
      if (body) {
        fetchOptions.body = body;
      }
    }

    const response = await fetch(targetUrl, fetchOptions);
    clearTimeout(timeoutId);

    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      const data = await response.json();
      return NextResponse.json(data, { status: response.status });
    }

    const text = await response.text();
    return new NextResponse(text, {
      status: response.status,
      headers: {
        'Content-Type': contentType || 'text/plain',
      },
    });
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof DOMException && error.name === 'AbortError') {
      return NextResponse.json(
        { error: 'Request to bot timed out', code: 'TIMEOUT' },
        { status: 504 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to connect to bot', code: 'CONNECTION_ERROR' },
      { status: 502 }
    );
  }
}
