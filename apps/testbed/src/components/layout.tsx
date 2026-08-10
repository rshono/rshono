import type { ReactNode } from 'react';
import { Logo } from './logo';
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
        <header>
          <nav>
            <a href="/" className="logo">
              <Logo />
              <strong>rshono</strong>
            </a>
            <div className="nav-links">
              <a href="/">Home</a>
              <a href="/users">Users</a>
              <a href="/docs/getting-started">Docs</a>
              <a href="/signup">Sign Up</a>
            </div>
          </nav>
        </header>

        <main>{children}</main>

        <footer>
          <p>rshono — Hono + Rspack + React Server Components.</p>
          <p className="meta">
            {/* data-native opts this link out of RSC soft navigation — it does a full browser load. */}
            <a href="/" data-native>
              Reload home
            </a>
          </p>
        </footer>
      </body>
    </html>
  );
}
