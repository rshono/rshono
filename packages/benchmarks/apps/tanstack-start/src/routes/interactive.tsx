import type { ComponentType } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { CompositeComponent, createCompositeComponent } from '@tanstack/react-start/rsc';
import { MARKER } from '../touch-marker';
import { Counter } from '../components/counter';
import { Filter } from '../components/filter';
import { SignupForm } from '../components/signup-form';
import type { User } from '../server-fns';

/**
 * APP_SPEC.md `/interactive`: three interactive components — local state, a filtered list over the full fixture,
 * and a server function.
 *
 * They are slotted into the server shell as *component props*, the only one of TanStack's slot kinds where the
 * server can hand data across the boundary — which `Filter` needs, since it takes all 100 users as a prop.
 */
const getInteractiveShell = createServerFn().handler(async () => {
  const { users } = await import('../data');
  const src = await createCompositeComponent(
    (props: { Counter: ComponentType; Filter: ComponentType<{ users: User[] }>; SignupForm: ComponentType }) => (
      <>
        <h1>Interactive</h1>
        <p className="subtitle">Three client components: local state, a filtered list, a server function.</p>

        <section>
          <h2>Counter</h2>
          <props.Counter />
        </section>

        <section>
          <h2>Filter</h2>
          <props.Filter users={users} />
        </section>

        <section>
          <h2>Sign up</h2>
          <props.SignupForm />
        </section>

        <p className="summary" data-marker={MARKER}>
          Server-rendered shell.
        </p>
      </>
    ),
  );
  return { src };
});

export const Route = createFileRoute('/interactive')({
  loader: () => getInteractiveShell(),
  component: Interactive,
});

function Interactive() {
  const { src } = Route.useLoaderData();
  return <CompositeComponent src={src} Counter={Counter} Filter={Filter} SignupForm={SignupForm} />;
}
