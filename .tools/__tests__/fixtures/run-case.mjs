import { runTestFiles } from '../../test-runner.mjs';
const file = '.tools/__tests__/fixtures/runner-case.mjs';
process.exitCode = await runTestFiles([file], {
  requiredPasses: process.argv.includes('--strict') ? { [file]: 1 } : {},
});
