import type { PageProps } from '@rshono/core';
import type { ReactNode } from 'react';
import summary from '../../content/benchmarks-summary.json';
import { highlightCode } from '../content/markdown';
import { CommandTabs, SCAFFOLD_COMMAND } from './command-tabs';
import { Layout } from './layout';
import { Logo } from './logo';

const ROUTES_SAMPLE = `
import { defineRoutes } from '@rshono/core';

export const routes = defineRoutes({
  routes: [
    { path: '/', component: () => import('./pages/home') },
    { path: '/posts/:id', component: () => import('./pages/post') },
    { type: 'endpoint', path: '/api/health', server: () => import('./api/health') },
  ],
  notFound: { component: () => import('./pages/404') },
});
`;

const PAGE_SAMPLE = `
import type { PageProps } from '@rshono/core';
import { db } from '../db';

export default async function Post({ params, ctx }: PageProps<'/posts/:id'>) {
  const post = await db.getPost(params.id);
  const theme = ctx.cookies.get('theme') ?? 'light';
  return <Article post={post} theme={theme} />;
}
`;

const CLIENT_SAMPLE = `
'use client';
import { useNavigation } from '@rshono/core/client';

export function Pager() {
  const { url, router } = useNavigation();
  const page = Number(url.searchParams.get('page') ?? 1);
  return <button onClick={() => router.push(\`?page=\${page + 1}\`)}>Next</button>;
}
`;

/** The four numbers that describe the surface. Each is checkable in a minute, which is the point. */
const FACTS = [
  { value: '1', label: 'required file' },
  { value: '9', label: 'exported values' },
  { value: '5', label: 'direct dependencies' },
  { value: '4', label: 'deploy targets' },
];

const FEATURES = [
  {
    title: 'One route table',
    body: 'Every page and endpoint in src/routes.ts. No file-system routing, so your directory tree is yours — moving a page is an edit to one line.',
    href: '/docs/routing',
  },
  {
    title: 'The request is a prop',
    body: 'A page is handed { url, params, ctx } and awaits your database directly. Nested components and actions call getRequestContext() for the same object.',
    href: '/docs/pages',
  },
  {
    title: 'One navigation hook',
    body: 'useNavigation() returns the url, the params and the router. No <Link>, no <Image>, no <Head> — links are <a href>, images are <img>, forms are <form action>.',
    href: '/docs/pages#client-components',
  },
  {
    title: 'Actions, not endpoints',
    body: "A 'use server' function is callable from client code with typed arguments. Wired to a form it posts before hydration and with JavaScript disabled.",
    href: '/docs/pages#server-actions',
  },
  {
    title: 'The Hono app is yours',
    body: 'src/server.ts is a Hono sub-app mounted ahead of the pages, so its middleware wraps them. Endpoints, streaming, cookies, end-to-end client types.',
    href: '/docs/hono',
  },
  {
    title: 'The Rspack config too',
    body: 'One hook, called once per compiler, hands you the generated config before it compiles. That is how Tailwind is wired up, and any other loader.',
    href: '/docs/configuration#the-rspack-hook',
  },
];

const TARGETS = ['node', 'cloudflare', 'vercel', 'aws-lambda'];

/**
 * The landing page.
 *
 * `render: 'static'` like the docs, and for the same reason: the samples are highlighted by Shiki at
 * build time, so what a browser gets is finished HTML with no highlighter anywhere near it.
 *
 * Every number on the page is either structural (nine exports, one required file — countable from the
 * package's `exports` map) or read out of `benchmarks-summary.json`, which the benchmark run generates.
 * Nothing here is a hand-typed figure that could drift from what it describes.
 */
export default async function Home({ url }: PageProps<'/'>) {
  const [routesHtml, pageHtml, clientHtml] = await Promise.all([
    highlightCode(ROUTES_SAMPLE, 'ts'),
    highlightCode(PAGE_SAMPLE, 'tsx'),
    highlightCode(CLIENT_SAMPLE, 'tsx'),
  ]);

  return (
    <Layout description="Minimal web framework — Hono + Rspack + React Server Components." canonical={url.href} wide>
      <Hero />
      <Samples routesHtml={routesHtml} pageHtml={pageHtml} clientHtml={clientHtml} />
      <Features />
      <Toolchain />
      <Measured />
      <ClosingCta />
    </Layout>
  );
}

function Hero() {
  return (
    <section className="mx-auto w-full max-w-7xl px-6 pt-20 pb-14 text-center">
      <h1 className="mx-auto max-w-3xl text-5xl font-semibold tracking-tight text-balance text-zinc-900 sm:text-6xl dark:text-white">
        A minimal framework for React Server Components
      </h1>

      <h2 className="mx-auto mt-6 max-w-2xl text-lg text-pretty text-zinc-600 dark:text-zinc-400">
        <a href="https://hono.dev" data-native>
          Hono
        </a>{' '}
        for the server,{' '}
        <a href="https://rspack.rs" data-native>
          Rspack
        </a>{' '}
        for the build,{' '}
        <a href="https://react.dev/reference/rsc/server-components" data-native>
          React Server Components
        </a>{' '}
        for the rendering. One required file, nine exports, and no conventions around them.
      </h2>

      <div className="mt-10 flex justify-center">
        <a
          href="/docs/getting-started"
          className="rounded-lg bg-zinc-900 px-5 py-2.5 font-medium text-white no-underline hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          Get started
        </a>
      </div>

      <div className="mt-8">
        <CommandTabs id="pm-hero" command={SCAFFOLD_COMMAND} />
      </div>

      <ul className="mt-12 flex flex-wrap items-center justify-center gap-x-8 gap-y-3">
        {FACTS.map((fact) => (
          <li key={fact.label} className="text-sm text-zinc-600 dark:text-zinc-400">
            <span className="font-semibold text-zinc-900 tabular-nums dark:text-white">{fact.value}</span> {fact.label}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The API, in three files.
 *
 * The route table, a server page and a client component — most of the public surface, and the whole
 * server/client story the heading claims. Showing them beats describing them, which is why the samples
 * carry the argument and the copy above them is three sentences.
 */
function Samples({ routesHtml, pageHtml, clientHtml }: { routesHtml: string; pageHtml: string; clientHtml: string }) {
  return (
    <section className="mx-auto w-full max-w-7xl px-6 py-12">
      <SectionHeading title="Best-in-class ergonomics: write server and client together">
        A page awaits your database directly, with no API layer in between. A client component reads the same <code>url</code> and <code>params</code>{' '}
        from one hook, and calls a <code>&lsquo;use server&rsquo;</code> function like any other function. The boundary is a directive, not a
        directory.
      </SectionHeading>

      <div className="grid gap-8 lg:grid-cols-3">
        <Sample title="src/routes.ts" caption="Every page and endpoint in one table, matched in order." html={routesHtml} />
        <Sample title="Server: a page" caption="A server component, awaiting data." html={pageHtml} />
        <Sample title="Client: a component" caption="One hook for the URL, the params and the router." html={clientHtml} />
      </div>
    </section>
  );
}

function Sample({ title, caption, html }: { title: string; caption: string; html: string }) {
  return (
    <figure className="min-w-0">
      <figcaption className="mb-3">
        {/* h3: the section's own heading is the h2 above, and these sit under it. */}
        <h3 className="font-medium text-zinc-900 dark:text-white">{title}</h3>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">{caption}</p>
      </figcaption>
      {/* Highlighted at build time from a constant in this file — not user input. */}
      <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />
    </figure>
  );
}

/** Shared by the two sections that lead with a heading and a line of context. */
function SectionHeading({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-8 max-w-3xl">
      <h2 className="mb-2 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-white">{title}</h2>
      <p className="text-zinc-600 dark:text-zinc-400">{children}</p>
    </div>
  );
}

function Features() {
  return (
    <section className="mx-auto w-full max-w-7xl px-6 py-12">
      <SectionHeading title="Why choose rshono?">
        Because there is so little of it. Nine exported values across three import paths, five direct dependencies, and no framework-owned replacement
        for an HTML element you already know. Hono and Rspack stay reachable underneath, unrenamed.
      </SectionHeading>

      <ul className="grid gap-px overflow-hidden rounded-xl border border-zinc-200 bg-zinc-200 sm:grid-cols-2 lg:grid-cols-3 dark:border-zinc-800 dark:bg-zinc-800">
        {FEATURES.map((feature) => (
          <li key={feature.title} className="bg-white p-6 dark:bg-zinc-950">
            {/* The heading is the link — a separate "read more" under every card is six links saying nothing. */}
            <h3 className="mb-2 font-medium">
              <a href={feature.href} className="text-zinc-900 no-underline hover:underline dark:text-white">
                {feature.title} →
              </a>
            </h3>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">{feature.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Toolchain() {
  return (
    <section className="mx-auto w-full max-w-7xl px-6 py-12">
      <div className="grid gap-10 rounded-xl border border-zinc-200 p-8 lg:grid-cols-2 dark:border-zinc-800">
        <div>
          <h2 className="mb-3 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-white">One toolchain, three commands</h2>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            The same pair of Rspack configs builds dev and production. <code>dev</code> runs the real production server bundle in a worker thread,
            with HMR that keeps browser state.
          </p>
          <pre className="overflow-x-auto rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-sm dark:border-zinc-800 dark:bg-zinc-900">
            <code>{'rshono dev\nrshono build\nrshono start'}</code>
          </pre>
        </div>

        <div>
          <h2 className="mb-3 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-white">A scaffolder with six questions</h2>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Where it goes, deploy target, styling, formatter/linter preset, install, git. Every question is also a flag, a non-interactive terminal
            implies <code>--yes</code>, and the package manager that ran it is the one the project gets.
          </p>
          <ul className="mb-4 flex flex-wrap gap-2">
            {TARGETS.map((target) => (
              <li
                key={target}
                className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-1.5 font-mono text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
              >
                {target}
              </li>
            ))}
          </ul>
          <p className="text-sm">
            <a href="/docs/deployment">One build command per target →</a>
          </p>
        </div>
      </div>
    </section>
  );
}

/**
 * Three measured numbers, read out of the generated benchmark summary rather than typed in.
 *
 * The full result set — including the row rshono loses — is on `/benchmarks`, which is what the link is
 * for. A headline that cannot be traced to the run that produced it is worth less than no headline.
 */
function Measured() {
  return (
    <section className="mx-auto w-full max-w-7xl px-6 py-12">
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-white">Measured, not claimed</h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          One app built three ways, on {summary.machine}. <a href="/benchmarks">Every metric →</a>
        </p>
      </div>

      <ul className="grid gap-px overflow-hidden rounded-xl border border-zinc-200 bg-zinc-200 sm:grid-cols-3 dark:border-zinc-800 dark:bg-zinc-800">
        {summary.headline.map((metric) => {
          const rshono = metric.values.find((value) => value.target === 'rshono');
          if (!rshono) return null;
          return (
            <li key={metric.id} className="bg-white p-6 dark:bg-zinc-950">
              <p className="text-sm text-zinc-500 dark:text-zinc-400">{metric.label}</p>
              <p className="mt-2 text-3xl font-semibold tracking-tight text-zinc-900 dark:text-white">{rshono.display}</p>
              <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                {metric.gap.factor}× {metric.comparative} than {metric.gap.worstLabel}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ClosingCta() {
  return (
    <section className="mx-auto w-full max-w-7xl px-6 pt-8 pb-24 text-center">
      <p className="mb-4 flex justify-center">
        <Logo size={32} />
      </p>
      <h2 className="mb-6 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-white">Start with a scaffold</h2>
      <CommandTabs id="pm-cta" command={SCAFFOLD_COMMAND} />
    </section>
  );
}
