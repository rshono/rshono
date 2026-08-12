'use client';

import { Component, Suspense, type ReactNode } from 'react';
import { isControlDigest } from './control.js';

// `redirect()` and `notFound()` reach the browser as a thrown error carrying a control digest. They are
// navigation, not failure, so no boundary absorbs one — they are re-thrown to the root, where the
// runtime turns the digest into a real navigation.
function isControlError(error: unknown): boolean {
  return isControlDigest((error as { digest?: unknown } | null)?.digest);
}

/**
 * What a {@link CatchBoundary} / {@link AsyncBoundary} renders once a child throws: either a static
 * node, or a render function given the error and a `reset` callback that clears it and re-renders the
 * children (a "Try again" button, say).
 *
 * The function form only works from a `'use client'` component — functions can't cross the
 * server→client boundary. From a server component, pass a `ReactNode`.
 */
export type ErrorFallback = ReactNode | ((error: Error, reset: () => void) => ReactNode);

/** Props for {@link CatchBoundary}. */
export interface CatchBoundaryProps {
  /**
   * Rendered in place of the children after one of them throws. Omit it to report the error via
   * `onError` and re-throw to the next boundary out — or the app's `error` page — instead of handling it
   * here.
   */
  fallback?: ErrorFallback;
  /** Called with the caught error, for logging or reporting. */
  onError?: (error: Error) => void;
  /**
   * Clears the error automatically when any value in this array changes while the fallback is showing.
   * Pass the current pathname to recover when the user navigates away:
   * `resetKeys={[useNavigation().url.pathname]}`.
   */
  resetKeys?: readonly unknown[];
  /** The subtree this boundary protects. */
  children: ReactNode;
}

interface CatchBoundaryState {
  error: Error | null;
}

function keysChanged(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]));
}

/**
 * A general-purpose error boundary: catches what its children throw — a client island that blew up, a
 * server component that rejected on a soft navigation — and renders `fallback` in their place rather
 * than tearing down the page.
 *
 * It is a `'use client'` component (React error boundaries must be), so a server component can render
 * it too. Reach for {@link AsyncBoundary} when you also want a Suspense loading fallback.
 *
 * @example
 * ```tsx
 * import { CatchBoundary } from '@rshono/core/client';
 *
 * <CatchBoundary fallback={(error, reset) => (
 *   <div role="alert">
 *     <p>{error.message}</p>
 *     <button onClick={reset}>Try again</button>
 *   </div>
 * )}>
 *   <RiskyWidget />
 * </CatchBoundary>
 * ```
 *
 * @see {@link https://react.dev/reference/react/Component#catching-rendering-errors-with-an-error-boundary | React — error boundaries}
 * @see {@link https://www.rshono.com/docs/api#rshonocoreclient | Docs — `@rshono/core/client`}
 */
export class CatchBoundary extends Component<CatchBoundaryProps, CatchBoundaryState> {
  state: CatchBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): CatchBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error): void {
    if (isControlError(error)) return;
    this.props.onError?.(error);
  }

  componentDidUpdate(prev: CatchBoundaryProps): void {
    const { resetKeys } = this.props;
    if (this.state.error && prev.resetKeys && resetKeys && keysChanged(prev.resetKeys, resetKeys)) {
      this.reset();
    }
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error !== null) {
      if (isControlError(error)) throw error;
      const { fallback } = this.props;
      if (fallback === undefined) throw error; // propagate to an outer boundary
      return typeof fallback === 'function' ? fallback(error, this.reset) : fallback;
    }
    return this.props.children;
  }
}

/** Props for {@link AsyncBoundary}. */
export interface AsyncBoundaryProps {
  /**
   * Suspense fallback, shown while the children or their data are still loading. Required — a loading
   * state is the reason to reach for this over {@link CatchBoundary}, so showing nothing is an explicit
   * `loading={null}`.
   */
  loading: ReactNode;
  /** Error fallback, shown if a child throws. See {@link ErrorFallback}. */
  error?: ErrorFallback;
  /** Called with the caught error. */
  onError?: (error: Error) => void;
  /** Clears the error fallback when any value changes — see {@link CatchBoundaryProps.resetKeys}. */
  resetKeys?: readonly unknown[];
  /** The subtree this boundary suspends on and protects. */
  children: ReactNode;
}

/**
 * A loading and error boundary in one wrapper — the common case for an async section of a page. It
 * always renders the same shape:
 *
 * ```tsx
 * <CatchBoundary fallback={error}>
 *   <Suspense fallback={loading}>{children}</Suspense>
 * </CatchBoundary>
 * ```
 *
 * so `loading` shows until the children resolve and `error` catches whatever they throw, suspended or
 * not. `error` is optional: omit it and errors propagate to the next boundary out.
 *
 * @example
 * ```tsx
 * import { AsyncBoundary } from '@rshono/core/client';
 *
 * <AsyncBoundary loading={<Spinner />} error={(e, reset) => <Retry onClick={reset} />}>
 *   <SlowServerComponent />
 * </AsyncBoundary>
 * ```
 *
 * @see {@link https://react.dev/reference/react/Suspense | React — `<Suspense>`}
 * @see {@link https://www.rshono.com/docs/api#rshonocoreclient | Docs — `@rshono/core/client`}
 */
export function AsyncBoundary({ loading, error, onError, resetKeys, children }: AsyncBoundaryProps): ReactNode {
  return (
    <CatchBoundary fallback={error} onError={onError} resetKeys={resetKeys}>
      <Suspense fallback={loading}>{children}</Suspense>
    </CatchBoundary>
  );
}
