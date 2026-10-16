package com.gitvault.app;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.graphics.Insets;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GitVaultNativePlugin.class);
        super.onCreate(savedInstanceState);
        ViewCompat.setOnApplyWindowInsetsListener(getBridge().getWebView(), (view, windowInsets) -> {
            Insets insets = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            view.setPadding(insets.left, insets.top, insets.right, insets.bottom);
            return windowInsets;
        });
        ViewCompat.requestApplyInsets(getBridge().getWebView());
    }
}
