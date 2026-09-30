/**
 * Back-compat alias for {@link UserSessionGuard}.
 *
 * The guard admits a session cookie as readily as a JWT — what it actually
 * enforces is "a user session, never a service token" — so the canonical name
 * lives in `user-session.guard.ts`. This alias keeps the existing
 * `@UseGuards(JwtOnlyGuard)` call sites (delivery, capture, agent-runs,
 * telemetry-token) pointing at the SAME class; there is deliberately no second
 * implementation to drift.
 *
 * @deprecated Import `UserSessionGuard` from `./user-session.guard.js`.
 */
export { UserSessionGuard as JwtOnlyGuard } from './user-session.guard.js';
