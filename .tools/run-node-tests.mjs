import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runTestFiles } from './test-runner.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const files = JSON.parse(fs.readFileSync(new URL('./node-test-files.json', import.meta.url), 'utf8'));
process.exitCode = await runTestFiles(files);
