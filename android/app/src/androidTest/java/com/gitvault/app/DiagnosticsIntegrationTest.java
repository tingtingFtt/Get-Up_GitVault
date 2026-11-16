package com.gitvault.app;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.json.*;
import java.util.concurrent.atomic.*;
import static org.junit.Assert.*;
@RunWith(AndroidJUnit4.class)
public class DiagnosticsIntegrationTest {
 private void ready(ActivityScenario<MainActivity> scenario)throws Exception{AtomicBoolean ready=new AtomicBoolean();for(int i=0;i<150&&!ready.get();i++){scenario.onActivity(activity->activity.getBridge().getWebView().evaluateJavascript("Boolean(document.querySelector('.app-header'))",value->ready.set("true".equals(value))));if(!ready.get())Thread.sleep(100);}assertTrue("Page did not recover",ready.get());}
 @Test public void realBridgePersistsTaskPhaseAndExportsStartupVersionWithoutCredentials()throws Exception{
  try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)){
   ready(scenario);AtomicReference<String> result=new AtomicReference<>("pending");
   String script="(async()=>{try{const p=window.Capacitor.Plugins.GitVaultDiagnostics;await p.checkpoint({entry:{kind:'phase',stage:'upload objects',project:'diagnostic-fixture',branch:'dev',status:'running',message:'Bearer private-secret ghp_hidden123',payload:'source-code-must-not-be-recorded'}});const report=await p.report();if(report.lastTask.project!=='diagnostic-fixture'||report.lastTask.branch!=='dev')throw Error('task lost');const text=JSON.stringify(report);if(text.includes('private-secret')||text.includes('ghp_hidden123')||text.includes('source-code-must-not-be-recorded'))throw Error('unredacted payload');if(!report.versionName||!Array.isArray(report.exitInfo))throw Error('missing system context');window.__diagnosticResult='ok';}catch(error){window.__diagnosticResult='error: '+error.message;}})()";
   scenario.onActivity(activity->activity.getBridge().getWebView().evaluateJavascript(script,null));for(int i=0;i<100&&result.get().equals("pending");i++){scenario.onActivity(activity->activity.getBridge().getWebView().evaluateJavascript("window.__diagnosticResult||'pending'",value->result.set(value==null?"pending":value.replace("\"",""))));if(result.get().equals("pending"))Thread.sleep(100);}assertEquals("ok",result.get());
  }
 }
 @Test public void terminatedRendererShowsNativeRecoveryInsteadOfAWhiteScreenAndCanRestart()throws Exception{
  if(android.os.Build.VERSION.SDK_INT<26)return;
  try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)){
   ready(scenario);AtomicBoolean recovered=new AtomicBoolean();
   scenario.onActivity(activity->{android.webkit.WebView view=activity.getBridge().getWebView();boolean handled=view.getWebViewClient().onRenderProcessGone(view,new android.webkit.RenderProcessGoneDetail(){public boolean didCrash(){return false;}public int rendererPriorityAtExit(){return android.webkit.WebView.RENDERER_PRIORITY_IMPORTANT;}});assertTrue(handled);android.view.ViewGroup root=activity.findViewById(android.R.id.content);android.widget.Button restart=find(root,"重新打开");assertNotNull("Native recovery controls missing",restart);assertNotNull(find(root,"导出诊断报告"));restart.performClick();recovered.set(true);});
   assertTrue(recovered.get());ready(scenario);
  }
 }
 private android.widget.Button find(android.view.View view,String label){if(view instanceof android.widget.Button&&((android.widget.Button)view).getText().toString().equals(label))return (android.widget.Button)view;if(view instanceof android.view.ViewGroup){android.view.ViewGroup group=(android.view.ViewGroup)view;for(int i=0;i<group.getChildCount();i++){android.widget.Button found=find(group.getChildAt(i),label);if(found!=null)return found;}}return null;}
}
