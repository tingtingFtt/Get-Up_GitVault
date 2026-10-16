import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.gitvault.app',
  appName: 'GitVault',
  webDir: 'dist',
  server: { androidScheme: 'https', errorPath: 'webview-error.html' },
  android: { allowMixedContent: false, minWebViewVersion: 119 },
};
export default config;
