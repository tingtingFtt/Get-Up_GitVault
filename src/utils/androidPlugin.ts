import {registerPlugin} from '@capacitor/core';
// One registration shared by file exports, secure storage and managed directories.
export const androidPlugin=registerPlugin<Record<string,(options?:any)=>Promise<any>>>('GitVaultNative');
