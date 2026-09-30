export const TELEMETRY_UNAVAILABLE_MESSAGE =
  'Telemetry provisioning is unavailable in the legacy coredoc plugin. Use Coredoc Desktop managed-relay provisioning.';

export async function provisionTelemetry() {
  return { outcome: 'unavailable', message: TELEMETRY_UNAVAILABLE_MESSAGE };
}
