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
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Tests the actual native WebView frame; HTML/WebView padding cannot satisfy these checks. */
@RunWith(AndroidJUnit4.class)
public class SystemInsetsTest {
    private void waitForPage(ActivityScenario<MainActivity> scenario) throws Exception {
        AtomicBoolean ready = new AtomicBoolean(false);
        for (int attempt = 0; attempt < 100 && !ready.get(); attempt++) {
            scenario.onActivity(activity -> activity.getBridge().getWebView().evaluateJavascript("Boolean(document.querySelector('.app-header'))", value -> ready.set("true".equals(value))));
            if (!ready.get()) Thread.sleep(100);
        }
        assertTrue("Bundled page did not finish loading", ready.get());
    }
    private void waitForOrientation(ActivityScenario<MainActivity> scenario, int orientation) throws Exception {
        AtomicBoolean ready = new AtomicBoolean(false);
        for (int attempt = 0; attempt < 100 && !ready.get(); attempt++) {
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            scenario.onActivity(activity -> ready.set(activity.getResources().getConfiguration().orientation == orientation
                && activity.getBridge().getWebView().getHeight() > 0
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
        for (int attempt = 0; attempt < 100 && !ready.get(); attempt++) {
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            scenario.onActivity(activity -> {
                View decor = activity.getWindow().getDecorView(), web = activity.getBridge().getWebView();
                WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(decor);
                Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
                int bottom = Math.max(bars.bottom, insets.getInsets(WindowInsetsCompat.Type.ime()).bottom);
                ready.set(insets.isVisible(WindowInsetsCompat.Type.ime()) == visible
                    && web.getHeight() == decor.getHeight() - bars.top - bottom);
            });
            if (!ready.get()) Thread.sleep(100);
        }
        assertTrue("Real keyboard and WebView viewport did not finish resizing", ready.get());
    }

    @Test public void portraitAndLandscapeKeepWebContentOutsideSystemBars() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT));
            waitForOrientation(scenario, Configuration.ORIENTATION_PORTRAIT);
            waitForPage(scenario);
            scenario.onActivity(this::assertSafeViewport); screenshot("insets-portrait");
            scenario.onActivity(activity -> activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE));
            waitForOrientation(scenario, Configuration.ORIENTATION_LANDSCAPE);
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
