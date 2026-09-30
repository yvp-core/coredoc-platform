import type { CSharpProfile } from '../../../../types/csharp-profile.js';
export const profile: CSharpProfile = {
  parserId: 'compiled-frameworks-fixture',
  substrate: { language: 'csharp', include: ['**/*.cs'] },
  libraries: [
    {
      projectSdk: 'Microsoft.NET.Sdk.Web',
      types: [
        'Microsoft.Extensions.DependencyInjection.IServiceCollection',
        'Microsoft.Extensions.Hosting.IHostedService',
        'Microsoft.AspNetCore.Routing.IEndpointRouteBuilder',
        'Microsoft.AspNetCore.SignalR.Hub',
      ],
    },
    {
      dependency: 'Quartz.Extensions.DependencyInjection',
      types: ['Quartz.IServiceCollectionQuartzConfigurator', 'Quartz.IJob'],
    },
  ],
  nominal: {
    registrations: [
      {
        receiverTypes: ['Microsoft.Extensions.DependencyInjection.IServiceCollection'],
        methods: ['AddHostedService'],
        typeArgument: 0,
        baseTypes: ['Microsoft.Extensions.Hosting.IHostedService'],
        handlers: ['StartAsync'],
        kind: 'event',
        eventName: 'host.start',
      },
      {
        receiverTypes: ['Quartz.IServiceCollectionQuartzConfigurator'],
        methods: ['AddJob'],
        typeArgument: 0,
        baseTypes: ['Quartz.IJob'],
        handlers: ['Execute'],
        kind: 'event',
        eventName: 'quartz.job',
      },
      {
        receiverTypes: ['Microsoft.AspNetCore.Routing.IEndpointRouteBuilder'],
        methods: ['MapHub'],
        typeArgument: 0,
        baseTypes: ['Microsoft.AspNetCore.SignalR.Hub'],
        excludeHandlers: ['OnConnectedAsync', 'OnDisconnectedAsync'],
        kind: 'websocket',
        pathArg: 0,
      },
    ],
  },
};
