import { readFileSync, readdirSync } from 'fs';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../prompts');

export function loadPrompts() {
  let files;
  try {
    files = readdirSync(PROMPTS_DIR)
      .filter(f => extname(f) === '.md')
      .sort();
  } catch {
    return '';
  }

  return files
    .map(f => readFileSync(join(PROMPTS_DIR, f), 'utf8').trim())
    .filter(Boolean)
    .join('\n\n---\n\n');
}
