// A page module that cannot be evaluated — what a chunk that went missing between deploys looks like from
// the runtime's side, and the one shape that fails a request *after* a server action has already run.
//
// Nothing links here. It exists so the suite can post an action to a page whose render then fails, and check
// that the action's result still comes back with the `error` page's payload.
throw new Error('Intentional page-module failure (deploy-drift demo).');

export default function Unloadable() {
  return null;
}
