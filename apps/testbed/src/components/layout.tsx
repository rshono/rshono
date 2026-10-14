import type { ReactNode } from 'react';
import '../styles.css';

export function Layout({ title = 'rshono', description, children }: { title?: string; description?: string; children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        {description && <meta name="description" content={description} />}
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
      </head>
      <body>
        <main>{children}</main>

        <footer>
          <p>
            rshono — <a href="https://hono.dev">Hono</a> + Rspack + React Server Components.
          </p>
          <p className="meta">
            {/* data-native opts this link out of RSC soft navigation — it does a full browser load. */}
            <a href="/" data-native>
              Reload home
            </a>
            {' · '}
            {/* A file, so it is left to the browser without `data-native`: a dot in the last path segment is
                the framework's own test. See `namesAFile` in entry.client.tsx. */}
            <a href="/robots.txt">robots.txt</a>
          </p>
        </footer>
      </body>
    </html>
  );
}
