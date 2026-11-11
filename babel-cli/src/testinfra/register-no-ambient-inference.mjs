/**
 * `--import` bootstrap for `npm run test:unit`: installs the
 * no-ambient-inference fetch guard in every test worker process. Plain JS so
 * it loads in child workers regardless of loader ordering.
 *
 * Fail loud if the guard did not actually install: a silently unwired guard is
 * worse than no guard because it looks protective while allowing paid calls.
 */
import {
  installNoAmbientInferenceGuard,
  isNoAmbientInferenceGuardInstalled,
} from './no-ambient-inference.mjs';

installNoAmbientInferenceGuard();
if (!isNoAmbientInferenceGuardInstalled()) {
  throw new Error('NO_AMBIENT_INFERENCE_GUARD_NOT_INSTALLED: test:unit bootstrap failed to install the guard');
}
