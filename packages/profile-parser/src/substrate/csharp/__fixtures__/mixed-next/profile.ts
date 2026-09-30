import type { MultiTargetProfile } from '../../../../types/multi-profile.js';

export const profile: MultiTargetProfile = {
  parserId: 'neutral-mixed-fixture',
  repoType: 'monorepo',
  targets: [
    {
      name: 'backend',
      substrate: { language: 'csharp', include: ['backend/**/*.cs'], analysis: { mode: 'basic' } },
      libraries: [
        {
          projectSdk: 'Microsoft.NET.Sdk.Web',
          types: ['Microsoft.AspNetCore.Mvc.ControllerBase', 'Microsoft.AspNetCore.Mvc.HttpGetAttribute'],
        },
      ],
      nominal: {
        controllers: [
          {
            baseTypes: ['Microsoft.AspNetCore.Mvc.ControllerBase'],
            routeAttributes: [],
            verbAttributes: { 'Microsoft.AspNetCore.Mvc.HttpGetAttribute': 'GET' },
          },
        ],
      },
    },
    {
      name: 'web',
      substrate: { language: 'ts', include: ['web/**/*.tsx'] },
      routes: { fileConvention: [{ framework: 'next-app', routeDir: 'web/app' }] },
      externalCalls: [
        { kind: 'http', bareCallee: 'fetch', url: { arg: 0, as: 'string-literal' }, serviceName: 'backend' },
      ],
    },
  ],
};
