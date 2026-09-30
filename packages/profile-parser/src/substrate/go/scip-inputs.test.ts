import { expect, it } from 'vitest';
import { goIndexInputs } from './scip-inputs.js';

it('selects module and compiler inputs without bringing deployment secrets into the build', () => {
  const inputs = [
    'go.work',
    'go.work.sum',
    'api/go.mod',
    'api/go.sum',
    'api/main.go',
    'native/bridge.c',
    'native/bridge.h',
  ];
  expect(
    goIndexInputs([
      ...inputs,
      'config/master.key',
      'client.pem',
      'terraform.tfvars',
      'serviceAccount.json',
      '.ENV',
      'deploy/config.yaml',
    ]),
  ).toEqual(inputs);
});
