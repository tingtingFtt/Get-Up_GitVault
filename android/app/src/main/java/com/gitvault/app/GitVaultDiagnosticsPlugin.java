package com.gitvault.app;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
@CapacitorPlugin(name="GitVaultDiagnostics")
public class GitVaultDiagnosticsPlugin extends Plugin {
    @PluginMethod public void checkpoint(PluginCall call){CrashDiagnostics.IO.execute(()->{try{JSObject entry=call.getObject("entry");if(entry!=null)CrashDiagnostics.checkpoint(entry);call.resolve();}catch(Exception error){call.reject("诊断记录保存失败",error);}});}
    @PluginMethod public void report(PluginCall call){CrashDiagnostics.IO.execute(()->{try{call.resolve(JSObject.fromJSONObject(CrashDiagnostics.report()));}catch(Exception error){call.reject("诊断报告生成失败",error);}});}
    @PluginMethod public void pulse(PluginCall call){CrashDiagnostics.pulse(call.getBoolean("visible",false));call.resolve();}
}
