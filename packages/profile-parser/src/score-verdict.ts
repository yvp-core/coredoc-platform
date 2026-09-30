/**
 * Coverage-scorecard verdict for a category or overall run — shared by the TS scorer
 * (score.ts) and the Ruby scorer (score-ruby.ts). String enum: the member values equal
 * the displayed/asserted strings ('PASS' / 'PARTIAL' / 'FAIL').
 */
export enum Verdict {
  PASS = 'PASS',
  PARTIAL = 'PARTIAL',
  FAIL = 'FAIL',
}
