'use server';

import { getRequestContext, redirect } from '@rshono/core/server';
import { fakeDB, type User } from './db';

// Not exported — a 'use server' module may only export async functions.
/**
 * A form field as trimmed text. `FormData.get` also yields `File` for a file input, which stringifies to
 * `[object File]`; anything that is not already a string is treated as absent.
 */
function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export async function createUser(data: { name: string; email: string }): Promise<User> {
  if (!data.name.trim() || !data.email.includes('@')) {
    throw new Error('A name and a valid email are required.');
  }
  return fakeDB.createUser({ name: data.name.trim(), email: data.email.trim() });
}

export interface LoginState {
  error?: string;
}

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = field(formData, 'email');
  if (!email.includes('@')) return { error: 'Enter a valid email address.' };
  getRequestContext().cookies.set('session', encodeURIComponent(email), { path: '/', httpOnly: true, sameSite: 'Lax' });
  redirect('/dashboard');
}

/**
 * The other half of `login`, and the one that exercises a redirect on the *client-initiated* action
 * path: a `'use client'` button calls this directly, so the reply comes back as a flight payload
 * carrying `redirect` rather than as an HTTP 3xx. Takes no arguments, which is what makes it callable
 * from a test with a plain `[]` body.
 */
export async function logout(): Promise<never> {
  const ctx = getRequestContext();
  ctx.cookies.delete('session', { path: '/' });
  redirect('/login');
}

export interface CrashState {
  ok?: boolean;
}

/**
 * Always throws — a deliberate demo that a progressive-enhancement form action
 * failure is routed to the `error` page even without JavaScript, rather than
 * swallowed into a blank 500. Exercised by the e2e suite.
 */
export async function crash(_prev: CrashState, _formData: FormData): Promise<CrashState> {
  throw new Error('Intentional server-action failure (progressive-enhancement demo).');
}

export interface SignupState {
  message?: string;
  error?: string;
}

export async function signup(_prev: SignupState, formData: FormData): Promise<SignupState> {
  const name = field(formData, 'name');
  const email = field(formData, 'email');
  if (!name || !email.includes('@')) {
    return { error: 'Please provide a name and a valid email address.' };
  }
  const user = await fakeDB.createUser({ name, email });
  getRequestContext().cookies.set('welcomed', encodeURIComponent(user.name), { path: '/', httpOnly: true });
  return { message: `Welcome aboard, ${user.name}! (user #${user.id})` };
}

/**
 * The *other* shape a form action takes, and the one nothing else here covers: a server component renders
 * `<form action={subscribe}>`, so React posts a single `$ACTION_ID_<id>` field and there is no
 * `useActionState` and no form state to decode. The three forms above are all the `useActionState` shape.
 *
 * One argument, the form's own data, because that is what React binds for this shape.
 */
export async function subscribe(formData: FormData): Promise<void> {
  const email = field(formData, 'email');
  if (!email.includes('@')) return;
  getRequestContext().cookies.set('subscribed', email, { path: '/', httpOnly: true });
}
