/**
 * @coredoc/core/base-parser
 *
 * SDK package registry shared by the profile-parser substrate. Parsers are
 * profile-driven (see @coredoc/profile-parser).
 */

export {
  SDK_PACKAGES,
  lookupSdkByPackage,
  type SdkPackage,
  type SdkPackageMatch,
  type SdkProtocol,
} from './sdk-registry.js';
