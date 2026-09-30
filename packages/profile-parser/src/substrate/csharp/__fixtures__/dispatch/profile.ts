import type { CSharpProfile } from '../../../../types/csharp-profile.js';
export const profile: CSharpProfile = {
  parserId: 'compiled-dispatch-fixture',
  substrate: { language: 'csharp', include: ['**/*.cs'] },
  libraries: [
    { projectSdk: 'Microsoft.NET.Sdk.Web', types: ['Microsoft.Extensions.DependencyInjection.IServiceCollection'] },
  ],
  nominal: {
    bindings: [
      {
        receiverTypes: ['Microsoft.Extensions.DependencyInjection.IServiceCollection'],
        methods: ['AddSingleton'],
        serviceTypeArgument: 0,
        implementationTypeArgument: 1,
      },
    ],
  },
};
