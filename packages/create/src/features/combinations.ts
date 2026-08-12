import type { Answers } from '../options.js';
import type { Feature } from './types.js';

/**
 * Biome's CSS parser rejects Tailwind's syntax — `@apply` is a parse error, not an unknown-at-rule warning — so
 * a project with both needs Biome pointed away from stylesheets. The overlay is a second `biome.json` listed
 * after the first.
 *
 * Narrow on purpose: excluding CSS for everybody would give up formatting the plain-CSS template that Biome
 * handles perfectly well.
 */
const BIOME_TAILWIND: Feature = {
  id: 'biome-tailwind',
  overlays: ['biome-tailwind'],
};

/**
 * Features that exist because of how two answers *combine*, rather than because of either one alone.
 * Applied after the per-axis features, so an overlay here has the last word on a file.
 *
 * Keep this list short. A combination that needs more than a file swap is usually a sign that the two
 * options should not both be offered.
 */
export function combinationFeatures(answers: Answers): Feature[] {
  const usesBiome = answers.formatter === 'biome' || answers.linter === 'biome';
  return usesBiome && answers.styling === 'tailwind' ? [BIOME_TAILWIND] : [];
}
