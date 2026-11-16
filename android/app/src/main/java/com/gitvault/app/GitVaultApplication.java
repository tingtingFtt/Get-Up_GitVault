package com.gitvault.app;
public class GitVaultApplication extends android.app.Application {
    @Override public void onCreate(){super.onCreate();CrashDiagnostics.install(this);}
}
