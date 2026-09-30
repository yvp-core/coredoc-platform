import { expect, it } from 'vitest';
import { rustIndexInputs } from './scip-inputs.js';

it('selects Cargo manifests and compiler inputs without bringing deployment secrets into the build', () => {
  const inputs = [
    'Cargo.toml',
    'Cargo.lock',
    'lib/Cargo.toml',
    'src/lib.rs',
    'build.rs',
    'rust-toolchain.toml',
    'native/bridge.c',
  ];
  expect(
    rustIndexInputs([
      ...inputs,
      'config/master.key',
      'client.pem',
      'terraform.tfvars',
      'serviceAccount.json',
      '.ENV',
      '.cargo/credentials.toml',
    ]),
  ).toEqual(inputs);
});
