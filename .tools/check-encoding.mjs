import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const targets = ['src', 'server', 'public', 'functions', '.tools'];
const ignoredDirs = new Set(['node_modules', 'dist', 'template_extract']);
const ignoredExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.exe', '.log']);
const mojibakePattern = /[\u00c3\u00c2\ufffd]/;

async function collectFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) {
        files.push(...await collectFiles(fullPath));
      }
      continue;
    }

    if (!ignoredExts.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }

  return files;
}

const files = (await Promise.all(
  targets.map((target) => collectFiles(path.join(root, target)).catch(() => [])),
)).flat();

const findings = [];

for (const file of files) {
  const content = await readFile(file, 'utf8');
  const lines = content.split(/\r?\n/);

  lines.forEach((line, index) => {
    if (mojibakePattern.test(line)) {
      findings.push(`${path.relative(root, file)}:${index + 1}: ${line.trim()}`);
    }
  });
}

if (findings.length) {
  console.error('Encoding check failed. Fix mojibake before building:');
  console.error(findings.join('\n'));
  process.exit(1);
}

console.log('Encoding check passed.');
