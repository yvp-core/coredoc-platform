import { expect, it } from 'vitest';
import { assertRustWorkspaceLoaded } from './load-diagnostics.js';

it.each([
  'Errors occurred while running build scripts for /source/Cargo.toml: custom build command failed',
  'Failed to start proc-macro server',
  'No proc-macro server started',
  'proc-macro loading for /target/libfixture.dylib failed: incompatible ABI',
])('refuses a nonfatal loader failure: %s', (failure) => {
  expect(() => assertRustWorkspaceLoaded(`DEBUG load_cargo: LoadCargoConfig\nWARN load_cargo: ${failure}\n`)).toThrow(
    'Rust workspace loading failed',
  );
});

it('requires observable loader diagnostics and accepts successful loading', () => {
  expect(() => assertRustWorkspaceLoaded('Generating SCIP finished')).toThrow('did not report');
  expect(() =>
    assertRustWorkspaceLoaded(
      'DEBUG load_cargo: LoadCargoConfig\nINFO load_cargo: Proc-macro server started\nINFO load_cargo: Loaded proc-macros for /target/libfixture.dylib: ["fixture"]',
    ),
  ).not.toThrow();
});
