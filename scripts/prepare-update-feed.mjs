import {mkdir,writeFile} from 'node:fs/promises';
const response=await fetch('https://api.github.com/repos/tingtingFtt/Get-Up_GitVault/releases?per_page=30',{headers:{Accept:'application/vnd.github+json',...(process.env.GH_TOKEN?{Authorization:`Bearer ${process.env.GH_TOKEN}`}:{})}});
if(!response.ok)throw new Error(`Cannot read published APK channels: HTTP ${response.status}`);
const releases=await response.json();await mkdir('dist/android',{recursive:true});
for(const channel of ['debug','release']){
 const release=releases.filter(item=>!item.draft&&/^android-v\d+\.\d+\.\d+$/.test(item.tag_name)).sort((a,b)=>new Date(b.published_at)-new Date(a.published_at)).find(item=>item.assets.some(asset=>asset.name===`latest-${channel}.json`));
 if(!release){console.log(`No fixed-signature ${channel} channel published`);continue;}
 const asset=release.assets.find(item=>item.name===`latest-${channel}.json`),apk=release.assets.find(item=>item.name===`GitVault-${channel}.apk`);
 if(!apk)throw new Error('Missing APK asset');
 const data=await fetch(asset.browser_download_url);if(!data.ok)throw new Error('Cannot download APK manifest');const manifest=await data.json();
 if(manifest.url!==apk.browser_download_url||manifest.size!==apk.size||!Number.isSafeInteger(manifest.versionCode)||manifest.versionCode<=0||!/^\d+\.\d+\.\d+$/.test(manifest.versionName)||!/^https:\/\/github\.com\/tingtingFtt\/Get-Up_GitVault\/releases\/download\//.test(manifest.url)||manifest.packageId!=='com.gitvault.app'+(channel==='debug'?'.debug':'')||!/^([a-f0-9]{64})$/.test(manifest.sha256)||apk.digest&&apk.digest!==`sha256:${manifest.sha256}`)throw new Error('Invalid APK manifest');
 await writeFile(`dist/android/latest-${channel}.json`,JSON.stringify(manifest)+'\n');console.log(`Included ${channel} update ${manifest.versionName}`);
}
