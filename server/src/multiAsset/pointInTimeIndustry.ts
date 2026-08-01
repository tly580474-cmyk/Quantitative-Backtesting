export interface IndustryMembershipVersion {
  instrumentKey: string;
  taxonomy: 'SW2021';
  level1Code: string;
  level1Name: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  sourceVersion: string;
  fetchedAt: string;
}

/** Reference selector used by golden tests for the DuckDB as-of industry join. */
export function selectPointInTimeIndustry(
  versions: IndustryMembershipVersion[],
  instrumentKey: string,
  decisionDate: string,
): IndustryMembershipVersion | null {
  return versions
    .filter((version) => version.instrumentKey === instrumentKey
      && version.taxonomy === 'SW2021'
      && version.effectiveFrom <= decisionDate
      && (version.effectiveTo === null || version.effectiveTo >= decisionDate))
    .sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom)
      || right.fetchedAt.localeCompare(left.fetchedAt))[0] ?? null;
}
