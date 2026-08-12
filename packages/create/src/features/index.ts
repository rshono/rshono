import type { Answers } from '../options.js';
import type { PackageManager } from '../pm.js';
import { combinationFeatures } from './combinations.js';
import { deployFeature } from './deploy.js';
import { formatterFeature, linterFeature } from './quality.js';
import { stylingFeature } from './styling.js';
import type { Feature } from './types.js';

export type { Feature };

/**
 * The features a set of answers selects, in application order — so an overlay listed later wins a file both
 * ship. Deduplicated by `id`, which is what lets one feature answer two questions (Biome is both formatter and
 * linter) without contributing twice.
 *
 * `pm` reaches the deploy target because one script has to name the runner that fetches an uninstalled CLI.
 */
export function selectFeatures(answers: Answers, pm: PackageManager): Feature[] {
  const selected = [
    deployFeature(answers.deploy, pm),
    stylingFeature(answers.styling),
    formatterFeature(answers.formatter),
    linterFeature(answers.linter),
    ...combinationFeatures(answers),
  ];

  const features: Feature[] = [];
  const seen = new Set<string>();
  for (const feature of selected) {
    if (!feature || seen.has(feature.id)) continue;
    seen.add(feature.id);
    features.push(feature);
  }
  return features;
}
