/** Portable managed release; the compatible SDK is installed separately. */
export const SCIP_DOTNET_RELEASE = {
  version: '0.2.15-coredoc.1',
  url: 'https://github.com/yvp-core/scip-dotnet/releases/download/0.2.15-coredoc.1/scip-dotnet-0.2.15-coredoc.1-net10.0.tar.gz',
  sha256: '1ed60c52134515fc72b81fa06846bd75dda343bb22db223dd1a09ee2b4ec7ba5',
  // SHA-256 of sorted relative paths + NUL + file bytes + NUL in the verified archive.
  contentsSha256: '265c56c2cbc7fd6d3708be830a5cfdc854d6ba4f9a086925bd43f0d2ac1c746a',
  sdkMajor: 10,
} as const;
