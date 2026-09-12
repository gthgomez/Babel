/**
 * `--import` bootstrap for `npm run test:unit`: installs the
 * no-ambient-inference fetch guard in every test worker process. Plain JS so
 * it loads in child workers regardless of loader ordering.
 */
import { installNoAmbientInferenceGuard } from './no-ambient-inference.mjs';

installNoAmbientInferenceGuard();
