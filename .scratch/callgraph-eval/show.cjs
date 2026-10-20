// Print an eval result's breakdown tables and (optionally) samples.
//   node show.cjs <result.json> [samples]
const r = require(process.argv[2]);
const t = (o) => Object.entries(o).map(([k, v]) => `    ${k.padEnd(28)} gt=${String(v.gt).padStart(6)} tp=${String(v.tp).padStart(6)} recall=${v.recall}`).join('\n');
console.log(`${r.repo}  ${JSON.stringify(r.headline)}`);
for (const k of ['byLineDensity', 'byCallForm', 'byFileKind', 'byCaller', 'byScope', 'byShape', 'byCalleeKind']) console.log(`  ${k}\n${t(r[k])}`);
console.log('  missReason', JSON.stringify(r.missReason));
const fn = r.headline.fn;
console.log('  missBucket (recall gain if fixed)');
for (const [k, v] of Object.entries(r.missBucket).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${k.padEnd(40)} ${String(v).padStart(5)}  ${((100 * v) / fn).toFixed(0).padStart(3)}% of misses  +${((100 * v) / r.headline.gt).toFixed(1)}pp`);
}
const cc = r.calleeCoverage;
if (cc) {
  console.log('  calleeCoverage', JSON.stringify({ ...cc, allMissedSamples: undefined }));
  if (process.argv[3] === 'callees') console.log(cc.allMissedSamples.map((s) => `    ${s}`).join('\n'));
}
if (process.argv[3] === 'buckets') {
  for (const [k, v] of Object.entries(r.bucketSamples)) console.log(`\nBUCKET ${k}\n${v.map((s) => `  ${s}`).join('\n')}`);
  process.exit(0);
}
console.log('  fpReason', JSON.stringify(r.fpReason));
console.log('  counts', JSON.stringify(r.counts));
if (process.argv[3]) {
  for (const [k, v] of Object.entries(r.missSamples)) console.log(`\nMISS ${k}\n${v.map((s) => `  ${s}`).join('\n')}`);
  for (const [k, v] of Object.entries(r.fpSamples)) console.log(`\nFP ${k}\n${v.map((s) => `  ${s}`).join('\n')}`);
  console.log('\nUNRESOLVED (checker)\n' + r.unresolvedSamples.map((s) => `  ${s}`).join('\n'));
}
