import { resolve } from 'node:path';
import { generateGoldenArtifacts } from '../src/portable/goldenArtifacts.js';

const targetDir = resolve(process.cwd(), '../docs/specs/golden');
generateGoldenArtifacts(targetDir);
console.log('Successfully generated canonical golden artifacts in', targetDir);
