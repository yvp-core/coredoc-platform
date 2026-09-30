import type { CSharpProfile } from '../../../../types/csharp-profile.js';
const http = {
  via: 'methods' as const,
  receiverTypes: ['System.Net.Http.HttpClient'],
  sdkName: 'http',
  methods: { GetStringAsync: { verb: 'GET' as const, pathArg: 0 }, GetAsync: { verb: 'GET' as const, pathArg: 0 } },
};
const factory = { receiverTypes: ['System.Net.Http.IHttpClientFactory'], methods: ['CreateClient'], nameArg: 0 };
export const profile: CSharpProfile = {
  parserId: 'compiled-egress-fixture',
  substrate: { language: 'csharp', include: ['**/*.cs'] },
  libraries: [
    {
      projectSdk: 'Microsoft.NET.Sdk.Web',
      types: ['System.Net.Http.HttpClient', 'System.Net.Http.IHttpClientFactory'],
      members: { 'System.Net.Http.IHttpClientFactory': { methods: { CreateClient: 'System.Net.Http.HttpClient' } } },
    },
    { dependency: 'Refit', types: ['Refit.GetAttribute'] },
  ],
  nominal: {
    externalCalls: [
      {
        ...http,
        factory: { ...factory, name: 'first' },
        serviceName: 'first',
        baseAddress: 'https://first.example/v1/',
      },
      {
        ...http,
        factory: { ...factory, name: 'second' },
        serviceName: 'second',
        baseAddress: 'https://second.example/v2/',
      },
      {
        via: 'methods',
        receiverTypes: ['Demo.Gateway'],
        methods: { Publish: {} },
        serviceName: 'gateway',
        sdkName: 'neutral-sdk',
      },
      {
        via: 'attributes',
        receiverTypes: ['Example.IRemoteApi', 'Example.ILocalApi'],
        verbAttributes: { 'Refit.GetAttribute': 'GET' },
        pathArg: 0,
        serviceName: 'remote',
        sdkName: 'Refit',
        baseAddress: 'https://remote.example/',
      },
    ],
  },
};
