---
title: Usage
description: Putting it together — co-located actions, streamed data and optimistic updates, in the shapes most of an app is built from.
---

A client component imports a server function and calls it. That is the whole data layer:

```tsx
import { createNote } from './action'; // runs on the server, always

await createNote('Buy milk');
```

No `/api/notes`, no `fetch`, no JSON envelope, no route handler, no client cache to invalidate. The
import compiles to a reference — the function's body, and everything it imports, stays on the server.
Arguments and the return value are typed end to end, so renaming a field is a type error rather than a
runtime surprise.

Every example below talks to one module. What it wraps — Drizzle, Prisma, D1, a `Map` — changes nothing
above it:

```ts title="src/db.ts"
export interface Note {
  id: string;
  text: string;
  done: boolean;
}

export declare const db: {
  listNotes(): Promise<Note[]>;
  createNote(text: string): Promise<Note>;
  setDone(id: string, done: boolean): Promise<void>;
};
```

## Co-locating a component and its action

A component that mutates has two halves, and they change together. Keep them in one folder:

```
src/components/new-note/
  index.tsx    'use client' — the form
  action.ts    'use server' — what it calls
```

The framework attaches no meaning to either name — [`src/` is yours to arrange](/docs/project-layout) —
but the split earns its keep. `'use server'` is a **module-level** directive, and every export of such a
module is [a public endpoint](/docs/pages#every-action-is-a-public-endpoint). One small file per
component keeps that surface readable in a glance and sitting next to the only component that calls it;
a single `src/actions.ts` for the whole app grows into a list nobody audits.

## Forms: `useActionState`

The action takes the previous state and the submitted `FormData`, and returns the next state:

```ts title="src/components/new-note/action.ts"
'use server';

import { db } from '../../db';

export interface NewNoteState {
  error?: string;
}

export async function createNote(_prev: NewNoteState, form: FormData): Promise<NewNoteState> {
  const text = String(form.get('text') ?? '').trim();
  if (!text) return { error: 'A note needs some text.' };

  await db.createNote(text);
  return {};
}
```

`useActionState` wires it to the form and hands back the pending flag:

```tsx title="src/components/new-note/index.tsx"
'use client';

import { useActionState } from 'react';
import { createNote, type NewNoteState } from './action';

const empty: NewNoteState = {};

export function NewNote() {
  const [state, formAction, pending] = useActionState(createNote, empty);

  return (
    <form action={formAction}>
      <input name="text" placeholder="Buy milk" />
      <button disabled={pending}>{pending ? 'Saving…' : 'Add note'}</button>
      {state.error && <p role="alert">{state.error}</p>}
    </form>
  );
}
```

Two things fall out of this that normally cost work, and neither is something this component opted into —
both are [what a server action is](/docs/pages#server-actions). The form works **before hydration and with
JavaScript off**. And the action's response carries a fresh page payload, so a note list rendered elsewhere
on the page already shows the new note: nothing to refetch, no cache to invalidate.

Return validation failures, as above; don't throw them.
[Thrown action errors are redacted](/docs/pages#errors) in production, so the user would see nothing
useful.

## Direct calls: `useTransition`

Not every mutation is a form. A checkbox has typed arguments, not `FormData`:

```ts title="src/components/note-toggle/action.ts"
'use server';

import { db } from '../../db';

export async function setDone(id: string, done: boolean): Promise<void> {
  await db.setDone(id, done);
}
```

```tsx title="src/components/note-toggle/index.tsx"
'use client';

import { useTransition } from 'react';
import { setDone } from './action';

export function NoteToggle({ id, done }: { id: string; done: boolean }) {
  const [pending, startTransition] = useTransition();

  return (
    <input
      type="checkbox"
      checked={done}
      disabled={pending}
      onChange={(event) => {
        const next = event.target.checked;
        startTransition(async () => {
          await setDone(id, next);
        });
      }}
    />
  );
}
```

Calling `setDone(id, next)` on its own also works — the runtime applies the action's page payload inside a
transition either way, so the list re-renders without tearing the UI down. What `startTransition` adds is a
pending flag scoped to **this** interaction: `pending` stays true for the round trip _and_ the re-render it
triggers, which is what lets the checkbox disable itself for exactly that long.
(`useNavigation().router.pending` is the whole-page equivalent, and it cannot tell you which control was
clicked.) A transition is also the scope [optimistic updates](#optimistic-updates) require.

|                   | `useActionState`               | `useTransition`                       |
| ----------------- | ------------------------------ | ------------------------------------- |
| Attaches to       | `<form action={…}>`            | any event handler                     |
| Arguments         | `FormData`                     | typed values you already hold         |
| Works without JS  | ✅                             | ❌                                    |
| Hands you         | `[state, formAction, pending]` | `[pending, startTransition]`          |
| Reach for it when | the result is state you render | you only need to know it is in flight |

## Loading data with `<AsyncBoundary>`

A server component awaits the database directly. No loader, no `useEffect`, no fetch on mount:

```tsx title="src/components/notes.tsx"
import { AsyncBoundary } from '@rshono/core/client';
import { db } from '../db';
import { Layout } from './layout';
import { NewNote } from './new-note';

async function NoteList() {
  const notes = await db.listNotes();
  return (
    <ul>
      {notes.map((note) => (
        <li key={note.id}>{note.text}</li>
      ))}
    </ul>
  );
}

export default function Notes() {
  return (
    <Layout title="Notes">
      <h1>Notes</h1>
      <NewNote />
      <AsyncBoundary loading={<p>Loading notes…</p>} error={<p>Could not load notes.</p>}>
        <NoteList />
      </AsyncBoundary>
    </Layout>
  );
}
```

The heading and the form are sent **immediately**; the `<ul>` streams in when the query resolves. A slow
query delays its own section and nothing else, and if it rejects, the error stays inside the boundary
instead of taking the page down.

`<AsyncBoundary>` is a `'use client'` module, so you can render it straight from a server component like
this — but note what crosses that line. `NoteList` is still a server component and ships no JavaScript;
only the boundary itself does. And `loading` / `error` are being passed **from the server**, so they must
be nodes. The `(error, reset) => …` form of `error` needs a function, and functions cannot cross the
server→client boundary — use it from a `'use client'` component when you want a _Try again_ button. See
[`@rshono/core/client`](/docs/api#rshonocoreclient).

## Passing actions to client components

A server component can declare its actions inline and hand them down as props. The client half then knows
nothing about the database — only that it was given some functions to call:

```tsx title="src/components/note-board/index.tsx"
import { db } from '../../db';
import { Board } from './board';

export default async function NoteBoard() {
  const notes = await db.listNotes();

  async function createNote(text: string) {
    'use server';
    await db.createNote(text);
  }

  async function setDone(id: string, done: boolean) {
    'use server';
    await db.setDone(id, done);
  }

  return <Board notes={notes} onCreate={createNote} onToggle={setDone} />;
}
```

```tsx title="src/components/note-board/board.tsx"
'use client';

import { useTransition } from 'react';
import type { Note } from '../../db';

interface BoardProps {
  notes: Note[];
  onCreate: (text: string) => Promise<void>;
  onToggle: (id: string, done: boolean) => Promise<void>;
}

export function Board({ notes, onCreate, onToggle }: BoardProps) {
  const [pending, startTransition] = useTransition();

  return (
    <>
      <ul aria-busy={pending}>
        {notes.map((note) => (
          <li key={note.id}>
            <input
              type="checkbox"
              checked={note.done}
              onChange={(event) => {
                const next = event.target.checked;
                startTransition(async () => {
                  await onToggle(note.id, next);
                });
              }}
            />
            {note.text}
          </li>
        ))}
      </ul>
      <button onClick={() => startTransition(async () => await onCreate('New note'))}>Add</button>
    </>
  );
}
```

`Board` is a plain component taking two callbacks. It could be handed different implementations in a test
without knowing that the real ones are server references at all.

> **An inline action cannot close over its component's scope.** `'use server'` in a function body compiles
> to a module-level function plus _encrypted bound arguments_, and that encryption is not wired up in the
> Rspack / `react-server-dom-rspack` pair rshono currently pins — capturing anything from the enclosing
> scope fails the build with `export 'encryptActionBoundArgs' … was not found`. The functions above are
> fine because they close over nothing; `db` is a module import.

To attach per-item data, bind it to a module-scope action explicitly. `bind` is the supported spelling of
the same idea, and the bound arguments travel with the reference:

```tsx
import { setDone } from './action';

// `markDone()` now takes no arguments — the id and the flag are baked in.
<DoneButton markDone={setDone.bind(null, note.id, true)} />;
```

Have the child call it itself, inside a transition. Don't hand a bound action straight to `onClick`: React
would pass the click event along as one more argument, and a synthetic event is not serializable.

## Advanced

### Optimistic updates

`useOptimistic` shows the result before the server confirms it. The base value is whatever the server last
sent; the reducer layers the pending change on top:

```ts title="src/components/note-list/action.ts"
'use server';

import { db } from '../../db';

export async function addNote(text: string): Promise<void> {
  await db.createNote(text);
}
```

```tsx title="src/components/note-list/index.tsx"
'use client';

import { useOptimistic, useRef } from 'react';
import type { Note } from '../../db';
import { addNote } from './action';

export function NoteList({ notes }: { notes: Note[] }) {
  const form = useRef<HTMLFormElement>(null);
  const [shown, addPending] = useOptimistic(notes, (current, text: string) => [...current, { id: `pending:${text}`, text, done: false }]);

  return (
    <>
      <ul>
        {shown.map((note) => (
          <li key={note.id} data-pending={note.id.startsWith('pending:') || undefined}>
            {note.text}
          </li>
        ))}
      </ul>

      <form
        ref={form}
        action={async (data: FormData) => {
          const text = String(data.get('text') ?? '').trim();
          if (!text) return;
          addPending(text);
          form.current?.reset();
          await addNote(text);
        }}
      >
        <input name="text" />
        <button>Add</button>
      </form>
    </>
  );
}
```

An `async` function passed to `<form action>` is a React Action, so it already runs inside a transition —
which is what `addPending` requires. The optimistic note renders instantly, and when `addNote` resolves the
action's response brings a re-rendered `notes` prop down from the server: the real note replaces the
pending one and the optimistic layer drops away on its own. There is no "remove the temporary item" code
to write, and if the action throws, React reverts it for you.

Give the pending item a distinguishable `id` rather than a real-looking one. It is the only handle you
have for styling it as unconfirmed, and it must not collide with a key the server will send.

Note what this costs: the `action` here is a **client** function, so this form needs JavaScript. The
[`useActionState` form](#forms-useactionstate) hands `<form action>` the server action itself and works
without it. Optimism is for interactions where the wait is worth hiding, not for every form on the page.
