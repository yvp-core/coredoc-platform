import type { CSharpProfile } from '../../../../types/csharp-profile.js';
export const profile: CSharpProfile = {
  parserId: 'compiled-groups-fixture',
  substrate: { language: 'csharp', include: ['**/*.cs'] },
  libraries: [
    {
      projectSdk: 'Microsoft.NET.Sdk.Web',
      types: [
        'Microsoft.AspNetCore.Builder.WebApplication',
        'Microsoft.AspNetCore.Builder.WebApplicationBuilder',
        'Microsoft.AspNetCore.Routing.RouteGroupBuilder',
      ],
      members: {
        'Microsoft.AspNetCore.Builder.WebApplication': {
          methods: {
            CreateBuilder: 'Microsoft.AspNetCore.Builder.WebApplicationBuilder',
            MapGroup: 'Microsoft.AspNetCore.Routing.RouteGroupBuilder',
          },
        },
        'Microsoft.AspNetCore.Builder.WebApplicationBuilder': {
          methods: { Build: 'Microsoft.AspNetCore.Builder.WebApplication' },
        },
        'Microsoft.AspNetCore.Routing.RouteGroupBuilder': {
          methods: { MapGroup: 'Microsoft.AspNetCore.Routing.RouteGroupBuilder' },
        },
      },
    },
  ],
  nominal: {
    httpCalls: [
      {
        receiverTypes: ['Microsoft.AspNetCore.Builder.WebApplication'],
        verbs: { MapGet: 'GET' },
        pathArg: 0,
        handlerArg: 1,
        groups: { receiverTypes: ['Microsoft.AspNetCore.Routing.RouteGroupBuilder'], methods: { MapGroup: 0 } },
      },
    ],
  },
};
