import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.gitvault.app',
  appName: 'GitVault',
  webDir: 'dist',
  server: { androidScheme: 'https', errorPath: 'webview-error.html' },
  android: { allowMixedContent: false, minWebViewVersion: 119 },
  // MainActivity owns the native content viewport, including keyboard insets.
  // Capacitor's default SystemBars decorator would otherwise add IME padding again.
  plugins: { SystemBars: { insetsHandling: 'disable' } },
};
export default config;
