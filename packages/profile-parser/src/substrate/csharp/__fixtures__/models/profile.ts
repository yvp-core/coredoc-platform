import type { CSharpProfile } from '../../../../types/csharp-profile.js';
export const profile: CSharpProfile = {
  parserId: 'compiled-models-fixture',
  substrate: { language: 'csharp', include: ['**/*.cs'] },
  libraries: [
    {
      dependency: 'Microsoft.EntityFrameworkCore.Relational',
      types: [
        'Microsoft.EntityFrameworkCore.DbContext',
        'Microsoft.EntityFrameworkCore.DbSet`1',
        'Microsoft.EntityFrameworkCore.ModelBuilder',
        'Microsoft.EntityFrameworkCore.Metadata.Builders.EntityTypeBuilder`1',
      ],
    },
    { projectSdk: 'Microsoft.NET.Sdk', types: ['System.ComponentModel.DataAnnotations.Schema.TableAttribute'] },
  ],
  nominal: {
    models: [
      {
        contextTypes: ['Microsoft.EntityFrameworkCore.DbContext'],
        setTypes: ['Microsoft.EntityFrameworkCore.DbSet`1'],
        setMethods: ['Set'],
        orm: 'ef-core',
        tableAttributes: ['System.ComponentModel.DataAnnotations.Schema.TableAttribute'],
        operations: { Add: 'create', ToListAsync: 'read' },
        chainMethods: ['Where'],
        fluent: {
          builderTypes: ['Microsoft.EntityFrameworkCore.ModelBuilder'],
          entityBuilderTypes: ['Microsoft.EntityFrameworkCore.Metadata.Builders.EntityTypeBuilder`1'],
          entityCallbackArg: 0,
          methods: {
            Entity: 'entity',
            ToTable: 'table',
            Property: 'property',
            HasColumnName: 'column',
            HasColumnType: 'columnType',
            HasKey: 'key',
            Ignore: 'ignore',
            HasOne: 'reference',
            WithMany: 'inverseCollection',
            HasForeignKey: 'foreignKey',
          },
        },
      },
    ],
  },
};
