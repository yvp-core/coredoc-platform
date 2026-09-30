import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// The release pipeline runs the whole monorepo suite through turbo in
// parallel on a 2-core runner; jsdom renders get starved and the 1s default
// findBy*/waitFor timeout flakes route tests that pass everywhere else. The
// timeout only bounds the FAILURE case — passing queries resolve as soon as
// the element appears — so the extra headroom costs nothing when green.
configure({ asyncUtilTimeout: 5_000 });
