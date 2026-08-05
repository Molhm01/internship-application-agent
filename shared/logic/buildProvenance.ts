import { BUILD_MISMATCH_MESSAGE, type RuntimeComponent } from '../constants/runtime.js';

/**
 * Whether the loaded extension components came from one build.
 *
 * Chrome loads the popup, the service worker, and the content script as three
 * independent bundles, from three independent caches, at three independent
 * times. Reloading the extension replaces the first two and leaves every
 * already-open tab running the old third. Nothing inside the extension could
 * previously observe that, and the resulting failures are unreadable: a scan the
 * worker rejects, a plan the executor refuses, a field type that "does not
 * exist" while the source plainly defines it.
 *
 * So the components announce their `BUILD_ID` and this compares them. It lives
 * in `shared/` because the popup and the worker must not be able to reach
 * different conclusions about the same three strings.
 */

export interface BuildAgreement {
  agreed: boolean;
  /** Every component that answered, in the order they were supplied. */
  components: readonly { component: RuntimeComponent; buildId: string | undefined }[];
  /** The user-facing sentence. Present only when `agreed` is false. */
  message?: string;
  /**
   * The distinct ids seen, for the diagnostic log. Never shown to the user: the
   * remedy is the same whatever the ids are, and reading two build hashes is
   * not something anyone should have to do to use the extension.
   */
  distinct: readonly string[];
}

/**
 * Compares the build ids the components reported.
 *
 * A component that reports no id at all is treated as disagreeing, not as
 * absent: an unstamped bundle necessarily predates stamping, which is the exact
 * condition being detected.
 */
export function compareBuilds(
  reported: readonly { component: RuntimeComponent; buildId: string | undefined }[],
): BuildAgreement {
  const ids = reported.map((entry) => entry.buildId ?? '');
  const distinct = [...new Set(ids)];
  const agreed = distinct.length === 1 && distinct[0] !== '';
  return {
    agreed,
    components: reported,
    distinct: distinct.filter((id) => id !== ''),
    ...(agreed ? {} : { message: BUILD_MISMATCH_MESSAGE }),
  };
}
