/**
 * One optional thing a scaffolded app can have. Every difference between two scaffolds is one of these fields,
 * which is what keeps the generator free of `if (tailwind)` branches: it selects features, then merges what
 * they declare.
 *
 * Adding an option is therefore three edits and no new machinery — a `Feature` here, the template directory it
 * names, and an entry in the prompt flow if it deserves a question of its own.
 */
export interface Feature {
  /** Stable identifier, used in error messages and as the conventional name of its template directory. */
  id: string;
  /**
   * Template directories copied over the base, relative to `templates/`, in the order listed. An existing file
   * is replaced — that is how the Tailwind overlay ships its own `styles.css` rather than patching the base one.
   */
  overlays?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  /** Merged into `scripts`; a later feature wins a collision, so keep the names distinct. */
  scripts?: Record<string, string>;
  /**
   * A one-line gloss for a script this feature contributes — what the generated README prints beside the
   * command. Optional per script: one with nothing to explain is left out of the table.
   */
  scriptHelp?: Record<string, string>;
  /**
   * A markdown block for the scaffolded README's Deploying section: what to type into the platform when the app
   * is wired up there rather than deployed from a laptop.
   *
   * Spelled out separately from the scripts, because a host asks for a build command and a start or deploy
   * command of its own — and a `deploy` script that builds first would build twice.
   */
  platformSetup?: string;
  /** Appended to `.gitignore` under a heading naming the feature. */
  gitignore?: string[];
  /**
   * Install scripts this feature's dependencies bring, and whether the app should run them — pnpm's
   * `allowBuilds`, which a pnpm scaffold cannot install without. `false` says the script was looked at, so say
   * why in a comment beside the entry.
   */
  allowBuilds?: Record<string, boolean>;
  /** Extra lines for the closing "next steps" block, e.g. a platform's own login step. */
  notes?: string[];
}
