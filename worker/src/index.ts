interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run<T = unknown>(): Promise<T>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

type ExportedHandler<Env = unknown> = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response;
};

export interface Env {
  DB: D1Database;
  TURNSTILE_SECRET: string;
  ALLOWED_ORIGINS?: string;
}

type FormType = 'family' | 'donor' | 'collaborator';

type SubmissionResult =
  | { success: true; table: string; parameters: unknown[] }
  | { success: false; error: string };

type FamilySubmission = {
  name: string;
  email: string;
  region: string;
  interest: string | null;
};

type DonorSubmission = {
  name: string;
  email: string;
  focus: string | null;
  message: string | null;
};

type CollaboratorSubmission = {
  name: string;
  email: string;
  expertise: string | null;
  idea: string | null;
};

const DEFAULT_ALLOWED_ORIGINS = ['https://tymai-dev.github.io', 'https://halohub.com'];

const baseCorsHeaders: Record<string, string> = {
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
};

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default {
  async fetch(request, env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const allowedOrigins = getAllowedOrigins(env.ALLOWED_ORIGINS);

    if (request.method === 'OPTIONS') {
      const corsHeaders = createCorsHeaders(origin, allowedOrigins);
      if (!corsHeaders) {
        return new Response(null, { status: 403, headers: baseErrorHeaders() });
      }
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return jsonResponse(
        { ok: false, error: 'Method not allowed. Use POST.' },
        405,
        mergeHeaders(baseErrorHeaders(), createCorsHeaders(origin, allowedOrigins)),
      );
    }

    const corsHeaders = createCorsHeaders(origin, allowedOrigins);
    if (origin && !corsHeaders) {
      return jsonResponse(
        { ok: false, error: 'Origin not allowed.' },
        403,
        mergeHeaders(baseErrorHeaders(), baseCorsHeaders),
      );
    }

    const contentType = request.headers.get('Content-Type') || '';
    if (!contentType.toLowerCase().includes('application/json')) {
      return jsonResponse(
        { ok: false, error: 'Content-Type must be application/json.' },
        400,
        mergeHeaders(baseErrorHeaders(), corsHeaders),
      );
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch (error) {
      return jsonResponse(
        { ok: false, error: 'Invalid JSON payload.' },
        400,
        mergeHeaders(baseErrorHeaders(), corsHeaders),
      );
    }

    if (!isSubmissionPayload(payload)) {
      return jsonResponse(
        { ok: false, error: 'Missing or invalid submission payload.' },
        400,
        mergeHeaders(baseErrorHeaders(), corsHeaders),
      );
    }

    const { formType, data } = payload;
    const token = extractTurnstileToken(payload);

    if (!token) {
      return jsonResponse(
        { ok: false, error: 'Turnstile token is required.' },
        400,
        mergeHeaders(baseErrorHeaders(), corsHeaders),
      );
    }

    const verification = await verifyTurnstileToken(token, env.TURNSTILE_SECRET, request);
    if (!verification.success) {
      return jsonResponse(
        { ok: false, error: verification.error },
        400,
        mergeHeaders(baseErrorHeaders(), corsHeaders),
      );
    }

    const submissionResult = validateSubmission(formType, data);
    if (!submissionResult.success) {
      return jsonResponse(
        { ok: false, error: submissionResult.error },
        400,
        mergeHeaders(baseErrorHeaders(), corsHeaders),
      );
    }

    try {
      await env.DB.prepare(getInsertStatement(submissionResult.table))
        .bind(...submissionResult.parameters)
        .run();
    } catch (error) {
      return jsonResponse(
        { ok: false, error: 'Unable to record submission.' },
        500,
        mergeHeaders(baseErrorHeaders(), corsHeaders),
      );
    }

    return jsonResponse({ ok: true }, 200, mergeHeaders(baseSuccessHeaders(), corsHeaders));
  },
} satisfies ExportedHandler<Env>;

function getAllowedOrigins(value?: string): string[] {
  if (!value) {
    return DEFAULT_ALLOWED_ORIGINS;
  }

  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function createCorsHeaders(origin: string | null, allowed: string[]): HeadersInit | null {
  const headers = new Headers(baseCorsHeaders);
  if (!origin) {
    return headers;
  }

  if (allowed.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    return headers;
  }

  return null;
}

function mergeHeaders(...sources: (HeadersInit | null | undefined)[]): Headers {
  const headers = new Headers();
  for (const source of sources) {
    if (!source) continue;
    const iterable = source instanceof Headers ? source.entries() : Object.entries(source);
    for (const [key, value] of iterable) {
      headers.set(key, value);
    }
  }
  return headers;
}

function baseErrorHeaders(): HeadersInit {
  return { 'Content-Type': 'application/json; charset=utf-8' };
}

function baseSuccessHeaders(): HeadersInit {
  return { 'Content-Type': 'application/json; charset=utf-8' };
}

function jsonResponse(body: unknown, status = 200, headers?: Headers): Response {
  const responseHeaders = headers ? new Headers(headers) : new Headers();
  if (!responseHeaders.has('Content-Type')) {
    responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
  }
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

type SubmissionPayload = {
  formType: FormType;
  data: Record<string, unknown>;
  turnstileToken?: string;
  'cf-turnstile-response'?: string;
};

function extractTurnstileToken(payload: SubmissionPayload): string | undefined {
  if (payload.turnstileToken && payload.turnstileToken.trim().length > 0) {
    return payload.turnstileToken;
  }

  const legacyToken = payload['cf-turnstile-response'];
  if (legacyToken && legacyToken.trim().length > 0) {
    return legacyToken;
  }

  return undefined;
}

function isSubmissionPayload(value: unknown): value is SubmissionPayload {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<SubmissionPayload>;
  if (
    !(
      candidate.formType === 'family' ||
      candidate.formType === 'donor' ||
      candidate.formType === 'collaborator'
    )
  ) {
    return false;
  }

  if (!candidate.data || typeof candidate.data !== 'object') {
    return false;
  }

  const token = extractTurnstileToken(candidate as SubmissionPayload);
  return typeof token === 'string';
}

async function verifyTurnstileToken(token: string, secret: string, request: Request) {
  const remoteIp = request.headers.get('CF-Connecting-IP') ?? undefined;
  const formData = new URLSearchParams();
  formData.set('secret', secret);
  formData.set('response', token);
  if (remoteIp) {
    formData.set('remoteip', remoteIp);
  }

  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: formData,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    if (!response.ok) {
      return { success: false, error: 'Unable to verify Turnstile token.' };
    }

    const verification = (await response.json()) as { success: boolean; ['error-codes']?: string[] };
    if (!verification.success) {
      const errorCode = verification['error-codes']?.join(', ') ?? 'verification_failed';
      return { success: false, error: `Turnstile verification failed: ${errorCode}.` };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: 'Turnstile verification error.' };
  }
}

function validateSubmission(formType: FormType, data: Record<string, unknown>): SubmissionResult {
  switch (formType) {
    case 'family':
      return validateFamily(data);
    case 'donor':
      return validateDonor(data);
    case 'collaborator':
      return validateCollaborator(data);
    default:
      return { success: false, error: 'Unsupported form type.' };
  }
}

function validateFamily(data: Record<string, unknown>): SubmissionResult {
  const errors: string[] = [];
  const name = sanitizeField(data.name, 'Name', { required: true, errors });
  const email = sanitizeEmail(data.email, errors);
  const region = sanitizeField(data.region, 'City / Region', { required: true, errors });
  const interest = sanitizeField(data.interest, 'Interest', { required: false, errors, maxLength: 1000 });

  if (errors.length > 0) {
    return { success: false, error: errors.join(' ') };
  }

  const submission: FamilySubmission = {
    name,
    email,
    region,
    interest: interest || null,
  };

  return {
    success: true,
    table: 'families',
    parameters: [submission.name, submission.email, submission.region, submission.interest],
  };
}

function validateDonor(data: Record<string, unknown>): SubmissionResult {
  const errors: string[] = [];
  const name = sanitizeField(data.name, 'Name / Organization', { required: true, errors });
  const email = sanitizeEmail(data.email, errors);
  const focus = sanitizeField(data.focus, 'Focus area', { required: false, errors, maxLength: 500 });
  const message = sanitizeField(data.message, 'Message', { required: false, errors, maxLength: 1500 });

  if (errors.length > 0) {
    return { success: false, error: errors.join(' ') };
  }

  const submission: DonorSubmission = {
    name,
    email,
    focus: focus || null,
    message: message || null,
  };

  return {
    success: true,
    table: 'donors',
    parameters: [submission.name, submission.email, submission.focus, submission.message],
  };
}

function validateCollaborator(data: Record<string, unknown>): SubmissionResult {
  const errors: string[] = [];
  const name = sanitizeField(data.name, 'Name / Organization', { required: true, errors });
  const email = sanitizeEmail(data.email, errors);
  const expertise = sanitizeField(data.expertise, 'Expertise', { required: false, errors, maxLength: 500 });
  const idea = sanitizeField(data.idea, 'Idea', { required: false, errors, maxLength: 1500 });

  if (errors.length > 0) {
    return { success: false, error: errors.join(' ') };
  }

  const submission: CollaboratorSubmission = {
    name,
    email,
    expertise: expertise || null,
    idea: idea || null,
  };

  return {
    success: true,
    table: 'collaborators',
    parameters: [submission.name, submission.email, submission.expertise, submission.idea],
  };
}

function sanitizeField(
  value: unknown,
  label: string,
  options: { required: boolean; errors: string[]; maxLength?: number },
): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (options.required && raw.length === 0) {
    options.errors.push(`${label} is required.`);
  }
  if (options.maxLength && raw.length > options.maxLength) {
    options.errors.push(`${label} must be fewer than ${options.maxLength} characters.`);
  }
  return raw;
}

function sanitizeEmail(value: unknown, errors: string[]): string {
  const email = typeof value === 'string' ? value.trim() : '';
  if (email.length === 0) {
    errors.push('Email is required.');
    return email;
  }
  if (!emailRegex.test(email)) {
    errors.push('Email must be a valid address.');
  }
  if (email.length > 320) {
    errors.push('Email must be fewer than 320 characters.');
  }
  return email;
}

function getInsertStatement(table: string): string {
  switch (table) {
    case 'families':
      return `INSERT INTO families (name, email, region, interest) VALUES (?1, ?2, ?3, ?4);`;
    case 'donors':
      return `INSERT INTO donors (name, email, focus, message) VALUES (?1, ?2, ?3, ?4);`;
    case 'collaborators':
      return `INSERT INTO collaborators (name, email, expertise, idea) VALUES (?1, ?2, ?3, ?4);`;
    default:
      throw new Error('Unknown table.');
  }
}
