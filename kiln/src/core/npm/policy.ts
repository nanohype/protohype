// Version-policy gate. Pure: no network, just semver math.

import semver from "semver";
import type { TargetVersionPolicy } from "../../types.js";

/** Is `candidate` an acceptable upgrade from `current` under the given policy? */
export function isEligibleUpgrade(
  current: string,
  candidate: string,
  policy: TargetVersionPolicy,
): boolean {
  const from = semver.coerce(current);
  const to = semver.coerce(candidate);
  if (!from || !to) return false;
  if (semver.lte(to, from)) return false;

  switch (policy) {
    case "latest":
      return true;
    case "minor-only":
      return semver.major(to) === semver.major(from);
    case "patch-only":
      return semver.major(to) === semver.major(from) && semver.minor(to) === semver.minor(from);
  }
}

export function isSkipped(pkg: string, skipList: readonly string[]): boolean {
  return skipList.includes(pkg);
}
