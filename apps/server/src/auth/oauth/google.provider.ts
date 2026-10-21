/**
 * Google upstream provider for the self-hosted OAuth server.
 *
 * Same login-gate posture as the GitHub provider: any Google account can
 * authenticate, so an empty ALLOWED_EMAIL_DOMAINS is a boot error, and only a
 * Google-verified email passes — it feeds invite linking in
 * `linkPendingMemberships`, where an unverified address could hijack an invite.
 */

import { Logger } from '@nestjs/common';
import { GoogleOAuthProvider, type OAuthProviderConfig, type OAuthUserProfile } from '@rekog/mcp-nest';
import { emailDomain, parseCsv } from './provider-utils.js';
import { type AuthConfig, configFromEnv } from '../../config/app-config.js';

const gateLogger = new Logger('GoogleLoginGate');

interface GoogleProfile {
  id?: string;
  emails?: Array<{ value?: string; verified?: boolean }>;
}

export function buildGoogleProvider(auth: AuthConfig = configFromEnv().auth): OAuthProviderConfig {
  const allowedDomains = parseCsv(auth.allowedEmailDomains);
  if (allowedDomains.length === 0) {
    throw new Error('Login gate is empty: set ALLOWED_EMAIL_DOMAINS (comma-separated, e.g. "example.com").');
  }

  return {
    ...GoogleOAuthProvider,
    displayName: 'Google',
    profileMapper: (profile: GoogleProfile): OAuthUserProfile => {
      const { value: email = '', verified } = profile.emails?.[0] ?? {};
      const id = String(profile.id ?? 'unknown');

      if (verified !== true || !email) {
        gateLogger.warn(`Login denied for "${id}": email=${email || '(none)'} email_verified=${String(verified)}`);
        throw new Error(`Google user "${id}" has no verified email`);
      }
      if (!allowedDomains.includes(emailDomain(email.toLowerCase()))) {
        gateLogger.warn(
          `Login denied for "${id}": verifiedEmail=${email} | gate domains=[${allowedDomains.join(',')}]`,
        );
        throw new Error(`Google user "${id}" is not in an allowed email domain`);
      }

      // The SDK's mapper uses the email's local part as username; the full
      // address stays unambiguous next to GitHub logins.
      return { ...GoogleOAuthProvider.profileMapper(profile), username: email, email };
    },
  };
}
