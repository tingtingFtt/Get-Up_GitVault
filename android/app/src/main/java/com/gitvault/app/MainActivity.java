package com.gitvault.app;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;
import android.graphics.Color;
import android.view.View;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.graphics.Insets;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GitVaultDiagnosticsPlugin.class);
        registerPlugin(GitVaultNativePlugin.class);
        registerPlugin(GitVaultGitPlugin.class);
        registerPlugin(AppUpdaterPlugin.class);
        super.onCreate(savedInstanceState);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        View content = findViewById(android.R.id.content);
        content.setBackgroundColor(Color.rgb(248,246,241));
        getBridge().getWebView().setBackgroundColor(Color.rgb(248,246,241));
        getBridge().setWebViewClient(new com.getcapacitor.BridgeWebViewClient(getBridge()){
            @Override public void onPageFinished(android.webkit.WebView view,String url){super.onPageFinished(view,url);CrashDiagnostics.event("native-startup",new org.json.JSONObject());}
            @android.annotation.TargetApi(26)
            @Override public boolean onRenderProcessGone(android.webkit.WebView view,android.webkit.RenderProcessGoneDetail detail){
                org.json.JSONObject data=new org.json.JSONObject();try{data.put("didCrash",detail.didCrash()).put("rendererPriority",detail.rendererPriorityAtExit());}catch(Exception ignored){}CrashDiagnostics.event("webview-renderer-exit",data);
                try{((GitVaultGitPlugin)getBridge().getPlugin("GitVaultGit").getInstance()).requestStopAll();}catch(Exception ignored){}
                try{((GitVaultNativePlugin)getBridge().getPlugin("GitVaultNative").getInstance()).requestStopAll();}catch(Exception ignored){}
                if(view.getParent() instanceof android.view.ViewGroup)((android.view.ViewGroup)view.getParent()).removeView(view);view.destroy();
                android.widget.LinearLayout panel=new android.widget.LinearLayout(MainActivity.this);panel.setOrientation(android.widget.LinearLayout.VERTICAL);panel.setPadding(32,32,32,32);panel.setBackgroundColor(Color.rgb(248,246,241));
                android.widget.TextView message=new android.widget.TextView(MainActivity.this);message.setText("界面渲染进程已退出。已请求停止传输，本地项目和已完成结果保留。请导出诊断后重新打开。");panel.addView(message);
                android.widget.Button export=new android.widget.Button(MainActivity.this);export.setText("导出诊断报告");export.setOnClickListener(button->CrashDiagnostics.share(MainActivity.this));panel.addView(export);
                android.widget.Button restart=new android.widget.Button(MainActivity.this);restart.setText("重新打开");restart.setOnClickListener(button->recreate());panel.addView(restart);
                ((android.view.ViewGroup)content).addView(panel,new android.view.ViewGroup.LayoutParams(-1,-1));return true;
            }
        });
        WindowCompat.getInsetsController(getWindow(), content).setAppearanceLightStatusBars(true);
        WindowCompat.getInsetsController(getWindow(), content).setAppearanceLightNavigationBars(true);
        // WebView padding does not move its HTML viewport or fixed/sticky elements.
        // Inset the native parent instead, so every page and dialog shares one safe viewport.
        ViewCompat.setOnApplyWindowInsetsListener(content, (view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets keyboard = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard.bottom));
            // The parent already applied these insets; do not apply them again in the WebView.
            return WindowInsetsCompat.CONSUMED;
        });
        ViewCompat.requestApplyInsets(content);
    }
}
