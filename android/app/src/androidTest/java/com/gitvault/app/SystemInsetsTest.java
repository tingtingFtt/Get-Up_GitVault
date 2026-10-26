package com.gitvault.app;

import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.os.ParcelFileDescriptor;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowCompat;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.InputStream;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import android.webkit.WebView;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Tests the actual native WebView frame; HTML/WebView padding cannot satisfy these checks. */
@RunWith(AndroidJUnit4.class)
public class SystemInsetsTest {
    @Test public void actualWebViewStagesAndReleasesBinaryChunksWithoutAnyRemoteWrite()throws Exception{
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)){
            waitForPage(scenario);AtomicReference<String> result=new AtomicReference<>("pending");
            String script="(async()=>{const git=window.Capacitor.Plugins.GitVaultGit,id=crypto.randomUUID();try{const bytes=new Uint8Array(1024*1024+7);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;const prefix=new TextEncoder().encode('blob '+bytes.length+'\\0'),input=new Uint8Array(prefix.length+bytes.length);input.set(prefix);input.set(bytes,prefix.length);const sha=[...new Uint8Array(await crypto.subtle.digest('SHA-1',input))].map(x=>x.toString(16).padStart(2,'0')).join('');await git.prepareUpload({id,totalBytes:bytes.length,expectedRepoId:77,retainObjects:false});for(let offset=0;offset<bytes.length;offset+=393216){const part=bytes.subarray(offset,offset+393216);let text='';for(let at=0;at<part.length;at+=8192)text+=String.fromCharCode(...part.subarray(at,at+8192));await git.appendChunk({id,path:'资源/binary.bin',mode:'100755',sha,offset,content:btoa(text),done:offset+part.length===bytes.length});}await git.release({id});let rejected=false;try{await git.appendChunk({id});}catch{rejected=true;}if(!rejected)throw Error('Released staging remained accessible');window.__gitChunkResult='ok';}catch(error){window.__gitChunkResult='error: '+error.message;}finally{await git.release({id});}})()";
            scenario.onActivity(activity->activity.getBridge().getWebView().evaluateJavascript(script,null));
            for(int attempt=0;attempt<150&&result.get().equals("pending");attempt++){
                scenario.onActivity(activity->activity.getBridge().getWebView().evaluateJavascript("window.__gitChunkResult||'pending'",value->result.set(value==null?"pending":value.replace("\"",""))));
                if(result.get().equals("pending"))Thread.sleep(100);
            }
            assertEquals("Actual JavaScript/Capacitor/disk chunk transfer failed","ok",result.get());
        }
    }
    @Test public void largeEncryptedProjectRecordsReloadWithoutAWebViewStorageMirror() throws Exception {
        android.content.Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        android.content.SharedPreferences preferences = context.getSharedPreferences("gitvault_secure", 0);
        String originalData = preferences.getString("data", null), originalIv = preferences.getString("iv", null);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            waitForPage(scenario);
            AtomicReference<String> result = new AtomicReference<>("pending");
            String script = "(async()=>{try{const native=window.Capacitor.Plugins.GitVaultNative,project={id:'large-record-test',owner:'fixture',repo:'records',url:'https://github.com/fixture/records',branch:'main',remark:'large-record-test',tags:[],checkInterval:0,latestCommitSha:'fixture',commitMessage:'fixture',commitAuthor:'fixture',commitDate:'2026-10-26',lastSyncedAt:'2026-10-26',repoMeta:{},tree:[],backups:[],isCachePurged:true,retainedData:'x'.repeat(6*1024*1024)};localStorage.setItem('gitvault_repos_v8',JSON.stringify([{id:'stale-mirror'}]));await native.writeVault({value:JSON.stringify({gitvault_repos_v8:JSON.stringify([project])})});const saved=JSON.parse((await native.readVault()).value);if(JSON.parse(saved.gitvault_repos_v8)[0].retainedData.length!==6*1024*1024)throw Error('Large record changed');window.__recordsResult='ok';}catch(error){window.__recordsResult='error: '+error.message;}})()";
            scenario.onActivity(activity -> activity.getBridge().getWebView().evaluateJavascript(script, null));
            for (int attempt=0; attempt<400 && result.get().equals("pending"); attempt++) {
                scenario.onActivity(activity -> activity.getBridge().getWebView().evaluateJavascript("window.__recordsResult||'pending'", value -> result.set(value == null ? "pending" : value.replace("\"", ""))));
                if (result.get().equals("pending")) Thread.sleep(100);
            }
            assertEquals("Large encrypted metadata did not round trip through the native bridge", "ok", result.get());
            scenario.recreate();
            waitForPage(scenario);
            result.set("pending");
            scenario.onActivity(activity -> activity.getBridge().getWebView().evaluateJavascript("localStorage.getItem('gitvault_repos_v8')===null&&document.body.textContent.includes('large-record-test')", result::set));
            for (int attempt=0; attempt<100 && result.get().equals("pending"); attempt++) Thread.sleep(100);
            assertEquals("Startup must load the encrypted project and remove the stale WebView mirror", "true", result.get());
        } finally {
            android.content.SharedPreferences.Editor restore = preferences.edit().clear();
            if (originalData != null) restore.putString("data", originalData);
            if (originalIv != null) restore.putString("iv", originalIv);
            assertTrue("Restore original encrypted test data", restore.commit());
        }
    }

    private void waitForPage(ActivityScenario<MainActivity> scenario) throws Exception {
        AtomicBoolean ready = new AtomicBoolean(false);
        for (int attempt = 0; attempt < 100 && !ready.get(); attempt++) {
            scenario.onActivity(activity -> activity.getBridge().getWebView().evaluateJavascript("Boolean(document.querySelector('.app-header'))", value -> ready.set("true".equals(value))));
            if (!ready.get()) Thread.sleep(100);
        }
        assertTrue("Bundled page did not finish loading", ready.get());
        ready.set(false);
        scenario.onActivity(activity -> activity.getBridge().getWebView().postVisualStateCallback(0, new WebView.VisualStateCallback() {
            @Override public void onComplete(long requestId) { ready.set(true); }
        }));
        for (int attempt = 0; attempt < 100 && !ready.get(); attempt++) Thread.sleep(100);
        assertTrue("WebView did not paint its loaded page", ready.get());
    }
    private void waitForOrientation(ActivityScenario<MainActivity> scenario, int orientation) throws Exception {
        AtomicBoolean ready = new AtomicBoolean(false);
        for (int attempt = 0; attempt < 100 && !ready.get(); attempt++) {
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            scenario.onActivity(activity -> ready.set(activity.getResources().getConfiguration().orientation == orientation
                && activity.getBridge().getWebView().getHeight() > 0
                && (orientation == Configuration.ORIENTATION_LANDSCAPE
                    ? activity.getWindow().getDecorView().getWidth() > activity.getWindow().getDecorView().getHeight()
                    : activity.getWindow().getDecorView().getWidth() < activity.getWindow().getDecorView().getHeight())
                && ViewCompat.getRootWindowInsets(activity.findViewById(android.R.id.content)) != null));
            if (!ready.get()) Thread.sleep(100);
        }
        assertTrue("Activity did not finish its orientation/insets layout", ready.get());
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
    }

    private void assertSafeViewport(MainActivity activity) {
        View web = activity.getBridge().getWebView(), decor = activity.getWindow().getDecorView();
        WindowInsetsCompat window = ViewCompat.getRootWindowInsets(decor);
        assertNotNull(window);
        Insets safe = window.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
        int[] position = new int[2], origin = new int[2];
        web.getLocationOnScreen(position); decor.getLocationOnScreen(origin);
        assertTrue("WebView must start below the status/caption bar", position[1] >= origin[1] + safe.top);
        assertTrue("WebView overlaps left cutout", position[0] >= origin[0] + safe.left);
        assertTrue("WebView overlaps right cutout", position[0] + web.getWidth() <= origin[0] + decor.getWidth() - safe.right);
        assertTrue("Bottom controls overlap the system navigation bar", position[1] + web.getHeight() <= origin[1] + decor.getHeight() - safe.bottom);
        assertEquals("Insets belong to the parent, not HTML/WebView padding", 0, web.getPaddingTop());
        assertEquals("Capacitor must not apply the same insets to DecorView again", 0, decor.getPaddingBottom());
        assertTrue("The page must remain usable", web.getWidth() > 100 && web.getHeight() > 100);
    }

    private void screenshot(String name) throws Exception {
        // Gradle uninstalls the target after tests, removing its app directories.
        // Shell-owned captures remain available for CI to collect afterwards.
        ParcelFileDescriptor command = InstrumentationRegistry.getInstrumentation().getUiAutomation()
            .executeShellCommand("screencap -p /data/local/tmp/gitvault-" + name + ".png");
        try (InputStream output = new ParcelFileDescriptor.AutoCloseInputStream(command)) {
            byte[] buffer = new byte[1024];
            while (output.read(buffer) != -1) { /* Wait for screencap to finish. */ }
        }
    }

    private void waitForKeyboard(ActivityScenario<MainActivity> scenario, boolean visible) throws Exception {
        AtomicBoolean ready = new AtomicBoolean(false);
        AtomicReference<String> diagnostic = new AtomicReference<>("");
        for (int attempt = 0; attempt < 100 && !ready.get(); attempt++) {
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            scenario.onActivity(activity -> {
                View decor = activity.getWindow().getDecorView(), web = activity.getBridge().getWebView();
                WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(decor);
                Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
                int bottom = Math.max(bars.bottom, insets.getInsets(WindowInsetsCompat.Type.ime()).bottom);
                diagnostic.set("ime=" + insets.isVisible(WindowInsetsCompat.Type.ime()) + ", web=" + web.getHeight() + ", decor=" + decor.getHeight() + ", top=" + bars.top + ", bottom=" + bottom + ", decorPadding=" + decor.getPaddingBottom());
                ready.set(insets.isVisible(WindowInsetsCompat.Type.ime()) == visible
                    && web.getHeight() == decor.getHeight() - bars.top - bottom);
            });
            if (!ready.get()) Thread.sleep(100);
        }
        assertTrue("Real keyboard and WebView viewport did not finish resizing: " + diagnostic.get(), ready.get());
    }

    @Test public void portraitAndLandscapeKeepWebContentOutsideSystemBars() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT));
            waitForOrientation(scenario, Configuration.ORIENTATION_PORTRAIT);
            waitForPage(scenario);
            scenario.onActivity(this::assertSafeViewport); screenshot("insets-portrait");
            scenario.onActivity(activity -> activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE));
            waitForOrientation(scenario, Configuration.ORIENTATION_LANDSCAPE);
            waitForPage(scenario);
            scenario.onActivity(this::assertSafeViewport); screenshot("insets-landscape");
        }
    }

    @Test public void keyboardInsetsResizeTheViewportOnceWithoutLosingStatusBarSpace() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT));
            waitForOrientation(scenario, Configuration.ORIENTATION_PORTRAIT);
            waitForPage(scenario);
            AtomicInteger originalHeight = new AtomicInteger();
            scenario.onActivity(activity -> {
                FrameLayout content = activity.findViewById(android.R.id.content);
                originalHeight.set(activity.getBridge().getWebView().getHeight());
                EditText editor = new EditText(activity);
                editor.setTag("insets-keyboard-editor"); editor.setSingleLine(true);
                content.addView(editor, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
                editor.requestFocus();
                editor.post(() -> WindowCompat.getInsetsController(activity.getWindow(), editor).show(WindowInsetsCompat.Type.ime()));
            });
            waitForKeyboard(scenario, true);
            scenario.onActivity(activity -> {
                assertSafeViewport(activity);
                View content = activity.findViewById(android.R.id.content);
                WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(activity.getWindow().getDecorView());
                assertEquals("Do not add navigation and keyboard heights twice", insets.getInsets(WindowInsetsCompat.Type.ime()).bottom, content.getPaddingBottom());
                assertTrue(activity.getBridge().getWebView().getHeight() < originalHeight.get());
                assertEquals(Configuration.ORIENTATION_PORTRAIT, activity.getResources().getConfiguration().orientation);
            });
            screenshot("insets-keyboard");
            scenario.onActivity(activity -> {
                FrameLayout content = activity.findViewById(android.R.id.content);
                WindowCompat.getInsetsController(activity.getWindow(), content).hide(WindowInsetsCompat.Type.ime());
                content.removeView(content.findViewWithTag("insets-keyboard-editor"));
            });
            waitForKeyboard(scenario, false);
            scenario.onActivity(activity -> assertEquals("Closing the keyboard restores the viewport", originalHeight.get(), activity.getBridge().getWebView().getHeight()));
        }
    }
}
