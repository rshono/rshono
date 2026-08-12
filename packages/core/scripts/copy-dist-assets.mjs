// Copies the one kind of file `tsc` does not emit into dist/: the Rspack loaders in builder/, hand-written
// CommonJS that Rspack loads by absolute path.
//
// `src/types/*.d.ts` stays behind deliberately: those are ambient declarations only the framework's own sources
// touch, and shipping them would risk leaking the globals into a consumer's scope.
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const fromDir = join(packageDir, 'src', 'builder');
const toDir = join(packageDir, 'dist', 'builder');

mkdirSync(toDir, { recursive: true });
const loaders = readdirSync(fromDir).filter((file) => file.endsWith('.cjs'));
for (const file of loaders) {
  cpSync(join(fromDir, file), join(toDir, file));
}

console.log(`  • copied ${loaders.length} Rspack loader(s) into dist/`);
