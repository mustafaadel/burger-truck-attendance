// Digital Asset Links: tells Android that the APK in android/ is allowed to open this site
// full-screen (no address bar). The fingerprint is the PUBLIC part of the app's signing key.
export const ANDROID_PACKAGE = 'com.mustafaadel.burgertruck';
export const ANDROID_CERT_SHA256 = [
  '86:C0:66:98:64:AE:7C:F0:A8:79:78:C4:B3:25:38:5F:26:8B:11:78:3F:4E:57:1B:5D:68:41:65:47:9A:21:CB',
];

export const assetLinks = [{
  relation: ['delegate_permission/common.handle_all_urls'],
  target: { namespace: 'android_app', package_name: ANDROID_PACKAGE, sha256_cert_fingerprints: ANDROID_CERT_SHA256 },
}];
