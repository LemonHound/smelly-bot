import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../prompts');

function loadFile(name) {
  try {
    return readFileSync(join(PROMPTS_DIR, name), 'utf8').trim();
  } catch {
    return '';
  }
}

export function loadPrompts() {
  return {
    systemMd: loadFile('system.md'),
    topicsMd: loadFile('topics.md'),
  };
}
